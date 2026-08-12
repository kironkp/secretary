// Orchestrator CLI.
//   --selftest              boot, one user, one chat turn, snapshot sanity
//   --fleet smoke|full      run a fixture fleet
//   --replay --scenario X --run <runId>   re-send a recorded conversation
//   --trigger post-commit   (metadata only, recorded in the report)
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { closeSimDb } from "./db";
import { cfg } from "./config";
import { up } from "./instance/up";
import { createSimUser, deleteSimUser, wipeAllSimUsers } from "./bootstrap";
import { SimClient } from "./client";
import { diffSnapshots, snapshotUser } from "./snapshot";
import { runFleet } from "./fleet";

const LOCK_FILE = "sim/.run.lock";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function acquireLock(): boolean {
  if (existsSync(LOCK_FILE)) {
    try {
      const { pid } = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
      process.kill(pid, 0); // throws if dead
      return false; // live run in progress
    } catch {
      /* stale lock */
    }
  }
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return true;
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* gone */
  }
}

async function selftest(): Promise<void> {
  await up();
  const runId = `selftest-${Date.now().toString(36)}`;
  console.log("selftest: creating user…");
  const user = await createSimUser({
    runId,
    personaId: "selftest",
    name: "Self Test",
    timezone: "America/Los_Angeles",
  });
  const client = new SimClient(user.cookie);
  try {
    const before = await snapshotUser(user.userId);
    console.log("selftest: sending one chat message…");
    const res = await client.chat("Hello! Please add a task called Selftest ping for tomorrow.", null);
    console.log(`selftest: assistant replied (${res.assistantMessage.content.length} chars, ${res.toasts.length} toast[s])`);
    const after = await snapshotUser(user.userId);
    const diff = diffSnapshots(before, after);
    const msgs = diff.messages.created.length;
    const tasks = diff.tasks.created.length;
    console.log(`selftest: diff shows ${msgs} new messages, ${tasks} new task(s)`);
    if (msgs < 2) throw new Error("expected ≥2 message rows (user+assistant)");
    console.log("selftest: PASS");
  } finally {
    await deleteSimUser(user.userId);
  }
}

async function main() {
  if (process.argv.includes("--selftest")) {
    await selftest();
    return;
  }

  if (!acquireLock()) {
    console.log("sim: a run is already in progress — skipped");
    return;
  }
  try {
    await up();
    const wiped = await wipeAllSimUsers();
    if (wiped) console.log(`sim: hygiene — wiped ${wiped} leftover sim user(s)`);
    await runFleet({
      fleet: (argValue("--fleet") ?? "smoke") as "smoke" | "full",
      trigger: argValue("--trigger") ?? "manual",
      replayScenario: argValue("--scenario"),
      replayRun: argValue("--run"),
      live: process.argv.includes("--live"),
      concurrency: cfg.concurrency,
    });
  } finally {
    releaseLock();
  }
}

main()
  .then(async () => {
    await closeSimDb();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (e) => {
    console.error("sim run failed:", e instanceof Error ? (e.stack ?? e.message) : e);
    await closeSimDb();
    releaseLock();
    process.exit(1);
  });
