import type { Bot } from "grammy";
import { logVerbose } from "../globals.js";
import { markdownToTelegramHtml } from "./format.js";

const PARSE_ERR_RE =
  /can't parse entities|parse entities|find end of the entity/i;

/**
 * Helper class for accumulating tool results into a single Telegram message
 * using edit-in-place. First tool result sends a new message, subsequent
 * results edit the same message to append content.
 */
export class TelegramToolProgressMessage {
  private messageId: number | null = null;
  private accumulatedText = "";

  constructor(
    private bot: Bot,
    private chatId: string,
    private threadId?: number,
  ) {}

  /**
   * Append text to the accumulated progress message.
   * First call sends a new message, subsequent calls edit the existing message.
   */
  async append(text: string): Promise<void> {
    if (!text.trim()) return;

    this.accumulatedText += (this.accumulatedText ? "\n" : "") + text;

    const threadParams =
      this.threadId != null ? { message_thread_id: this.threadId } : undefined;

    if (this.messageId === null) {
      // First tool result - send new message
      try {
        const htmlText = markdownToTelegramHtml(this.accumulatedText);
        const msg = await this.bot.api.sendMessage(this.chatId, htmlText, {
          parse_mode: "HTML",
          ...threadParams,
        });
        this.messageId = msg.message_id;
      } catch (err) {
        // Fallback to plain text on parse error
        if (PARSE_ERR_RE.test(String(err))) {
          logVerbose(
            `telegram tool progress HTML parse failed; retrying plain: ${String(err)}`,
          );
          const msg = await this.bot.api.sendMessage(
            this.chatId,
            this.accumulatedText,
            threadParams,
          );
          this.messageId = msg.message_id;
        } else {
          throw err;
        }
      }
    } else {
      // Subsequent - edit existing message
      try {
        const htmlText = markdownToTelegramHtml(this.accumulatedText);
        await this.bot.api.editMessageText(
          this.chatId,
          this.messageId,
          htmlText,
          { parse_mode: "HTML" },
        );
      } catch (err) {
        // Fallback to plain text on parse error
        if (PARSE_ERR_RE.test(String(err))) {
          logVerbose(
            `telegram tool progress edit HTML parse failed; retrying plain: ${String(err)}`,
          );
          await this.bot.api.editMessageText(
            this.chatId,
            this.messageId,
            this.accumulatedText,
          );
        } else {
          // Log but don't throw - editing can fail for various reasons (rate limits, etc.)
          logVerbose(`telegram tool progress edit failed: ${String(err)}`);
        }
      }
    }
  }

  /**
   * Get the message ID of the progress message, if one has been sent.
   */
  getMessageId(): number | null {
    return this.messageId;
  }

  /**
   * Get the accumulated text so far.
   */
  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  /**
   * Check if a progress message has been started.
   */
  hasStarted(): boolean {
    return this.messageId !== null;
  }
}
