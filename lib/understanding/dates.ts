// Dates, not countdowns (SEC-A004, 2026-10-06). A run's words are kept until
// the project is read again, which since v0.28 is when its data changes or a
// dated item crosses a line, not every day. "Due in 3 days" written on Monday
// is wrong on Tuesday; "due Thu, Oct 22" is right every day, and the app
// shows how far off a date is from the date itself. The prompt asks for
// dates; this turns any countdown the model writes anyway in the on-screen
// words into its date, from the run's own clock, before the output is
// checked and stored.
// "Today" and "tomorrow" stay: a project is re-read when they turn over.
import type { Bundle } from "./types";

const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const N = String.raw`(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
const UNIT = String.raw`(days?|weeks?)`;

const count = (n: string, unit: string) => (WORDS[n.toLowerCase()] ?? Number(n)) * (/^week/i.test(unit) ? 7 : 1);

/** The countdowns this rewrites; also what a test checks stored words against. */
export const COUNTDOWN = new RegExp(
  String.raw`\bin ${N} ${UNIT}\b|\b${N} ${UNIT} (?:late|overdue|ago|left|to go|away)\b`,
  "i"
);

/** "Thu, Oct 22" for the day `days` from the clock's local date. */
function dayLabel(clock: Bundle["clock"], days: number): string {
  const [y, m, d] = clock.localDate.split("-").map(Number);
  // Noon UTC on that calendar day: the label is the date, whatever the zone.
  const at = new Date(Date.UTC(y, m - 1, d + days, 12));
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(at);
}

/** One string with its countdowns turned into dates; `changed` counts them. */
export function absoluteDates(text: string, clock: Bundle["clock"]): { text: string; changed: number } {
  let changed = 0;
  const out = text
    .replace(new RegExp(String.raw`\bin ${N} ${UNIT}\b`, "gi"), (_m, n: string, unit: string) => {
      changed++;
      return `on ${dayLabel(clock, count(n, unit))}`;
    })
    .replace(new RegExp(String.raw`\b${N} ${UNIT} (late|overdue)\b`, "gi"), (_m, n: string, unit: string) => {
      changed++;
      return `overdue since ${dayLabel(clock, -count(n, unit))}`;
    })
    .replace(new RegExp(String.raw`\b${N} ${UNIT} ago\b`, "gi"), (_m, n: string, unit: string) => {
      changed++;
      return `on ${dayLabel(clock, -count(n, unit))}`;
    })
    .replace(new RegExp(String.raw`\b${N} ${UNIT} (?:left|to go|away)\b`, "gi"), (_m, n: string, unit: string) => {
      changed++;
      return `until ${dayLabel(clock, count(n, unit))}`;
    });
  return { text: out, changed };
}

/**
 * The words that go stale on screen, countdowns made dates: words.todayLine,
 * every lede, and each question's one-line question. Not the record: a
 * rule's "arrive in 30 days" is a duration, not a countdown, and a quote must
 * stay exactly what its source says. Not a question's why either: it must
 * name its evidence (validate.ts referencesEvidence, by a four-word run or a
 * number it shares), and rewriting a countdown it quotes could turn a good
 * answer into a rejected one, and a paid retry. Those are left to the
 * prompt (review finding R1 on v0.28).
 */
export function datedOutput(output: unknown, clock: Bundle["clock"]): { output: unknown; changed: number } {
  let changed = 0;
  const fix = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    const r = absoluteDates(v, clock);
    changed += r.changed;
    return r.text;
  };
  if (!output || typeof output !== "object") return { output, changed };
  const out = { ...(output as Record<string, unknown>) };
  const words = out.words;
  if (words && typeof words === "object") {
    const w = { ...(words as Record<string, unknown>) };
    if ("todayLine" in w) w.todayLine = fix(w.todayLine);
    if (w.ledes && typeof w.ledes === "object" && !Array.isArray(w.ledes)) {
      w.ledes = Object.fromEntries(Object.entries(w.ledes as Record<string, unknown>).map(([k, v]) => [k, fix(v)]));
    }
    out.words = w;
  }
  if (Array.isArray(out.questions)) {
    out.questions = out.questions.map((q) =>
      q && typeof q === "object" ? { ...(q as Record<string, unknown>), question: fix((q as { question?: unknown }).question) } : q
    );
  }
  return { output: out, changed };
}
