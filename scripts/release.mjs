// The Heroku release phase: bring the database up to lib/db/schema.ts.
//
// Why this is a script and not the bare `npx drizzle-kit push --force` it was
// until 2026-09-22: drizzle-kit push asks an interactive question whenever one
// push both drops a table and creates one ("Is X created or renamed from
// another table?"), and a release dyno has no TTY to answer it. It then
// throws "Interactive prompts require a TTY terminal", applies NOTHING, and
// still exits 0 — so the release looks green while the schema is missing.
// Reproduced locally on 2026-09-22 with record_dirty present and
// understanding_runs absent, which is exactly production's shape before
// understanding phase 2. The same exit-0-on-error behaviour hid the
// pg_stat_statements failure in v9 (docs/HANDOFF.md).
//
// So, in order: run the one-off statements below, so the push itself is purely
// additive and never prompts; run the push; treat an error in its output as a
// failed release, whatever its exit code says.
//
// Locally, against the dev database: node --env-file=.env.local scripts/release.mjs
// CI runs it too (.github/workflows/deploy.yml), so the script itself is
// exercised before it reaches a release dyno.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");

// Idempotent statements that run BEFORE the push: each is a step the push
// cannot take non-interactively. Delete an entry once the release that needed
// it has shipped; it is harmless until then.
const PRE_PUSH = [
  // Understanding phase 2 (docs/understanding/SPEC.md §8): record_dirty leaves
  // the schema in the same release that adds understanding_runs. Removed here
  // so the push sees only creates. The table never had a writer, so there is
  // nothing in it to keep.
  "DROP TABLE IF EXISTS record_dirty",
];

async function prePush() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // The same setting as lib/db/index.ts: Heroku's proxy cert does not verify.
    ssl: process.env.ON_HEROKU ? { rejectUnauthorized: false } : undefined,
  });
  try {
    for (const sql of PRE_PUSH) {
      console.log(`release: ${sql}`);
      await pool.query(sql);
    }
  } finally {
    await pool.end();
  }
}

function push() {
  // stdin is closed on purpose, locally too, so a run here behaves exactly as
  // it will on the dyno: a prompt is a failure, never something to answer.
  const result = spawnSync("npx", ["drizzle-kit", "push", "--force"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`drizzle-kit push exited ${result.status}`);
  if (/Interactive prompts require a TTY|\b(?:[A-Za-z]*Error|error): /.test(out)) {
    throw new Error("drizzle-kit push reported an error (and exited 0): the schema was not applied");
  }
  if (!/Changes applied|No changes detected/.test(out)) {
    throw new Error("drizzle-kit push did not report a result; treating the release as failed");
  }
}

try {
  await prePush();
  push();
  console.log("release: schema is current");
} catch (e) {
  console.error(`release: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
