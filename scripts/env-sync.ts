// Keep Heroku's config vars aligned with .env.local — without ever clobbering
// the ones that MUST differ between a laptop and a dyno.
//
//   npx tsx scripts/env-sync.ts                 # report only (default, safe)
//   npx tsx scripts/env-sync.ts --yes           # set the keys Heroku is missing
//   npx tsx scripts/env-sync.ts --yes --overwrite   # also replace keys whose values differ
//
// Prints key NAMES and a status, never a value. Reads .env.local straight off
// disk (not process.env) so it compares the file, not whatever the shell had.
//
// Why not just copy-paste the whole file: several keys are per-environment and
// copying them up would break or destroy production —
//   DATABASE_URL      Heroku-managed; overwriting it points the dyno at the Mac
//   BETTER_AUTH_URL / NEXT_PUBLIC_APP_URL / TRUSTED_ORIGINS
//                     the local tunnel/localhost origins; auth breaks on the
//                     herokuapp.com domain
//   PORT / NODE_ENV / NEXT_RUNTIME / ON_HEROKU
//                     set by the platform or by Next itself
//   VITEST            test-runner marker
// Those are refused outright: not set, not overwritten, not reported as drift.
//
// Default is additive. A key already on Heroku is left alone even if it differs
// (BETTER_AUTH_SECRET is the one to be careful with: it signs sessions and
// derives the at-rest key for connected-account secrets, so swapping it
// invalidates both). Differences are reported; --overwrite is a deliberate act.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const APP = process.env.HEROKU_APP ?? "secretary-kiron";
const args = process.argv.slice(2);
const APPLY = args.includes("--yes");
const OVERWRITE = args.includes("--overwrite");

/** Never sent to Heroku: platform-managed, or must differ per environment. */
const NEVER_SYNC = new Set([
  "DATABASE_URL",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_APP_URL",
  "TRUSTED_ORIGINS",
  "ON_HEROKU",
  "PORT",
  "NODE_ENV",
  "NEXT_RUNTIME",
  "VITEST",
  "npm_lifecycle_event",
]);

/** Heroku-only values with no sensible local counterpart. */
const HEROKU_ONLY: Record<string, string> = {
  // The Shop spawns `npx tsx`, git worktrees and the claude CLI against a real
  // checkout. A dyno has none of that, so the runner must never start there.
  // lib/shop/shop.ts:56 honours this; the queue sweeper still runs harmlessly.
  SHOP_DISABLED: "true",
};

function parseEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

function parseLines(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

function main() {
  const local = parseEnvFile(".env.local");
  const remote = parseLines(
    execFileSync("heroku", ["config", "-s", "-a", APP], { encoding: "utf8", maxBuffer: 10 << 20 })
  );

  const candidates = new Map<string, string>();
  for (const [k, v] of local) if (!NEVER_SYNC.has(k) && v !== "") candidates.set(k, v);
  for (const [k, v] of Object.entries(HEROKU_ONLY)) candidates.set(k, v);

  const missing: string[] = [];
  const differs: string[] = [];
  const same: string[] = [];
  const empty: string[] = [];
  for (const [k, v] of local) if (!NEVER_SYNC.has(k) && v === "") empty.push(k);
  for (const [k, v] of candidates) {
    if (!remote.has(k)) missing.push(k);
    else if (remote.get(k) !== v) differs.push(k);
    else same.push(k);
  }
  const refused = [...local.keys()].filter((k) => NEVER_SYNC.has(k));

  const show = (label: string, keys: string[]) => {
    if (keys.length) console.log(`${label} (${keys.length}): ${keys.sort().join(", ")}`);
  };
  console.log(`app: ${APP}   .env.local: ${local.size} keys   heroku: ${remote.size} keys`);
  show("in sync", same);
  show("MISSING on Heroku", missing);
  show("DIFFERENT (left alone unless --overwrite)", differs);
  show("empty locally, skipped", empty);
  show("per-environment, never synced", refused);

  const toSet = OVERWRITE ? [...missing, ...differs] : missing;
  if (toSet.length === 0) {
    console.log("nothing to do — Heroku has every shared key.");
    return;
  }
  if (!APPLY) {
    console.log(`\nwould set ${toSet.length} key(s). Re-run with --yes to apply${differs.length && !OVERWRITE ? " (add --overwrite to replace the differing ones)" : ""}.`);
    return;
  }
  // One config:set = one restart. Values go through argv, never a shell string.
  const pairs = toSet.map((k) => `${k}=${candidates.get(k)}`);
  console.log(`\nsetting ${toSet.length} key(s) on ${APP}: ${toSet.sort().join(", ")}`);
  execFileSync("heroku", ["config:set", "-a", APP, ...pairs], { stdio: ["ignore", "inherit", "inherit"] });
  console.log("done — the dyno restarts once with the new values.");
}

main();
