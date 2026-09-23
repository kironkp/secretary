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

/** The ops, plus "unblock": a set_blocked_reason with an empty reason, which clears the blocker. */
type OpCounts = Partial<Record<Write["op"] | "unblock", number>>;

/** The least a write has to carry to be put into words: its op, for set_project the project's name, for set_blocked_reason the reason. */
type WordedWrite = { op: string; project?: string; reason?: string };

function countOps(writes: WordedWrite[]): OpCounts {
  const counts: OpCounts = {};
  for (const w of writes) {
    // A reason left out (a test's bare op) still reads as recording one;
    // only an explicit empty string is the unblock.
    const op =
      w.op === "set_blocked_reason" && w.reason !== undefined && w.reason.trim() === ""
        ? "unblock"
        : (w.op as Write["op"]);
    counts[op] = (counts[op] ?? 0) + 1;
  }
  return counts;
}

/**
 * " under Caltrans" when every set_project in the list names the same
 * project, nothing when they differ: "files 2 tasks" is true either way, and
 * a sentence naming two projects for two tasks would need to say which.
 */
function underProject(writes: WordedWrite[]): string {
  const names = new Set(
    writes.filter((w) => w.op === "set_project" && w.project).map((w) => w.project as string)
  );
  return names.size === 1 ? ` under ${[...names][0]}` : "";
}

/**
 * What an answer WILL write, said before the user gives it (SPEC §9: "one
 * sentence per answer saying what it will write"). `resolve` is the question
 * closing itself and is never a change, so an answer that only resolves
 * "leaves everything as it is".
 */
export function writesInWords(writes: WordedWrite[]): string {
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
  if (c.unblock) parts.push(c.unblock === 1 ? "unblocks it" : `unblocks ${c.unblock} tasks`);
  if (c.set_project) {
    const under = underProject(writes);
    parts.push(c.set_project === 1 ? `files it${under}` : `files ${c.set_project} tasks${under}`);
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
export function appliedInWords(applied: WordedWrite[]): string {
  const c = countOps(applied);
  const parts: string[] = [];
  if (c.complete_task) parts.push(`closed ${plural(c.complete_task, "task", "tasks")}`);
  if (c.drop_task) parts.push(`dropped ${plural(c.drop_task, "task", "tasks")}`);
  if (c.set_due) parts.push(c.set_due === 1 ? "set a date" : `set ${c.set_due} dates`);
  if (c.set_recurrence) {
    parts.push(c.set_recurrence === 1 ? "made it repeat" : `made ${c.set_recurrence} tasks repeat`);
  }
  if (c.unblock) parts.push(c.unblock === 1 ? "unblocked it" : `unblocked ${c.unblock} tasks`);
  if (c.set_blocked_reason) {
    parts.push(
      c.set_blocked_reason === 1
        ? "recorded why it is stuck"
        : `recorded why ${c.set_blocked_reason} tasks are stuck`
    );
  }
  if (c.set_project) {
    const under = underProject(applied);
    parts.push(c.set_project === 1 ? `filed it${under}` : `filed ${c.set_project} tasks${under}`);
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

/** A reply as one sentence: the model is asked for a full stop, and a missing one is added. */
const sentence = (s: string): string => (/[.!?…]$/u.test(s) ? s : `${s}.`);

/**
 * The receipt for an answer, tapped or written. A reply is what Secretary
 * read the words as, said back after "Got it.". The writes that went through
 * are still named after it (SPEC §10's honesty rule is about not claiming
 * more, and "Closed 2 tasks" is the confirmation the mockup drew), except a
 * memory alone, which the reply already stands for. Without a reply the
 * receipt is the writes. A write that did not go through is named either way.
 */
export function receiptInWords(body: {
  applied: WordedWrite[];
  failed: { op: string; error: string }[];
  reply?: string;
  /**
   * The other questions this answer set aside because it changed a row they
   * rested on (AnswerResult.superseded, SPEC §6 step 4): why a row just
   * left the list. Named only when there are any.
   */
  superseded?: string[];
}): string {
  const reply = body.reply?.trim();
  const acted = body.applied.some((w) => w.op !== "remember_fact" && w.op !== "resolve");
  // The model often opens its reply with an acknowledgement of its own, and
  // "Got it. Got it, I'll treat both of those…" is how that read on Today.
  // One acknowledgement, whichever of the two gets there first.
  const lead = reply && /^(got it|okay|ok|sure|understood|right)\b/i.test(reply) ? "" : "Got it. ";
  let said: string;
  if (!reply) said = appliedInWords(body.applied);
  else if (acted) said = `${lead}${sentence(reply)} ${appliedInWords(body.applied)}.`;
  else said = `${lead}${reply}`;
  // A reply ends in its own full stop; what was set aside, then a write
  // that did not go through, are sentences of their own after it.
  for (const more of [setAsideInWords(body.superseded?.length ?? 0), failedInWords(body.failed)]) {
    if (more) said = `${said.replace(/[.!]$/, "")}. ${more}`;
  }
  return said;
}

/**
 * The questions an answer set aside (SPEC §6 step 4), in the same words on
 * the screen and on a call (lib/secretary/tools.ts answer_question), or null
 * when there were none, so nothing is said.
 */
export function setAsideInWords(n: number): string | null {
  if (n <= 0) return null;
  return `${n} related question${n === 1 ? " was" : "s were"} set aside`;
}

/**
 * The line beside the thinking bars after an answer: what is being re-read.
 * "Reading Caltrans…" when the question knows its project, "Reading the
 * project…" when it does not; never a claim about what the reading found.
 */
export function readingLabel(projectName: string | null | undefined): string {
  const name = projectName?.trim();
  return name ? `Reading ${name}…` : "Reading the project…";
}

/**
 * How long ago a run finished, for the thinking strip's idle line ("2 new
 * questions, 12 min ago"). Digits, short units, never rounded up to a lie;
 * a stamp that does not parse says nothing.
 */
export function agoInWords(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour", "hours")} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * The tasks binding formats a past-due date as "3d overdue"
 * (lib/workspace/bindings.ts formatDue). Today says it in words, digits kept:
 * "3 days late". Anything else comes back null and the caller shows the field.
 */
export function lateInWords(due: string): string | null {
  const s = due.trim();
  // The binding layer already says "2 days late"; pass it through. The older
  // "2d overdue" form is still accepted so nothing cached mid-deploy breaks.
  if (/^\d+ days? late$/.test(s)) return s;
  const m = /^(\d+)d overdue$/.exec(s);
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
