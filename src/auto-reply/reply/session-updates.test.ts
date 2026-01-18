import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../../infra/system-events.js";
import { prependSystemEvents } from "./session-updates.js";

describe("prependSystemEvents", () => {
  it("adds a UTC timestamp to queued system events", async () => {
    vi.useFakeTimers();
    const timestamp = new Date(Date.UTC(2026, 0, 12, 20, 19, 17));
    vi.setSystemTime(timestamp);

    enqueueSystemEvent("Model switched.", { sessionKey: "agent:main:main" });

    const result = await prependSystemEvents({
      cfg: {} as ClawdbotConfig,
      sessionKey: "agent:main:main",
      isMainSession: false,
      isNewSession: false,
      prefixedBodyBase: "User: hi",
    });

    const expectedTimestamp = timestamp.toISOString().replace(".000Z", "Z");

    expect(result).toContain(`System: [${expectedTimestamp}] Model switched.`);

    resetSystemEventsForTest();
    vi.useRealTimers();
  });
});
