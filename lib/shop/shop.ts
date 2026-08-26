// The Shop: the app's self-improvement loop. "I can't do that" is never the
// end of the sentence — the secretary files a capability request here, headless
// Claude Code drafts a PLAN (plan mode, read-only), the user approves, and a
// worktree build lands only after the runner itself re-runs tsc + lint + tests.
// Generalizes the slow loop (lib/layout/slow-loop.ts) from dashboard templates
// to real app changes; same detached-spawn pattern, same approval-gate ethos.
//
// Guardrails (enforced in scripts/shop.ts, stated here for the reader):
// - Approval is the ONLY human step; everything after is autonomous but gated
//   by runner-run verification, never by the build agent's own claims.
// - One request in flight (planning/building) at a time.
// - Failed branches are kept for autopsy and never auto-retried.
// - The build must not touch lib/auth.ts, .env.local, or deployment scripts.
import { spawn } from "node:child_process";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { capabilityRequests } from "@/lib/db/schema";

const normalize = (need: string) => need.trim().toLowerCase().replace(/\s+/g, " ");

export const shopSlug = (need: string) =>
  normalize(need)
    .replace(/[^a-z0-9- ]/g, "")
    .split(/\s+/)
    .slice(0, 5)
    .join("-")
    .replace(/-+/g, "-");

const IN_FLIGHT = ["planning", "building"] as const;

function spawnRunner(args: string[]): void {
  if (process.env.VITEST || process.env.SHOP_DISABLED === "true") return;
  const child = spawn("npx", ["tsx", "scripts/shop.ts", ...args], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

/**
 * File a request and kick off the plan phase. Dedupes by normalized need:
 * an open/planned twin is returned as-is; a rejected twin stays rejected
 * (the user said no — don't nag). Only one request plans/builds at a time;
 * extras stay `filed` and are picked up when the lane clears.
 */
export async function fileRequest(
  userId: string,
  need: string,
  context?: string,
  conversationId?: string
): Promise<{ id: string; status: string; deduped: boolean; queued: boolean }> {
  const rows = await db
    .select()
    .from(capabilityRequests)
    .where(eq(capabilityRequests.userId, userId));
  const twin = rows.find((r) => normalize(r.need) === normalize(need));
  if (twin && twin.status !== "failed") {
    return { id: twin.id, status: twin.status, deduped: true, queued: false };
  }

  const [row] = await db
    .insert(capabilityRequests)
    .values({ userId, need, context: context ?? null, conversationId: conversationId ?? null })
    .returning();

  const busy = rows.some((r) => (IN_FLIGHT as readonly string[]).includes(r.status));
  if (!busy) {
    await db
      .update(capabilityRequests)
      .set({ status: "planning", updatedAt: new Date() })
      .where(eq(capabilityRequests.id, row.id));
    spawnRunner(["--plan", row.id]);
    return { id: row.id, status: "planning", deduped: false, queued: false };
  }
  return { id: row.id, status: "filed", deduped: false, queued: true };
}

/** Approve a planned request → the build phase starts (the last human step). */
export async function approveRequest(
  userId: string,
  id: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const [row] = await db
    .select()
    .from(capabilityRequests)
    .where(and(eq(capabilityRequests.id, id), eq(capabilityRequests.userId, userId)))
    .limit(1);
  if (!row) return { ok: false, error: "No such request" };
  if (row.status !== "planned") {
    return { ok: false, error: `Request is ${row.status} — only a planned request can be approved` };
  }
  const [inFlight] = await db
    .select({ id: capabilityRequests.id })
    .from(capabilityRequests)
    .where(
      and(
        eq(capabilityRequests.userId, userId),
        inArray(capabilityRequests.status, [...IN_FLIGHT])
      )
    )
    .limit(1);
  if (inFlight) return { ok: false, error: "The shop is mid-job — approve again when it finishes" };
  await db
    .update(capabilityRequests)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(capabilityRequests.id, id));
  spawnRunner(["--build", id]);
  return { ok: true };
}

export async function rejectRequest(userId: string, id: string): Promise<boolean> {
  const res = await db
    .update(capabilityRequests)
    .set({ status: "rejected", updatedAt: new Date() })
    .where(and(eq(capabilityRequests.id, id), eq(capabilityRequests.userId, userId)))
    .returning({ id: capabilityRequests.id });
  return res.length > 0;
}

export async function listRequests(userId: string) {
  return db
    .select()
    .from(capabilityRequests)
    .where(eq(capabilityRequests.userId, userId))
    .orderBy(desc(capabilityRequests.createdAt));
}

/** Fuzzy find by need fragment — chat/voice approvals say "the reporting one". */
export async function findRequest(userId: string, fragment: string) {
  const rows = await listRequests(userId);
  const f = normalize(fragment);
  return (
    rows.find((r) => r.id === fragment) ??
    rows.find((r) => normalize(r.need).includes(f)) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Prompts for the headless Claude Code runs (scripts/shop.ts)
// ---------------------------------------------------------------------------

export function planPrompt(req: { need: string; context: string | null }): string {
  return [
    "You are planning a feature for the personal-assistant app you are running inside (the secretary).",
    "CLAUDE.md and docs/adaptive-ui/SPEC.md are law. Explore the code as needed.",
    "",
    "## The need (verbatim, from the user's secretary)",
    req.need,
    ...(req.context ? ["", "## Conversation context", req.context] : []),
    "",
    "## Produce",
    "A concise implementation plan in markdown — the user reads and approves this on a phone:",
    "- 2-3 sentence summary of what will exist after the build, in plain language first",
    "- Files to touch (existing patterns to reuse, named)",
    "- Schema changes if any",
    "- Tests to add",
    "- One RISK line: what could regress",
    "Do NOT write the implementation. Keep it under 400 words.",
  ].join("\n");
}

export function buildPrompt(req: { need: string; plan: string | null }): string {
  return [
    "Implement the following approved plan in this repo (the secretary app). You are in an isolated",
    "git worktree on your own branch — work freely, but these are HARD constraints:",
    "- NEVER touch lib/auth.ts, .env.local, or scripts/sync-to-heroku.mjs.",
    "- Follow CLAUDE.md and docs/adaptive-ui/SPEC.md. Reuse existing patterns; match the codebase's idiom.",
    "- Add or extend tests for what you build (tests/ uses the real local Postgres — follow existing suites).",
    "- If the schema changes, run: npx drizzle-kit push",
    "- Before finishing: npx tsc --noEmit && npm run lint && npm test — fix anything red.",
    "- Commit ALL your work with message starting `Shop: ` (the runner independently re-verifies; an",
    "  uncommitted or red-tested worktree is a failed build).",
    "",
    "## The need",
    req.need,
    "",
    "## The approved plan",
    req.plan ?? "(no plan text — implement the need directly, smallest correct change)",
  ].join("\n");
}
