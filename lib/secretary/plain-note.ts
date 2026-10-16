// v1.10 (docs/tasks/SPEC.md §2.1): a task's note is plain words. The prompts say so; this is the one backstop,
// and it reads only the model's new text: never the stored note, his typing, recurrence's copy or his save's merge.

/** The words that, opening a line and followed by a colon, make it a field label. Plurals are read too. */
export const NOTE_LABELS = [
  "owner",
  "assignee",
  "depends on",
  "dependency",
  "effort",
  "next action",
  "next step",
  "evidence",
  "status",
  "status of record",
  "priority",
  "blocker",
  "blocked by",
  "waiting on",
  "deadline",
  "due",
  "due date",
  "source",
] as const;

/** Words read without a plural: "Dues: $40 a month" is a detail, not a label (v1.10 r2). */
const NO_PLURAL = new Set(["due"]);
const plurals = (word: string) =>
  NO_PLURAL.has(word) ? [word] : [word, `${word}s`, `${word}es`, ...(word.endsWith("y") ? [`${word.slice(0, -1)}ies`] : [])];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest first, so "status of record" is read before "status".
const LABEL = new RegExp(
  `^(?:${NOTE_LABELS.flatMap(plurals)
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|")})\\s*:`
);

/**
 * A line as the check reads it (v1.10 r2), in this order: its leading bullets, numbering, headings and checkboxes
 * gone first ("- ", "– ", "— ", "* ", "• ", "1. ", "## ", "- [ ] "), so a dash there is not read as a colon; then
 * no markdown emphasis, "_" a space, the dashes and "=" a colon, runs of spaces one, lower case.
 */
function asRead(line: string): string {
  let s = line.trim();
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^(?:[-–—*+•·◦▪‣>]|#{1,6}|\[[ xX]\]|\(?\d{1,3}[.)]|\(?[a-z][.)](?=\s))\s*/i, "");
  }
  return s
    .replace(/[*`]/g, "")
    .replace(/_/g, " ")
    .replace(/[：—–=]/g, ":")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

/**
 * The first line of `text` that reads as a field label ("Owner: Sam", "**Next action:** call"), as written; null
 * when every line is plain words. Lines are split on real newlines and on a literal "\n".
 */
export function plainNote(text: string | null | undefined): string | null {
  for (const line of (text ?? "").split(/\r?\n|\\n/)) {
    if (LABEL.test(asRead(line))) return line.trim();
  }
  return null;
}
