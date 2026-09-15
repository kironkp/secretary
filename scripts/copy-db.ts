// Whole-database copy from one Postgres to another: every public table, rows
// inserted in foreign-key order, inside ONE transaction on the target. Written
// for the 2026-09-15 cutover (local → Heroku) and kept as the honest
// replacement for sync-to-heroku.mjs, which hardcoded 16 of 29 tables.
//
//   npx tsx --env-file=.env.local scripts/copy-db.ts --to <postgres-url> [--from <url>] [--yes]
//
// --from defaults to DATABASE_URL. Without --yes it is a rehearsal: it checks
// both schemas, prints the table order and source counts, and exits without
// writing. With --yes it TRUNCATEs every table on the target and copies. Any
// error, or a count mismatch, rolls the transaction back — the target is
// either fully replaced or untouched, never half-copied.
//
// No pg_dump on this machine (embedded-postgres ships only initdb/pg_ctl/
// postgres), hence a script instead of `heroku pg:push`. It is type-agnostic:
// every value is read as text and written back with an explicit cast to the
// target column's declared type, so jsonb, arrays, bytea, timestamps and
// enums round-trip without per-type handling.
//
// Checked, not assumed:
//   - the target has every source table with the same column set (both sides
//     come from the same drizzle schema; any drift aborts before truncation)
//   - no foreign-key cycle between tables; self-references (projects.parent_id)
//     are inserted in waves, parents before children
//   - sequences, if any, are reset from the copied maximum (none today: every
//     id is text)
import { Client } from "pg";

type Column = { name: string; cast: string };
type Row = Record<string, string | null>;
type Fk = { child: string; parent: string; childCols: string[]; parentCols: string[] };

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const YES = args.includes("--yes");
const FROM = flag("--from") ?? process.env.DATABASE_URL;
const TO = flag("--to");
if (!FROM || !TO) {
  console.error("usage: copy-db.ts --to <url> [--from <url>] [--yes]   (--from defaults to DATABASE_URL)");
  process.exit(2);
}
if (FROM === TO) {
  console.error("refusing: --from and --to are the same database");
  process.exit(2);
}

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const host = (url: string) => new URL(url).hostname;

function clientFor(url: string): Client {
  const h = host(url);
  const local = h === "localhost" || h === "127.0.0.1" || h === "::1";
  // Heroku's PG proxy needs SSL without CA verification (same as drizzle.config.ts).
  return new Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } });
}

async function tables(c: Client): Promise<string[]> {
  const { rows } = await c.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

async function columns(c: Client): Promise<Map<string, Column[]>> {
  const { rows } = await c.query<{ table_name: string; column_name: string; data_type: string; udt_name: string }>(
    `SELECT table_name, column_name, data_type, udt_name FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
  );
  const out = new Map<string, Column[]>();
  for (const r of rows) {
    const cast =
      r.data_type === "ARRAY" ? `${r.udt_name.replace(/^_/, "")}[]`
      : r.data_type === "USER-DEFINED" ? q(r.udt_name)
      : r.data_type;
    if (!out.has(r.table_name)) out.set(r.table_name, []);
    out.get(r.table_name)!.push({ name: r.column_name, cast });
  }
  return out;
}

async function foreignKeys(c: Client): Promise<Fk[]> {
  const { rows } = await c.query<Fk>(
    `SELECT cl.relname AS child, pl.relname AS parent,
            (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS "childCols",
            (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS "parentCols"
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_class pl ON pl.oid = con.confrelid
       JOIN pg_namespace n ON n.oid = con.connamespace
      WHERE con.contype = 'f' AND n.nspname = 'public'`
  );
  return rows;
}

/** Kahn's algorithm over parent → child edges; self-references are ignored here. */
function insertionOrder(names: string[], fks: Fk[]): string[] {
  const deps = new Map(names.map((n) => [n, new Set<string>()]));
  for (const fk of fks) if (fk.child !== fk.parent) deps.get(fk.child)?.add(fk.parent);
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < names.length) {
    const ready = names.filter((n) => !done.has(n) && [...deps.get(n)!].every((d) => done.has(d))).sort();
    if (ready.length === 0) {
      const stuck = names.filter((n) => !done.has(n));
      throw new Error(`foreign-key cycle between tables: ${stuck.join(", ")}`);
    }
    for (const n of ready) {
      order.push(n);
      done.add(n);
    }
  }
  return order;
}

async function counts(c: Client, names: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const n of names) {
    const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${q(n)}`);
    out.set(n, Number(rows[0].n));
  }
  return out;
}

async function insertRows(to: Client, table: string, cols: Column[], rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const batch = Math.max(1, Math.min(500, Math.floor(60000 / cols.length)));
  const colList = cols.map((c) => q(c.name)).join(", ");
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const params: (string | null)[] = [];
    const tuples = slice.map(
      (row) =>
        `(${cols
          .map((c) => {
            params.push(row[c.name]);
            return `$${params.length}::${c.cast}`;
          })
          .join(", ")})`
    );
    await to.query(`INSERT INTO ${q(table)} (${colList}) VALUES ${tuples.join(", ")}`, params);
  }
}

/** Self-referencing tables: insert rows whose parent is null or already present, repeat. */
async function insertInWaves(to: Client, table: string, cols: Column[], rows: Row[], selfFks: Fk[]): Promise<number> {
  const present = new Set<string>();
  const keyOf = (row: Row, fkCols: string[]) => JSON.stringify(fkCols.map((c) => row[c]));
  let pending = rows;
  let waves = 0;
  while (pending.length > 0) {
    const ready = pending.filter((row) =>
      selfFks.every((fk) => fk.childCols.some((c) => row[c] === null) || present.has(keyOf(row, fk.childCols)))
    );
    if (ready.length === 0) throw new Error(`${table}: ${pending.length} rows reference parents that never arrive`);
    await insertRows(to, table, cols, ready);
    for (const row of ready) for (const fk of selfFks) present.add(keyOf(row, fk.parentCols));
    const readySet = new Set(ready);
    pending = pending.filter((row) => !readySet.has(row));
    waves += 1;
  }
  return waves;
}

async function main() {
  const from = clientFor(FROM!);
  const to = clientFor(TO!);
  await from.connect();
  await to.connect();
  console.log(`from: ${host(FROM!)}   to: ${host(TO!)}   mode: ${YES ? "COPY (target will be truncated)" : "rehearsal, no writes"}`);

  // 1. Schemas must agree, column for column, before anything is truncated.
  const srcTables = await tables(from);
  const dstTables = await tables(to);
  const srcCols = await columns(from);
  const dstCols = await columns(to);
  const problems: string[] = [];
  for (const t of srcTables) {
    if (!dstTables.includes(t)) {
      problems.push(`target lacks table ${t}`);
      continue;
    }
    const a = srcCols.get(t)!.map((c) => c.name).sort().join(",");
    const b = dstCols.get(t)!.map((c) => c.name).sort().join(",");
    if (a !== b) problems.push(`columns differ on ${t}: source [${a}] target [${b}]`);
  }
  for (const t of dstTables) if (!srcTables.includes(t)) problems.push(`target has extra table ${t} (would be truncated, never filled)`);
  if (problems.length) {
    console.error("schema mismatch — nothing written:\n  " + problems.join("\n  "));
    process.exit(1);
  }

  // 2. Insertion order from the target's own foreign keys.
  const fks = await foreignKeys(to);
  const order = insertionOrder(srcTables, fks);
  const srcCounts = await counts(from, srcTables);
  const total = [...srcCounts.values()].reduce((a, b) => a + b, 0);
  console.log(`${srcTables.length} tables, ${total} rows, ${fks.length} foreign keys`);
  console.log("order: " + order.join(" → "));
  if (!YES) {
    for (const t of order) console.log(`  ${t.padEnd(28)} ${String(srcCounts.get(t)).padStart(6)} rows`);
    console.log("rehearsal only — re-run with --yes to copy");
    await from.end();
    await to.end();
    return;
  }

  // 3. One transaction: truncate everything, copy in order, verify, commit.
  await to.query("BEGIN");
  try {
    await to.query(`TRUNCATE ${srcTables.map(q).join(", ")} CASCADE`);
    for (const t of order) {
      const cols = dstCols.get(t)!;
      const selectList = cols.map((c) => `${q(c.name)}::text AS ${q(c.name)}`).join(", ");
      const { rows } = await from.query<Row>(`SELECT ${selectList} FROM ${q(t)}`);
      const selfFks = fks.filter((fk) => fk.child === t && fk.parent === t);
      let waves = 1;
      if (selfFks.length) waves = await insertInWaves(to, t, cols, rows, selfFks);
      else await insertRows(to, t, cols, rows);
      console.log(`  ${t.padEnd(28)} ${String(rows.length).padStart(6)} rows${waves > 1 ? ` (${waves} waves)` : ""}`);
    }
    // Sequences, if any ever appear: continue from the copied maximum.
    const { rows: seqs } = await to.query<{ table_name: string; column_name: string; seq: string }>(
      `SELECT table_name, column_name, pg_get_serial_sequence(quote_ident(table_name), column_name) AS seq
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`
    );
    for (const s of seqs) {
      await to.query(
        `SELECT setval($1, COALESCE((SELECT max(${q(s.column_name)}) FROM ${q(s.table_name)}), 0) + 1, false)`,
        [s.seq]
      );
    }
    const dstCounts = await counts(to, srcTables);
    const bad = srcTables.filter((t) => srcCounts.get(t) !== dstCounts.get(t));
    if (bad.length) {
      throw new Error(
        "row counts differ after copy: " + bad.map((t) => `${t} ${srcCounts.get(t)}→${dstCounts.get(t)}`).join(", ")
      );
    }
    await to.query("COMMIT");
    console.log(`copied ${total} rows across ${srcTables.length} tables; every count matches. committed.`);
  } catch (e) {
    await to.query("ROLLBACK");
    console.error("rolled back — target untouched:", (e as Error).message);
    process.exit(1);
  } finally {
    await from.end();
    await to.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
