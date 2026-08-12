// Boot (or reuse) the isolated sim stack: embedded Postgres on 5433 +
// `next dev -p 3100` with its own dist dir, database, and auth secret.
// Idempotent — safe to call before every run.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { cfg } from "../config";
import { appReady, pgReady, waitFor } from "./health";

const STATE_FILE = "sim/.instance.json";

type InstanceState = { pgPid: number; nextPid: number; bootedAt: string };

function readEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  } catch {
    /* no .env.local */
  }
  return out;
}

export async function up(): Promise<void> {
  mkdirSync("sim/reports", { recursive: true });

  if (existsSync(STATE_FILE) && (await pgReady()) && (await appReady())) {
    console.log(`sim instance: reusing (app ${cfg.appUrl}, pg :${cfg.pgPort})`);
    return;
  }

  const envLocal = readEnvLocal();
  const openaiKey = process.env.OPENAI_API_KEY ?? envLocal.OPENAI_API_KEY;
  if (!openaiKey) throw new Error("OPENAI_API_KEY not found in env or .env.local");

  let pgPid = 0;
  if (!(await pgReady())) {
    console.log(`sim instance: starting Postgres on :${cfg.pgPort} (${cfg.pgDataDir})…`);
    const pgLog = openSync("sim/reports/pg.log", "a");
    const pg = spawn("node", ["scripts/local-postgres.mjs"], {
      detached: true,
      stdio: ["ignore", pgLog, pgLog],
      env: {
        ...process.env,
        PGPORT: String(cfg.pgPort),
        PGDATA_DIR: cfg.pgDataDir,
        PGDATABASE: cfg.pgDb,
      },
    });
    pg.unref();
    pgPid = pg.pid ?? 0;
    await waitFor(pgReady, "sim postgres", 90_000);
  }

  console.log("sim instance: pushing schema…");
  const push = spawnSync("npx", ["drizzle-kit", "push", "--force"], {
    env: { ...process.env, DATABASE_URL: cfg.simDatabaseUrl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (push.status !== 0) {
    throw new Error(`drizzle-kit push failed:\n${push.stderr?.toString().slice(0, 800)}`);
  }

  let nextPid = 0;
  if (!(await appReady())) {
    console.log(`sim instance: starting Next on :${cfg.appPort}…`);
    const nextLog = openSync("sim/reports/next.log", "a");
    const next = spawn("npx", ["next", "dev", "-p", String(cfg.appPort)], {
      detached: true,
      stdio: ["ignore", nextLog, nextLog],
      env: {
        ...process.env,
        DATABASE_URL: cfg.simDatabaseUrl,
        BETTER_AUTH_URL: cfg.appUrl,
        NEXT_PUBLIC_APP_URL: cfg.appUrl,
        BETTER_AUTH_SECRET: cfg.authSecret,
        NEXT_DIST_DIR: cfg.distDir,
        OPENAI_API_KEY: openaiKey,
        ...(cfg.brainModel ? { TEXT_MODEL: cfg.brainModel } : {}),
        RESEND_API_KEY: "",
        TRUSTED_ORIGINS: "",
        VOICE_DISABLED: "false",
      },
    });
    next.unref();
    nextPid = next.pid ?? 0;
    await waitFor(appReady, "sim next server", 180_000);
  }

  const state: InstanceState = { pgPid, nextPid, bootedAt: new Date().toISOString() };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`sim instance: ready at ${cfg.appUrl} (db :${cfg.pgPort}/${cfg.pgDb})`);
}

const invokedDirectly = process.argv[1]?.includes("instance/up");
if (invokedDirectly) {
  up().catch((e) => {
    console.error("sim instance boot failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
