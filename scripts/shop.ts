// Shop runner: the two headless Claude Code phases of the self-improvement
// loop. Spawned detached by lib/shop/shop.ts (same pattern as slow-loop.ts).
//
//   npx tsx scripts/shop.ts --plan  <id>   plan mode (read-only) → plan text
//   npx tsx scripts/shop.ts --build <id>   worktree build → runner-verified merge
//
// The runner NEVER trusts the build agent's word: after the build run it
// re-executes tsc + lint + tests itself in the worktree, and only a green
// board merges to main. Failed branches are kept for autopsy.
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { capabilityRequests } from "@/lib/db/schema";
import { buildPrompt, planPrompt, shopSlug } from "@/lib/shop/shop";

const exec = promisify(execFile);
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
// The runner inherits the dev server's env, which carries ANTHROPIC_API_KEY
// (the app's brain key). Headless claude must NOT pick it up — it overrides
// the user's claude.ai login and died mid-run on the first live build.
const claudeEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
};
const PLAN_TIMEOUT_MS = 15 * 60 * 1000;
const BUILD_TIMEOUT_MS = 40 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const REPO = process.cwd();
const WORKTREES = resolve(REPO, "..", ".secretary-shop");

async function setStatus(
  id: string,
  patch: Partial<typeof capabilityRequests.$inferInsert>
): Promise<void> {
  await db
    .update(capabilityRequests)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(capabilityRequests.id, id));
}

async function loadRequest(id: string) {
  const [row] = await db
    .select()
    .from(capabilityRequests)
    .where(eq(capabilityRequests.id, id))
    .limit(1);
  return row ?? null;
}

async function runPlan(id: string): Promise<void> {
  const req = await loadRequest(id);
  if (!req) return console.error(`shop: no request ${id}`);
  await setStatus(id, { status: "planning" });
  console.log(`shop: planning "${req.need}"`);
  try {
    const { stdout } = await exec(
      CLAUDE_BIN,
      ["-p", planPrompt(req), "--output-format", "text", "--permission-mode", "plan"],
      { cwd: REPO, timeout: PLAN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: claudeEnv() }
    );
    const plan = stdout.trim();
    if (!plan) throw new Error("empty plan output");
    await setStatus(id, { status: "planned", plan });
    console.log(`shop: plan ready for "${req.need}" — awaiting approval`);
    const { sendPush } = await import("@/lib/push");
    await sendPush(req.userId, {
      title: "The shop drafted a plan",
      body: `"${req.need}" — tap to review and approve.`,
      url: "/settings",
    }).catch(() => 0);
  } catch (e) {
    await setStatus(id, {
      status: "failed",
      buildLog: `plan phase failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    console.error(`shop: plan phase failed for ${id}`);
  }
  // Lane cleared — pull the next filed request into planning.
  const [next] = await db
    .select()
    .from(capabilityRequests)
    .where(eq(capabilityRequests.status, "filed"))
    .limit(1);
  if (next) await runPlan(next.id);
}

async function sh(cmd: string, args: string[], cwd: string, timeout = VERIFY_TIMEOUT_MS) {
  return exec(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
}

async function runBuild(id: string): Promise<void> {
  const req = await loadRequest(id);
  if (!req) return console.error(`shop: no request ${id}`);
  const slug = `${shopSlug(req.need)}-${id.slice(0, 6)}`;
  const branch = `shop/${slug}`;
  const dir = join(WORKTREES, slug);
  await setStatus(id, { status: "building", branch });
  console.log(`shop: building "${req.need}" on ${branch}`);
  const log: string[] = [];

  try {
    // 1. Isolated worktree; share node_modules, copy env (gitignored, needed
    //    by tests). The blast radius is this branch until verification passes.
    //    Idempotent: a stale worktree/branch from a failed run is swept first.
    if (existsSync(dir)) {
      await sh("git", ["worktree", "remove", dir, "--force"], REPO).catch(() => {});
    }
    await sh("git", ["branch", "-D", branch], REPO).catch(() => {});
    await sh("git", ["worktree", "add", dir, "-b", branch], REPO);
    if (!existsSync(join(dir, "node_modules"))) {
      symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
    }
    if (existsSync(join(REPO, ".env.local"))) {
      copyFileSync(join(REPO, ".env.local"), join(dir, ".env.local"));
    }

    // 2. The build agent. Skip-permissions is safe HERE ONLY because the
    //    worktree is disposable and step 3 is the actual gate. The agent's
    //    EXIT CODE is advisory — a crashed session that left real work behind
    //    still goes to verification; the gate judges the tree, not the agent.
    log.push("== build agent ==");
    try {
      const { stdout } = await exec(
        CLAUDE_BIN,
        ["-p", buildPrompt(req), "--output-format", "text", "--dangerously-skip-permissions"],
        { cwd: dir, timeout: BUILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: claudeEnv() }
      );
      log.push(stdout.slice(-4000));
    } catch (e) {
      log.push(
        `agent process exited abnormally (continuing — verification decides): ${
          e instanceof Error ? e.message.split("\n").slice(-3).join(" ").slice(0, 500) : String(e)
        }`
      );
    }

    // Sweep any uncommitted work into the branch before judging it.
    const { stdout: dirty } = await sh("git", ["status", "--porcelain"], dir);
    if (dirty.trim()) {
      await sh("git", ["add", "-A"], dir);
      await sh("git", ["commit", "-m", `Shop: ${req.need} (runner sweep)`], dir);
    }
    const { stdout: commits } = await sh("git", ["rev-list", "--count", `main..${branch}`], dir);
    if (Number(commits.trim()) === 0) throw new Error("build produced no commits");

    // 3. Runner-owned verification — the agent's claims count for nothing.
    log.push("== verify: tsc ==");
    await sh("npx", ["tsc", "--noEmit"], dir);
    log.push("clean");
    log.push("== verify: lint ==");
    await sh("npm", ["run", "lint"], dir);
    log.push("clean");
    log.push("== verify: tests ==");
    const { stdout: testOut } = await sh("npm", ["test"], dir, VERIFY_TIMEOUT_MS);
    log.push(testOut.slice(-1500));

    // 4. Green — land it. A conflict keeps the branch and reports honestly.
    try {
      await sh("git", ["merge", "--no-ff", branch, "-m", `Shop: ${req.need}`], REPO);
    } catch (e) {
      await sh("git", ["merge", "--abort"], REPO).catch(() => {});
      throw new Error(
        `built GREEN but merge conflicted — branch ${branch} kept, merge manually. ${e instanceof Error ? e.message : ""}`
      );
    }
    await sh("git", ["worktree", "remove", dir, "--force"], REPO);
    await setStatus(id, { status: "shipped", buildLog: log.join("\n") });
    console.log(`shop: SHIPPED "${req.need}" (${branch} merged)`);
    const { sendPush } = await import("@/lib/push");
    await sendPush(req.userId, {
      title: "The shop shipped it",
      body: `"${req.need}" is live — all tests passed.`,
      url: "/settings",
    }).catch(() => 0);
  } catch (e) {
    log.push(`== FAILED ==\n${e instanceof Error ? e.message : String(e)}`);
    await setStatus(id, { status: "failed", buildLog: log.join("\n").slice(-12000) });
    console.error(`shop: build failed for ${id} — branch ${branch} kept for autopsy`);
    const { sendPush } = await import("@/lib/push");
    await sendPush(req.userId, {
      title: "Shop build failed",
      body: `"${req.need}" didn't pass verification — details in Settings.`,
      url: "/settings",
    }).catch(() => 0);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const planIdx = args.indexOf("--plan");
  const buildIdx = args.indexOf("--build");
  if (planIdx !== -1 && args[planIdx + 1]) await runPlan(args[planIdx + 1]);
  else if (buildIdx !== -1 && args[buildIdx + 1]) await runBuild(args[buildIdx + 1]);
  else console.error("usage: shop.ts --plan <id> | --build <id>");
  process.exit(0);
}

void main();
