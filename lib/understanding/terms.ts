// Mention terms — the pure text half of docs/understanding/SPEC.md §3.
//
// Memories and messages have no project link, so the only way a project's
// bundle can find "I finished everything else that reconciling that CPO" is
// by the words in it. The terms come from what the project already has:
// its name, the things its previous record knows, and the numbers and proper
// nouns in its task titles. Kept apart from gather.ts so validate.ts (pure,
// no database) can reuse the same tokenizer and stoplist for §4 step 5.
import type { ProjectRecord } from "./types";

/**
 * Capitalized words that start task titles but name nothing. A title
 * "Process CPO 2073" must yield the term CPO and the number, never "Process".
 * Compared lowercased.
 */
export const STOPLIST: ReadonlySet<string> = new Set(
  [
    "The", "This", "That", "With", "From", "After", "Before", "Send", "Get", "Do",
    "Make", "Check", "Update", "Create", "Process", "Convert", "Confirm", "Draft",
    "Submit", "Follow", "Test", "Set", "Add", "Run", "Prepare", "Review", "Ask",
    "Compile", "Monitor", "Upload", "Archive", "Complete", "Choose", "Record",
    "Schedule", "Start", "Finish", "Connect", "Resubmit",
  ].map((w) => w.toLowerCase())
);

// "Word boundary" here means not glued to another letter or digit. \b would
// also treat "-" and "." as boundaries, which is right, but it misbehaves at
// the edges of a term that itself starts or ends with punctuation (an alias
// like "Prod. monitor"), so the boundary is spelled out.
const NOT_ALNUM_BEFORE = "(?<![A-Za-z0-9])";
const NOT_ALNUM_AFTER = "(?![A-Za-z0-9])";

/** Runs of 3+ digits standing alone: 2073, 0394, 2027. */
const DIGIT_TOKEN = new RegExp(`${NOT_ALNUM_BEFORE}\\d{3,}${NOT_ALNUM_AFTER}`, "g");
/** A capitalized word of 3+ letters: Caltrans, CPO, Marissa. */
const CAPITALIZED_TOKEN = new RegExp(`${NOT_ALNUM_BEFORE}[A-Z][A-Za-z]{2,}${NOT_ALNUM_AFTER}`, "g");

export function digitTokens(text: string): string[] {
  return text.match(DIGIT_TOKEN) ?? [];
}

/** Capitalized 3+-letter words, minus the stoplist. Keeps the original spelling. */
export function capitalizedTokens(text: string): string[] {
  return (text.match(CAPITALIZED_TOKEN) ?? []).filter((w) => !STOPLIST.has(w.toLowerCase()));
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Dedupe case-insensitively, keeping first spelling and first-seen order. */
export function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = raw.trim();
    if (t.length < 2) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * A term as a pattern: its alphanumeric runs, in order, with any punctuation
 * or whitespace between them. This is resolveProject's "normalized" match
 * (lib/project-names.ts normalizeProjectName: lowercase, punctuation to
 * space) applied to prose, so "Find It app" finds "find-it app" and
 * "Prod. monitor" finds "prod monitor" (SPEC §3). A term with no
 * alphanumeric run at all matches nothing.
 */
function termPattern(term: string): string | null {
  const runs = term.match(/[A-Za-z0-9]+/g);
  if (!runs) return null;
  return runs.map(escapeRegExp).join("[^A-Za-z0-9]+");
}

/**
 * One compiled matcher for a term list: case-insensitive, punctuation-blind
 * inside a term, on word boundaries at its edges. Compiled once because it
 * runs over every user message of the last 30 days.
 */
export function termMatcher(terms: string[]): (text: string) => boolean {
  const patterns = uniqueTerms(terms)
    .map(termPattern)
    .filter((p): p is string => p !== null);
  if (patterns.length === 0) return () => false;
  const re = new RegExp(`${NOT_ALNUM_BEFORE}(?:${patterns.join("|")})${NOT_ALNUM_AFTER}`, "i");
  return (text) => re.test(text);
}

/**
 * The terms one project's bundle matches memories and messages on (SPEC §3).
 *
 * Numbers are taken from task notes as well as titles. The spec's own example
 * is why: the done CPO 2073 task carries "new number is 0394" only in its
 * notes, and on the FIRST run there is no previous record whose things[].ids
 * could carry 0394 yet. Notes are the only place the new number lives until
 * the record exists. Capitalized words are NOT taken from notes: notes are
 * prose, and every sentence-starter in them would become a term.
 */
export function extractTerms(input: {
  projectName: string;
  previousRecord: ProjectRecord | null;
  titles: string[];
  notes: string[];
}): string[] {
  const terms: string[] = [input.projectName];

  for (const thing of input.previousRecord?.things ?? []) {
    terms.push(thing.name, ...thing.aliases, ...thing.ids);
  }

  for (const title of input.titles) {
    terms.push(...digitTokens(title));
  }
  for (const note of input.notes) {
    terms.push(...digitTokens(note));
  }
  for (const text of [...input.titles, input.projectName]) {
    terms.push(...capitalizedTokens(text));
  }

  return uniqueTerms(terms);
}
