// Nightly local→Heroku mirror + local snapshot. LOCAL IS THE SOURCE OF TRUTH:
// this script overwrites the Heroku database with local data every run.
// Never enter real data on the Heroku URL — it will be clobbered.
//
// Steps: 1) JSON snapshot of every table to ~/secretary-backups (14 kept)
//        2) full copy local → Heroku inside one transaction (FK-safe order)
//        3) verify per-table row counts match; exit 1 on any mismatch
//
// Env: HEROKU_API_KEY (unattended auth) or an interactive `heroku login`;
//      LOCAL_DATABASE_URL / HEROKU_APP overridable. Pure node — no pg_dump.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const LOCAL_URL =
  process.env.LOCAL_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/secretary";
const HEROKU_APP = process.env.HEROKU_APP ?? "secretary-kiron";
const HEROKU_BIN = process.env.HEROKU_BIN ?? "/usr/local/bin/heroku";
const BACKUP_ROOT = join(homedir(), "secretary-backups");
const KEEP_SNAPSHOTS = 14;

// FK-safe insert order (reverse for deletes)
const TABLES = [
  "user",
  "account",
  "session",
  "verification",
  "passkey",
  "projects",
  "conversations",
  "messages",
  "tasks",
  "events",
  "checkins",
  "memories",
  "documents",
  "document_versions",
  "layout_specs",
  "usage",
];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function herokuDbUrl() {
  const out = execFileSync(HEROKU_BIN, ["config:get", "DATABASE_URL", "-a", HEROKU_APP], {
    encoding: "utf8",
    env: process.env,
  }).trim();
  if (!out.startsWith("postgres")) throw new Error("could not fetch Heroku DATABASE_URL");
  return out;
}

async function main() {
  const local = new pg.Pool({ connectionString: LOCAL_URL, max: 4 });
  const remote = new pg.Pool({
    connectionString: herokuDbUrl(),
    ssl: { rejectUnauthorized: false },
    max: 4,
  });

  try {
    // ---- 1. local snapshot -------------------------------------------------
    const stamp = new Date().toISOString().slice(0, 10);
    const snapDir = join(BACKUP_ROOT, `snapshot-${stamp}`);
    mkdirSync(snapDir, { recursive: true });
    let totalRows = 0;
    for (const table of TABLES) {
      const { rows } = await local.query(`SELECT * FROM "${table}"`);
      writeFileSync(join(snapDir, `${table}.json`), JSON.stringify(rows));
      totalRows += rows.length;
    }
    log(`snapshot: ${totalRows} rows across ${TABLES.length} tables → ${snapDir}`);
    // prune old snapshots
    const snaps = readdirSync(BACKUP_ROOT)
      .filter((d) => d.startsWith("snapshot-"))
      .sort();
    for (const old of snaps.slice(0, Math.max(0, snaps.length - KEEP_SNAPSHOTS))) {
      rmSync(join(BACKUP_ROOT, old), { recursive: true, force: true });
      log(`pruned old snapshot ${old}`);
    }

    // ---- 2. mirror local → Heroku ------------------------------------------
    const client = await remote.connect();
    try {
      await client.query("BEGIN");
      for (const table of [...TABLES].reverse()) {
        await client.query(`DELETE FROM "${table}"`);
      }
      for (const table of TABLES) {
        const { rows, fields } = await local.query(`SELECT * FROM "${table}"`);
        if (rows.length === 0) continue;
        const cols = fields.map((f) => f.name);
        const colSql = cols.map((c) => `"${c}"`).join(", ");
        // chunked multi-row inserts
        const CHUNK = 200;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const values = [];
          const params = [];
          let p = 1;
          for (const row of chunk) {
            const ph = cols.map((c) => {
              const v = row[c];
              params.push(
                v !== null && typeof v === "object" && !(v instanceof Date)
                  ? JSON.stringify(v)
                  : v
              );
              return `$${p++}`;
            });
            values.push(`(${ph.join(",")})`);
          }
          await client.query(
            `INSERT INTO "${table}" (${colSql}) VALUES ${values.join(",")}`,
            params
          );
        }
        log(`mirrored ${table}: ${rows.length} rows`);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    // ---- 3. verify counts ---------------------------------------------------
    let mismatches = 0;
    for (const table of TABLES) {
      const [l, r] = await Promise.all([
        local.query(`SELECT count(*)::int AS n FROM "${table}"`),
        remote.query(`SELECT count(*)::int AS n FROM "${table}"`),
      ]);
      if (l.rows[0].n !== r.rows[0].n) {
        mismatches++;
        console.error(`COUNT MISMATCH ${table}: local=${l.rows[0].n} heroku=${r.rows[0].n}`);
      }
    }
    if (mismatches > 0) throw new Error(`${mismatches} table count mismatch(es)`);
    log("verify: all table counts match — sync OK");
  } finally {
    await local.end();
    await remote.end();
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] SYNC FAILED:`, e.message);
  process.exit(1);
});
