// A slip of one or two characters in an id the model copied, mended before
// validation.
//
// The ids the model cites are 36-character UUIDs, copied by hand from the
// bracketed ids in the bundle (SPEC §3). Since the output schema stopped
// being enforced by the API (run.ts OUTPUT_FORMAT_TEXT), a Sonnet 5 answer
// now and then carries a UUID with one hex digit wrong, and the validator
// rightly refuses it as unknown; on 2026-09-23 the first production run of
// Caltrans spent all three attempts on that. The fix here is narrow: an id
// that is unknown, but is within two characters of exactly ONE known id of
// its type and the same length, is that id. Two other UUIDs differ in about
// twenty-seven characters, so a two-character neighbour is never ambiguous
// in practice, and an id that matches nothing that closely is left for the
// validator to refuse. Every repair is reported so the run's log says so.
import { SOURCE_TYPES, type Bundle, type SourceType } from "./types";
import { idIndex } from "./validate";

/** How many characters may differ for an unknown id to count as a slip. */
export const MAX_SLIP = 2;

export type Repair = { path: string; type: SourceType; from: string; to: string };

/** The characters that differ between two strings of one length; Infinity for different lengths. */
function slip(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length && n <= MAX_SLIP; i++) if (a[i] !== b[i]) n++;
  return n;
}

/** The one known id of this type within MAX_SLIP of `id`, or null when none or several. */
export function nearestId(id: string, known: Set<string>): string | null {
  if (known.has(id)) return id;
  // A stray character the model carried in with the id: on 2026-09-23 a run
  // was refused for `unknown message id "6ae41b15-...-1eb6317f1918}"`, one
  // brace too many, which no same-length comparison can mend. Ids are hex
  // and dashes, so anything else at either end is not part of one.
  const trimmed = id.replace(/^[^0-9A-Za-z]+/, "").replace(/[^0-9A-Za-z]+$/, "");
  if (trimmed !== id && known.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  let hit: string | null = null;
  for (const candidate of known) {
    if (slip(lower, candidate.toLowerCase()) > MAX_SLIP) continue;
    if (hit !== null) return null;
    hit = candidate;
  }
  if (hit !== null) return hit;
  // A dropped dash or a UUID cut short: on 2026-09-25 Caltrans spent three
  // attempts twice over on memory ids like "da6ff733-c9ba-419e-bd5b43ac…"
  // (one dash gone) and "b47d3561-883c-4a80-9908-376f70580" (cut off). No
  // same-length slip reaches those. Compared as hex alone, an id whose first
  // PREFIX_HEX digits are those of exactly one known id is that id: sixteen
  // hex digits are 64 bits, which two real UUIDs never share by chance.
  const hex = (v: string) => v.toLowerCase().replace(/[^0-9a-f]/g, "");
  const head = hex(trimmed).slice(0, PREFIX_HEX);
  if (head.length < PREFIX_HEX) return null;
  for (const candidate of known) {
    if (!hex(candidate).startsWith(head)) continue;
    if (hit !== null) return null;
    hit = candidate;
  }
  return hit;
}

/** How many leading hex digits identify a UUID the model cut short or mis-dashed. */
const PREFIX_HEX = 16;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isSourceType = (v: unknown): v is SourceType =>
  typeof v === "string" && (SOURCE_TYPES as readonly string[]).includes(v);

/**
 * Walk the model's output (after toRunOutput) and mend every id it cites:
 * a source's `id` under its `type`, a write's `taskId` or `expectationId`.
 * Returns a copy with the repairs applied and the list of them; the input
 * is not touched. Anything that is not an id is left exactly as it was.
 */
export function repairIds(output: unknown, bundle: Bundle): { output: unknown; repairs: Repair[] } {
  const known = idIndex(bundle);
  const repairs: Repair[] = [];

  const mend = (type: SourceType, id: unknown, path: string): unknown => {
    if (typeof id !== "string" || known[type].has(id)) return id;
    const to = nearestId(id, known[type]);
    if (to === null) return id;
    repairs.push({ path, type, from: id, to });
    return to;
  };

  const walk = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`));
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = walk(value, path ? `${path}.${key}` : key);
    // A source: { type, id }.
    if (isSourceType(out.type) && typeof out.id === "string") out.id = mend(out.type, out.id, `${path}.id`);
    // A write: { op, taskId } or { op, expectationId }.
    if (typeof out.op === "string") {
      if (typeof out.taskId === "string") out.taskId = mend("task", out.taskId, `${path}.taskId`);
      if (typeof out.expectationId === "string") {
        out.expectationId = mend("expectation", out.expectationId, `${path}.expectationId`);
      }
    }
    return out;
  };

  return { output: walk(output, ""), repairs };
}

/** One log line per repair: what was copied wrong, and what it was. */
export function repairLine(r: Repair): string {
  return `${r.path}: ${r.type} id "${r.from}" read as "${r.to}"`;
}
