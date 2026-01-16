import type { HumanDelayConfig } from "../../config/types.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import type { ResponsePrefixContext } from "./response-prefix-template.js";
import type { TypingController } from "./typing.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

type ReplyDispatchErrorHandler = (err: unknown, info: { kind: ReplyDispatchKind }) => void;

type ReplyDispatchDeliverer = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind },
) => Promise<void>;

const DEFAULT_HUMAN_DELAY_MIN_MS = 800;
const DEFAULT_HUMAN_DELAY_MAX_MS = 2500;

/** Generate a random delay within the configured range. */
function getHumanDelay(config: HumanDelayConfig | undefined): number {
  const mode = config?.mode ?? "off";
  if (mode === "off") return 0;
  const min =
    mode === "custom" ? (config?.minMs ?? DEFAULT_HUMAN_DELAY_MIN_MS) : DEFAULT_HUMAN_DELAY_MIN_MS;
  const max =
    mode === "custom" ? (config?.maxMs ?? DEFAULT_HUMAN_DELAY_MAX_MS) : DEFAULT_HUMAN_DELAY_MAX_MS;
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Sleep for a given number of milliseconds. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type ReplyDispatcherOptions = {
  deliver: ReplyDispatchDeliverer;
  responsePrefix?: string;
  /** Static context for response prefix template interpolation. */
  responsePrefixContext?: ResponsePrefixContext;
  /** Dynamic context provider for response prefix template interpolation.
   * Called at normalization time, after model selection is complete. */
  responsePrefixContextProvider?: () => ResponsePrefixContext;
  onHeartbeatStrip?: () => void;
  onIdle?: () => void;
  onError?: ReplyDispatchErrorHandler;
  /** Human-like delay between block replies for natural rhythm. */
  humanDelay?: HumanDelayConfig;
  /** Fire-and-forget mode: deliver messages in parallel without chaining. */
  parallel?: boolean;
};

export type ReplyDispatcherWithTypingOptions = Omit<ReplyDispatcherOptions, "onIdle"> & {
  onReplyStart?: () => Promise<void> | void;
  onIdle?: () => void;
  /** Custom handler for tool results (edit-in-place progress messages). */
  deliverToolResult?: (payload: ReplyPayload) => Promise<void> | void;
};

type ReplyDispatcherWithTypingResult = {
  dispatcher: ReplyDispatcher;
  replyOptions: Pick<GetReplyOptions, "onReplyStart" | "onTypingController">;
  markDispatchIdle: () => void;
  /** Custom tool result handler if provided in options. */
  deliverToolResult?: (payload: ReplyPayload) => Promise<void> | void;
};

export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
};

function normalizeReplyPayloadInternal(
  payload: ReplyPayload,
  opts: Pick<
    ReplyDispatcherOptions,
    | "responsePrefix"
    | "responsePrefixContext"
    | "responsePrefixContextProvider"
    | "onHeartbeatStrip"
  >,
): ReplyPayload | null {
  // Prefer dynamic context provider over static context
  const prefixContext = opts.responsePrefixContextProvider?.() ?? opts.responsePrefixContext;

  return normalizeReplyPayload(payload, {
    responsePrefix: opts.responsePrefix,
    responsePrefixContext: prefixContext,
    onHeartbeatStrip: opts.onHeartbeatStrip,
  });
}

export function createReplyDispatcher(options: ReplyDispatcherOptions): ReplyDispatcher {
  let sendChain: Promise<void> = Promise.resolve();
  // Track all in-flight promises for parallel mode waitForIdle.
  const inFlightPromises: Promise<void>[] = [];
  // Track in-flight deliveries so we can emit a reliable "idle" signal.
  let pending = 0;
  // Track whether we've sent a block reply (for human delay - skip delay on first block).
  let sentFirstBlock = false;
  // Serialize outbound replies to preserve tool/block/final order.
  const queuedCounts: Record<ReplyDispatchKind, number> = {
    tool: 0,
    block: 0,
    final: 0,
  };

  const enqueue = (kind: ReplyDispatchKind, payload: ReplyPayload) => {
    const normalized = normalizeReplyPayloadInternal(payload, options);
    if (!normalized) return false;
    queuedCounts[kind] += 1;
    pending += 1;

    // Determine if we should add human-like delay (only for block replies after the first).
    const shouldDelay = kind === "block" && sentFirstBlock && !options.parallel;
    if (kind === "block") sentFirstBlock = true;

    const deliverPromise = (async () => {
      // Add human-like delay between block replies for natural rhythm (sequential mode only).
      if (shouldDelay) {
        const delayMs = getHumanDelay(options.humanDelay);
        if (delayMs > 0) await sleep(delayMs);
      }
      await options.deliver(normalized, { kind });
    })();

    const wrappedPromise = deliverPromise
      .catch((err) => {
        options.onError?.(err, { kind });
      })
      .finally(() => {
        pending -= 1;
        if (pending === 0) {
          options.onIdle?.();
        }
      });

    if (options.parallel) {
      // Fire-and-forget mode: track promise for waitForIdle but don't chain.
      inFlightPromises.push(wrappedPromise);
    } else {
      // Sequential mode: chain deliveries to preserve order.
      sendChain = sendChain.then(() => wrappedPromise);
    }
    return true;
  };

  const waitForIdle = async () => {
    if (options.parallel) {
      // Wait for all in-flight promises to settle.
      await Promise.all(inFlightPromises);
    } else {
      await sendChain;
    }
  };

  return {
    sendToolResult: (payload) => enqueue("tool", payload),
    sendBlockReply: (payload) => enqueue("block", payload),
    sendFinalReply: (payload) => enqueue("final", payload),
    waitForIdle,
    getQueuedCounts: () => ({ ...queuedCounts }),
  };
}

export function createReplyDispatcherWithTyping(
  options: ReplyDispatcherWithTypingOptions,
): ReplyDispatcherWithTypingResult {
  const { onReplyStart, onIdle, deliverToolResult, ...dispatcherOptions } =
    options;
  let typingController: TypingController | undefined;
  const dispatcher = createReplyDispatcher({
    ...dispatcherOptions,
    onIdle: () => {
      typingController?.markDispatchIdle();
      onIdle?.();
    },
  });

  // Wrap deliverToolResult to apply normalization (responsePrefix, etc.)
  const wrappedDeliverToolResult = deliverToolResult
    ? (payload: ReplyPayload) => {
        const normalized = normalizeReplyPayload(payload, {
          responsePrefix: dispatcherOptions.responsePrefix,
        });
        if (normalized) {
          return deliverToolResult(normalized);
        }
      }
    : undefined;

  return {
    dispatcher,
    replyOptions: {
      onReplyStart,
      onTypingController: (typing) => {
        typingController = typing;
      },
    },
    markDispatchIdle: () => {
      typingController?.markDispatchIdle();
      onIdle?.();
    },
    deliverToolResult: wrappedDeliverToolResult,
  };
}
