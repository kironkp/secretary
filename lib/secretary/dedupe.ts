// Fuzzy matching for the extraction pass (Flow 2): an inferred item must never
// duplicate a row the realtime model already logged mid-call. Pure functions —
// tests/extraction-dedupe.test.ts exercises them without a database or model.

const STOPWORDS = new Set([
  "a", "an", "the", "to", "for", "of", "on", "in", "at", "my", "your", "our",
  "and", "or", "with", "about", "up", "out", "that", "this", "it", "do", "get",
]);

/** Lowercase, strip punctuation, drop stopwords → the tokens that carry meaning. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Dice coefficient over meaningful tokens: 0 (disjoint) … 1 (identical). */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.length === 0 || tb.length === 0) {
    return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  }
  const setB = new Set(tb);
  const overlap = ta.filter((t) => setB.has(t)).length;
  return (2 * overlap) / (ta.length + tb.length);
}

const SIMILAR = 0.6;
/** Same-date tolerance: due dates within ±1 day count as "the same deadline". */
const DATE_TOLERANCE_MS = 36 * 60 * 60 * 1000;

function datesMatch(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return true; // a missing date never disqualifies a title match
  return Math.abs(a.getTime() - b.getTime()) <= DATE_TOLERANCE_MS;
}

export type DedupeCandidate = { title: string; dueAt?: Date | null };

/**
 * Is `candidate` already represented in `existing`? Title similarity ≥
 * `minScore` (default 0.6 — extraction's net) and (if both sides have one) a
 * due date within ~a day. Returns the matched row so callers can target it.
 * Live create-guards pass a stricter minScore so genuinely distinct-but-
 * similar tasks aren't blocked.
 */
export function findDuplicate<T extends DedupeCandidate>(
  candidate: DedupeCandidate,
  existing: T[],
  minScore: number = SIMILAR
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const row of existing) {
    const score = titleSimilarity(candidate.title, row.title);
    if (score >= minScore && datesMatch(candidate.dueAt, row.dueAt) && score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

export type EventCandidate = { title: string; startsAt: Date };

/** Events dedupe on similar title + start within the same-day tolerance. */
export function findDuplicateEvent<T extends EventCandidate>(
  candidate: EventCandidate,
  existing: T[],
  minScore: number = SIMILAR
): T | null {
  let best: T | null = null;
  let bestScore = 0;
  for (const row of existing) {
    const score = titleSimilarity(candidate.title, row.title);
    if (
      score >= minScore &&
      Math.abs(candidate.startsAt.getTime() - row.startsAt.getTime()) <= DATE_TOLERANCE_MS &&
      score > bestScore
    ) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}
