// How a project NAME lands on one of the user's projects, in one place: the
// voice tools (lib/secretary/tools.ts resolveProject) resolve "file it under
// Caltrans" with it, and the understanding validator (lib/understanding/
// validate.ts) refuses a set_project write with it, so a name the validator
// lets through is a name the apply path will find. Pure: no database, so the
// validator stays mechanical.

/** Lowercase, punctuation and runs of whitespace to one space, trimmed. */
export function normalizeProjectName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ProjectNameMatch = {
  /** Index into the `names` handed in. */
  index: number;
  matched: "exact" | "normalized" | "fuzzy";
};

/**
 * "Find It" must land in "Find It app", never spawn a duplicate. Exact
 * (case-insensitive) → normalized (punctuation/whitespace-blind) → containment
 * either way, the candidate closest in length winning. Normalized and fuzzy
 * matching need three characters, so "IT" cannot land on "Find It app".
 */
export function matchProjectName(name: string, names: readonly string[]): ProjectNameMatch | null {
  const lower = name.toLowerCase();
  const exact = names.findIndex((n) => n.toLowerCase() === lower);
  if (exact !== -1) return { index: exact, matched: "exact" };

  const norm = normalizeProjectName(name);
  if (norm.length < 3) return null;
  const normalized = names.findIndex((n) => normalizeProjectName(n) === norm);
  if (normalized !== -1) return { index: normalized, matched: "normalized" };

  const candidates = names
    .map((n, index) => ({ index, pn: normalizeProjectName(n) }))
    .filter(({ pn }) => pn.length >= 3 && (pn.includes(norm) || norm.includes(pn)));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => Math.abs(a.pn.length - norm.length) - Math.abs(b.pn.length - norm.length));
  return { index: candidates[0].index, matched: "fuzzy" };
}
