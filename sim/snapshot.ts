// Per-user DB snapshots + diffs — the ground truth the judge stands on.
// "Assistant claimed X" is checked against these, never against vibes.
import { eq } from "drizzle-orm";
import { schema, simDb } from "./db";

const TABLES = {
  tasks: schema.tasks,
  events: schema.events,
  projects: schema.projects,
  documents: schema.documents,
  documentVersions: schema.documentVersions,
  memories: schema.memories,
  checkins: schema.checkins,
  conversations: schema.conversations,
  messages: schema.messages,
} as const;

export type TableName = keyof typeof TABLES;

/** Volatile fields that change without semantic meaning — excluded from diffs. */
const IGNORED_FIELDS = new Set([
  "updatedAt",
  "procrastinationScore",
  "lastNudgedAt",
  "extractedAt",
  "lastResponseId",
]);

export type Row = Record<string, unknown> & { id: string };
export type Snapshot = Record<TableName, Map<string, Row>>;

export type FieldChange = { field: string; before: unknown; after: unknown };
export type TableDiff = {
  created: Row[];
  updated: { id: string; before: Row; after: Row; changed: FieldChange[] }[];
  deleted: Row[];
};
export type StateDiff = Record<TableName, TableDiff>;

function normalize(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export async function snapshotUser(userId: string): Promise<Snapshot> {
  const snap = {} as Snapshot;
  for (const [name, table] of Object.entries(TABLES)) {
    const rows = (await simDb
      .select()
      .from(table)
      .where(eq(table.userId, userId))) as Row[];
    snap[name as TableName] = new Map(rows.map((r) => [r.id, r]));
  }
  return snap;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): StateDiff {
  const out = {} as StateDiff;
  for (const name of Object.keys(TABLES) as TableName[]) {
    const b = before[name];
    const a = after[name];
    const d: TableDiff = { created: [], updated: [], deleted: [] };
    for (const [id, row] of a) {
      const prev = b.get(id);
      if (!prev) {
        d.created.push(row);
        continue;
      }
      const changed: FieldChange[] = [];
      for (const field of Object.keys(row)) {
        if (IGNORED_FIELDS.has(field)) continue;
        if (normalize(row[field]) !== normalize(prev[field])) {
          changed.push({ field, before: prev[field], after: row[field] });
        }
      }
      if (changed.length) d.updated.push({ id, before: prev, after: row, changed });
    }
    for (const [id, row] of b) if (!a.has(id)) d.deleted.push(row);
    out[name] = d;
  }
  return out;
}

export function diffIsEmpty(diff: StateDiff): boolean {
  return Object.values(diff).every(
    (d) => d.created.length === 0 && d.updated.length === 0 && d.deleted.length === 0
  );
}

/** Compact, JSON-safe rendering for bug-report evidence and the LLM judge.
 *  Includes final field values (due, reminders, sections word-counts) so the
 *  judge isn't blinded by create-then-edit collapsing into "created". */
export function compactDiff(diff: StateDiff): Record<string, unknown> {
  const rowSummary = (r: Row) => ({
    id: r.id,
    title: r.title ?? r.name ?? r.fact ?? (typeof r.content === "string" ? r.content.slice(0, 80) : undefined),
    ...(r.dueAt ? { due: normalizeDateish(r.dueAt) } : {}),
    ...(r.startsAt ? { starts: normalizeDateish(r.startsAt) } : {}),
    ...(r.status ? { status: r.status } : {}),
    ...(r.recurrence ? { recurrence: r.recurrence } : {}),
    ...(Array.isArray(r.reminders) && r.reminders.length
      ? { reminders: r.reminders.length }
      : {}),
    ...(Array.isArray(r.stages) && r.stages.length
      ? { stages: (r.stages as { name: string; done: boolean }[]).map((s) => `${s.name}${s.done ? "✓" : ""}`) }
      : {}),
    ...(Array.isArray(r.sections)
      ? {
          sections: (r.sections as { heading: string; content: string }[]).map(
            (s) => `${s.heading} (${s.content.split(/\s+/).filter(Boolean).length}w)`
          ),
        }
      : {}),
  });
  const out: Record<string, unknown> = {};
  for (const [table, d] of Object.entries(diff)) {
    if (!d.created.length && !d.updated.length && !d.deleted.length) continue;
    out[table] = {
      created: d.created.map(rowSummary),
      updated: d.updated.map((u) => ({
        ...rowSummary(u.after),
        changed: u.changed.map((c) => c.field),
      })),
      deleted: d.deleted.map((r) => ({ id: r.id, title: r.title ?? r.name })),
    };
  }
  return out;
}

function normalizeDateish(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
