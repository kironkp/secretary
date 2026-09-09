// Full-database JSON snapshot.
//
// There is no pg_dump on this machine — the embedded-postgres bundle ships
// only initdb/pg_ctl/postgres — and this repo has no migration files to roll
// back with (drizzle-kit push only). So before any schema change, take one of
// these: every row of every public table, written to a timestamped JSON file.
//
//   npx tsx --env-file=.env.local scripts/db-backup.ts [outDir]
//
// bytea columns are base64-encoded and marked, so attachment payloads survive
// the round trip. Dates go out as ISO strings.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const outDir = process.argv[2] ?? "backups";

function encode(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { __bytea_b64: value.toString("base64") };
  if (value instanceof Date) return value.toISOString();
  return value;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const client = new Client({ connectionString: url });
  await client.connect();

  const { rows: tables } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );

  const dump: Record<string, unknown[]> = {};
  let total = 0;
  for (const { table_name } of tables) {
    const { rows } = await client.query(`SELECT * FROM "${table_name}"`);
    dump[table_name] = rows.map((row: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, encode(v)]))
    );
    total += rows.length;
    console.log(`  ${table_name}: ${rows.length}`);
  }
  await client.end();

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(outDir, `secretary-${stamp}.json`);
  writeFileSync(
    file,
    JSON.stringify({ takenAt: new Date().toISOString(), database: url.split("/").pop(), dump }, null, 1)
  );
  console.log(`\n${total} rows across ${tables.length} tables → ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
