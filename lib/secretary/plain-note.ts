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
  "source",
] as const;

const plurals = (word: string) => [word, `${word}s`, `${word}es`, ...(word.endsWith("y") ? [`${word.slice(0, -1)}ies`] : [])];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest first, so "status of record" is read before "status".
const LABEL = new RegExp(
  `^(?:${NOTE_LABELS.flatMap(plurals)
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join("|")})\\s*:`
);

/** A line as the check reads it: no leading bullets or numbers, no markdown emphasis, lower case, one kind of colon. */
function asRead(line: string): string {
  let s = line.replace(/[*_`]/g, "").replace(/[：—–=]/g, ":").toLowerCase().trim();
  // Bullets and numbering, however many: "- ", "• ", "1. ", "2) ", "(3) ", "a. ", "> ".
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^(?:[-+•·◦▪‣>]|\(?\d{1,3}[.)]|\(?[a-z][.)](?=\s))\s*/, "");
  }
  return s;
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
