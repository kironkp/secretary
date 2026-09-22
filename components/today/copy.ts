// The words on the Today surface — docs/understanding/SPEC.md §6, §9.
//
// Pure: no React, no fetch, no wall clock. Every sentence a question card or an
// answer receipt shows is composed here, so the honesty rule (§10: "closed" is
// said only for writes that returned success) is one function with a test,
// not a template scattered across two views. Days are digits (§7).
import type { QuestionKind, Write } from "@/lib/understanding/types";

export type KindLabel = "Need to know" | "Doesn't add up" | "Done yet?";

/** The three kinds as the mockup labels them (SPEC §5). */
export const KIND_LABEL: Record<QuestionKind, KindLabel> = {
  need_to_know: "Need to know",
  doesnt_add_up: "Doesn't add up",
  done_yet: "Done yet?",
};

/** Token classes from app/globals.css; the mockup's purple, orange and tint. */
export const KIND_CLASS: Record<QuestionKind, string> = {
  need_to_know: "text-grape",
  doesnt_add_up: "text-warn",
  done_yet: "text-accent",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as QuestionKind] ?? "Question";
}

export function kindClass(kind: string): string {
  return KIND_CLASS[kind as QuestionKind] ?? "text-muted";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "a, b and c" — the way the persona joins a list, no Oxford comma. */
function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

type OpCounts = Partial<Record<Write["op"], number>>;

function countOps(writes: { op: string }[]): OpCounts {
  const counts: OpCounts = {};
  for (const w of writes) {
    const op = w.op as Write["op"];
    counts[op] = (counts[op] ?? 0) + 1;
  }
  return counts;
}

/**
 * What an answer WILL write, said before the user gives it (SPEC §9: "one
 * sentence per answer saying what it will write"). `resolve` is the question
 * closing itself and is never a change, so an answer that only resolves
 * "leaves everything as it is".
 */
export function writesInWords(writes: { op: string }[]): string {
  const c = countOps(writes);
  const parts: string[] = [];
  if (c.complete_task) parts.push(`marks ${plural(c.complete_task, "task", "tasks")} done`);
  if (c.drop_task) parts.push(`drops ${plural(c.drop_task, "task", "tasks")}`);
  if (c.set_due) parts.push(c.set_due === 1 ? "sets a date" : `sets ${c.set_due} dates`);
  if (c.set_recurrence) {
    parts.push(c.set_recurrence === 1 ? "makes it repeat" : `makes ${c.set_recurrence} tasks repeat`);
  }
  if (c.set_blocked_reason) {
    parts.push(
      c.set_blocked_reason === 1
        ? "records why it is stuck"
        : `records why ${c.set_blocked_reason} tasks are stuck`
    );
  }
  if (c.remember_fact) {
    parts.push(c.remember_fact === 1 ? "remembers a fact" : `remembers ${c.remember_fact} facts`);
  }
  if (c.clear_expectation) {
    parts.push(
      c.clear_expectation === 1 ? "clears a follow-up" : `clears ${c.clear_expectation} follow-ups`
    );
  }
  return parts.length ? joinWords(parts) : "leaves everything as it is";
}

/**
 * What an answer DID write, from the ops the API reports as applied (SPEC §6:
 * "The client says 'Closed' only for those"). Nothing applied is said plainly.
 */
export function appliedInWords(applied: { op: string }[]): string {
  const c = countOps(applied);
  const parts: string[] = [];
  if (c.complete_task) parts.push(`closed ${plural(c.complete_task, "task", "tasks")}`);
  if (c.drop_task) parts.push(`dropped ${plural(c.drop_task, "task", "tasks")}`);
  if (c.set_due) parts.push(c.set_due === 1 ? "set a date" : `set ${c.set_due} dates`);
  if (c.set_recurrence) {
    parts.push(c.set_recurrence === 1 ? "made it repeat" : `made ${c.set_recurrence} tasks repeat`);
  }
  if (c.set_blocked_reason) {
    parts.push(
      c.set_blocked_reason === 1
        ? "recorded why it is stuck"
        : `recorded why ${c.set_blocked_reason} tasks are stuck`
    );
  }
  if (c.remember_fact) {
    parts.push(c.remember_fact === 1 ? "remembered a fact" : `remembered ${c.remember_fact} facts`);
  }
  if (c.clear_expectation) {
    parts.push(
      c.clear_expectation === 1 ? "cleared a follow-up" : `cleared ${c.clear_expectation} follow-ups`
    );
  }
  if (parts.length === 0) return "Nothing changed";
  const sentence = joinWords(parts);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The writes that did not go through, with the API's reason for each. */
export function failedInWords(failed: { op: string; error: string }[]): string | null {
  if (failed.length === 0) return null;
  const reasons = [...new Set(failed.map((f) => f.error))].join("; ");
  return `${plural(failed.length, "write", "writes")} did not go through: ${reasons}`;
}

/**
 * The tasks binding formats a past-due date as "3d overdue"
 * (lib/workspace/bindings.ts formatDue). Today says it in words, digits kept:
 * "3 days late". Anything else comes back null and the caller shows the field.
 */
export function lateInWords(due: string): string | null {
  const m = /^(\d+)d overdue$/.exec(due.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return `${plural(n, "day", "days")} late`;
}

/** "Tuesday, 22 September" — the mockup's date line, in the user's own day. */
export function dateLine(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: timezone,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")}, ${get("day")} ${get("month")}`;
}

/** "Updated Tue 7:40 AM", or null when no record has been written yet. */
export function updatedLine(iso: string | null, timezone: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const when = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(at);
  return `Updated ${when}`;
}
