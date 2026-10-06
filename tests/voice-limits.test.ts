// SEC-A004: a voice call hangs up after two quiet minutes and lasts at most
// thirty, saying so out loud first (lib/realtime/session-limits.ts). The
// session class asks nextLimitAction every five seconds; this drives it with
// a clock.
import { describe, expect, it } from "vitest";
import { IDLE_GOODBYE, IDLE_HANGUP_MS, MAX_CALL_MS, MAX_GOODBYE, nextLimitAction, WARN_AT_MS, type LimitState } from "@/lib/realtime/session-limits";

const MIN = 60_000;
const at = (minutes: number, over: Partial<LimitState> = {}): LimitState => ({
  startedAt: 1_000_000,
  lastActivityAt: 1_000_000 + minutes * MIN - 10_000,
  warned: false,
  busy: false,
  endingAt: null,
  now: 1_000_000 + minutes * MIN,
  ...over,
});

describe("voice call limits", () => {
  it("are two quiet minutes, a warning at 25 and a hard stop at 30", () => {
    expect(IDLE_HANGUP_MS).toBe(2 * MIN);
    expect(WARN_AT_MS).toBe(25 * MIN);
    expect(MAX_CALL_MS).toBe(30 * MIN);
  });

  it("a call with someone talking runs on", () => {
    expect(nextLimitAction(at(5))).toBeNull();
  });

  it("two minutes with nobody speaking: say goodbye, then hang up", () => {
    const quiet = at(10, { lastActivityAt: 1_000_000 + 8 * MIN });
    expect(nextLimitAction(quiet)).toBe("idle-goodbye");
    expect(nextLimitAction({ ...quiet, lastActivityAt: quiet.lastActivityAt + 1 })).toBeNull();
  });

  it("never cuts in while the secretary is speaking or a tool is running", () => {
    const quiet = at(10, { lastActivityAt: 1_000_000 + 7 * MIN });
    expect(nextLimitAction({ ...quiet, busy: true })).toBeNull();
    expect(nextLimitAction({ ...at(31), busy: true })).toBeNull();
  });

  it("at 25 minutes, one warning; at 30, goodbye", () => {
    expect(nextLimitAction(at(25))).toBe("warn");
    expect(nextLimitAction(at(26, { warned: true }))).toBeNull();
    expect(nextLimitAction(at(30, { warned: true }))).toBe("max-goodbye");
  });

  it("a goodbye already on its way is not said twice", () => {
    expect(nextLimitAction(at(31, { endingAt: 1_000_000 + 30 * MIN }))).toBeNull();
  });

  it("the goodbye is spoken, and says the call can start again", () => {
    expect(IDLE_GOODBYE).toContain("call me back anytime");
    expect(MAX_GOODBYE).toContain("30-minute limit");
  });
});
