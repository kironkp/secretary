// v1.17 (docs/tasks/SPEC.md §1): a model write never loses his notes. A model's note is added a line at a time,
// in the database, in the same UPDATE that reads the row's own note; only an explicit replace (he asked) takes
// anything away. His own save keeps what was added while he typed (mergeNotes).
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** A model's note as the lines it would add: each without its trailing spaces, blank lines dropped, each once. */
export function noteLines(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim() && !out.includes(line)) out.push(line);
  }
  return out;
}

/** "The same title" (§1.3): equal once lowercased, trimmed and with its runs of spaces made one. */
export const sameTitle = (a: string, b: string) => {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
};

/**
 * SQL: the lines no line of the column already is (each compared without its trailing spaces), joined by newlines
 * in their order; NULL when every line is there. It reads the row's own value, so it goes in the UPDATE itself.
 */
export function addedLines(column: AnyPgColumn, lines: string[]): SQL {
  return sql`(select string_agg(x.l, E'\\n' order by x.i)
    from jsonb_array_elements_text(${JSON.stringify(lines)}::jsonb) with ordinality as x(l, i)
    where x.l <> all (select rtrim(h, E' \\t\\r') from unnest(string_to_array(coalesce(${column}, ''), E'\\n')) as h))`;
}

/** SQL for the column with those lines added after it on lines of their own; unchanged when they are all there. */
export function withLines(column: AnyPgColumn, lines: string[]): SQL {
  const added = addedLines(column, lines);
  return sql`(case when ${added} is null then ${column}
    when coalesce(${column}, '') = '' then ${added}
    else ${column} || E'\\n' || ${added} end)`;
}

/** The lines a write added: those of `lines` the note before did not have (§1.1's comparison). */
export function linesAdded(before: string | null, lines: string[]): string[] {
  const had = new Set((before ?? "").split("\n").map((l) => l.trimEnd()));
  return lines.filter((l) => !had.has(l));
}

/** What a result says about a note write: the lines added, or that they were all there already. */
export function noteOutcome(added: string[]): { notes_added: string[] } | { notes_already_there: true } {
  return added.length ? { notes_added: added } : { notes_already_there: true };
}

/**
 * His save (§1.6). `base` is the note as it was when he opened it (null: it was empty; undefined, from a page older
 * than v1.17: his own text stands in for it). What the stored note gained since the base, by a longest common subsequence of lines,
 * goes after his text, in its order, each line once, not when his text has it, blank lines not carried. His text
 * is kept exactly as sent; when nothing was added since, it is the whole note.
 */
export function mergeNotes(base: string | null | undefined, his: string | null, stored: string | null): string | null {
  const from = (base === undefined ? his : base) ?? "";
  const gained = sinceBase(from.split("\n"), (stored ?? "").split("\n"));
  const hisLines = new Set((his ?? "").split("\n").map((l) => l.trimEnd()));
  const keep: string[] = [];
  for (const line of gained) {
    const l = line.trimEnd();
    if (!l.trim() || hisLines.has(l) || keep.includes(l)) continue;
    keep.push(l);
  }
  if (!keep.length) return his;
  return his ? `${his}\n${keep.join("\n")}` : keep.join("\n");
}

/** The lines of `now` that are not in a longest common subsequence with `base`: what was added since, in order. */
function sinceBase(base: string[], now: string[]): string[] {
  const eq = (a: string, b: string) => a.trimEnd() === b.trimEnd();
  const m = base.length;
  const n = now.length;
  const len: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      len[i][j] = eq(base[i], now[j]) ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (j < n) {
    if (i < m && eq(base[i], now[j])) {
      i++;
      j++;
    } else if (i < m && len[i + 1][j] >= len[i][j + 1]) {
      i++;
    } else {
      out.push(now[j]);
      j++;
    }
  }
  return out;
}
