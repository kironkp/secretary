// How long a voice call may run (SEC-A004, 2026-10-06). Voice is billed by
// the second of audio both ways, and a call left open on a quiet phone kept
// paying. Two lines, both said out loud before anything happens:
//
// - IDLE: nobody has spoken (no speech either side, no reply in flight) for
//   two minutes → "I'll hang up now — call me back anytime." and the call ends.
// - LENGTH: a call is at most 30 minutes; at 25 it says so once, at 30 it
//   says goodbye and ends.
//
// Pure: the session class (openai-webrtc.ts) asks it every few seconds and
// does what it says; the tests drive it with a clock.

export const IDLE_HANGUP_MS = 2 * 60_000;
export const MAX_CALL_MS = 30 * 60_000;
export const WARN_AT_MS = 25 * 60_000;

export const WARN_LINE = "Say in one short sentence that the call ends in about five minutes.";
export const IDLE_GOODBYE = `Say exactly this and nothing else: "I'll hang up now — call me back anytime."`;
export const MAX_GOODBYE = `Say exactly this and nothing else: "We're at the 30-minute limit, so I'll hang up now — call me back anytime."`;

export type LimitState = {
  /** When the call connected (ms). */
  startedAt: number;
  /** The last speech or reply, either side (ms). */
  lastActivityAt: number;
  /** The five-minute warning has been said. */
  warned: boolean;
  /** The secretary is speaking or a tool is running: never cut in. */
  busy: boolean;
  /** A goodbye is already on its way. */
  endingAt: number | null;
  now: number;
};

export type LimitAction = "warn" | "idle-goodbye" | "max-goodbye" | null;

export function nextLimitAction(s: LimitState): LimitAction {
  if (s.endingAt !== null || s.busy || !s.startedAt) return null;
  const length = s.now - s.startedAt;
  if (length >= MAX_CALL_MS) return "max-goodbye";
  if (s.now - s.lastActivityAt >= IDLE_HANGUP_MS) return "idle-goodbye";
  if (!s.warned && length >= WARN_AT_MS) return "warn";
  return null;
}
