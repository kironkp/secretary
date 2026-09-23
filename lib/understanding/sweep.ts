// The sweep — docs/understanding/SPEC.md §8.
//
// Every UNDERSTANDING_SWEEP_MINUTES the boot hook (instrumentation.ts) calls
// sweepUnderstanding: every user who owns an active project gets a runAll,
// which gathers each active project once, hashes the bundle and calls the
// model only where the hash differs from the stored one. A project nothing
// touched costs a handful of indexed reads and a compare; the local date in
// the hash re-runs every project once a day. That is the whole trigger
// design: there is no dirty table, and nothing here is ever awaited by a
// request.
//
// This module also answers the Settings section (app/api/understanding):
// which provider and model a run would use, the latest run per project, and
// the tally shape both the sweep and "Understand now" report in.
import { and, count, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clarifications,
  connectedAccounts,
  projects,
  understandingRuns,
  user,
} from "@/lib/db/schema";
import { QUESTION_KINDS } from "./types";
import { healDuplicates, retireAsrClarifications } from "./questions";
import {
  DEFAULT_MODEL,
  DEFAULT_OPENAI_MODEL,
  modelCallFor,
  runAll,
  type ModelCall,
  type RunResult,
} from "./run";

// --------------------------------------------------------------------------
// Configuration, as the boot hook and Settings read it
// --------------------------------------------------------------------------

const DEFAULT_SWEEP_MINUTES = 10;
/** Below this a sweep could overlap its own gather on a slow day; the latch would hold, but the cadence would be a lie. */
const MIN_SWEEP_MINUTES = 2;
/**
 * One day. The daily re-run (SPEC §8, "once a day regardless") needs at
 * least one sweep a day to happen at all, and a delay past 2^31-1 ms would
 * overflow setInterval, which Node then runs every millisecond: the sweep
 * would become a continuous loop instead of stopping.
 */
const MAX_SWEEP_MINUTES = 24 * 60;

/** UNDERSTANDING_SWEEP_MINUTES, parsed: default 10, never under 2, never over a day. */
export function sweepMinutes(): number {
  const n = Number.parseInt(process.env.UNDERSTANDING_SWEEP_MINUTES ?? "", 10);
  if (!Number.isFinite(n)) return DEFAULT_SWEEP_MINUTES;
  return Math.min(MAX_SWEEP_MINUTES, Math.max(MIN_SWEEP_MINUTES, n));
}

export function understandingDisabled(): boolean {
  return process.env.UNDERSTANDING_DISABLED === "true";
}

export type UnderstandingProvider = "anthropic" | "openai" | "none";

/**
 * Whether the user has connected their own Claude account: anthropicFor
 * (lib/anthropic.ts) tries that before the house key, so a run can succeed
 * with no ANTHROPIC_API_KEY at all, and Settings must not say otherwise.
 * One indexed read; no client is built and nothing is decrypted.
 */
export async function hasConnectedAnthropic(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "anthropic")))
    .limit(1);
  return row !== undefined;
}

/**
 * Which provider a run would use: the same choice modelCallFor makes
 * (run.ts) from the environment and, when the caller passes it, the user's
 * connected Claude account (hasConnectedAnthropic above). What it cannot
 * see is the hour-long preference for OpenAI after a Claude failure, which
 * only a real call knows. Nothing is called.
 */
export function describeProvider(
  opts: { connectedAnthropic?: boolean } = {}
): { provider: UnderstandingProvider; model: string | null } {
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY) || opts.connectedAnthropic === true;
  const hasOpenai = Boolean(process.env.OPENAI_API_KEY);
  const claude = {
    provider: "anthropic" as const,
    model: process.env.UNDERSTANDING_MODEL ?? DEFAULT_MODEL,
  };
  const openai = {
    provider: "openai" as const,
    model: process.env.UNDERSTANDING_OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
  };
  const none = { provider: "none" as const, model: null };
  switch (process.env.UNDERSTANDING_PROVIDER) {
    case "anthropic":
      return hasClaude ? claude : none;
    case "openai":
      return hasOpenai ? openai : none;
    default:
      return hasClaude ? claude : hasOpenai ? openai : none;
  }
}

// --------------------------------------------------------------------------
// Tallying
// --------------------------------------------------------------------------

export type SweepTally = { ran: number; skipped: number; failed: number };

/** ok -> ran, skipped -> skipped, failed -> failed. A dry result is never produced by a sweep. */
export function tallyResults(results: Record<string, RunResult>): SweepTally {
  const tally: SweepTally = { ran: 0, skipped: 0, failed: 0 };
  for (const r of Object.values(results)) {
    if (r.status === "ok") tally.ran++;
    else if (r.status === "skipped") tally.skipped++;
    else if (r.status === "failed") tally.failed++;
  }
  return tally;
}

// --------------------------------------------------------------------------
// The sweep
// --------------------------------------------------------------------------

export type SweepResult = SweepTally & {
  users: number;
  retiredAsr: number;
  /** Open questions dismissed as the duplicate of an older one carrying the same words (questions.ts healDuplicates). */
  healed: number;
};

const ZERO: SweepResult = { users: 0, ran: 0, skipped: 0, failed: 0, retiredAsr: 0, healed: 0 };

/**
 * Module-level on purpose: one process, one sweep at a time. runAll holds a
 * latch per user; this one is for the whole pass, so a slow sweep and the
 * next tick never gather the same users twice.
 */
let inFlight = false;

export type SweepOptions = {
  now?: Date;
  model?: ModelCall;
  /**
   * Tests only: sweep these users and nobody else. Without it the sweep is
   * every user who owns an active project, which under vitest would be every
   * test file's throwaway user at once, and the developer's own local data.
   */
  userIds?: string[];
};

/**
 * One pass over every user who owns at least one active project. Returns
 * zeros without a query when UNDERSTANDING_DISABLED is set, or while another
 * sweep is in flight. A user with no model available (no key, no connected
 * account) is counted and skipped whole, rather than logging a "no-model"
 * row per project every few minutes; the ASR retire still runs for them,
 * because it needs no model.
 */
export async function sweepUnderstanding(opts: SweepOptions = {}): Promise<SweepResult> {
  if (understandingDisabled()) return { ...ZERO };
  if (inFlight) return { ...ZERO };
  inFlight = true;
  try {
    return await sweepOnce(opts);
  } finally {
    inFlight = false;
  }
}

async function sweepOnce(opts: SweepOptions): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  // One query: the users with an active project, with the timezone each
  // run resolves "today" against.
  const owners = await db
    .selectDistinct({ id: user.id, timezone: user.timezone })
    .from(user)
    .innerJoin(projects, and(eq(projects.userId, user.id), eq(projects.status, "active")))
    .where(opts.userIds ? inArray(user.id, opts.userIds) : undefined);

  const total: SweepResult = { ...ZERO, users: owners.length };
  for (const owner of owners) {
    // Before the model, and whether or not there is one: a standing pair of
    // same-text rows (the doubled questions on the user's phone) is healed
    // by the sweep itself, not by a run that may never come.
    total.healed += (await healDuplicates(owner.id, now)).length;
    const model = opts.model ?? (await modelCallFor(owner.id));
    if (!model) {
      // No model, no runs, but the retire is part of every sweep (SPEC §8:
      // "then retire ASR clarifications confirmed by use"; §5: the first
      // pass dismisses the ASR rows). It lives inside runAll, so it has to
      // be called here on its own or a keyless deployment would keep every
      // ASR row in the pause flow until someone pressed Understand now.
      total.retiredAsr += await retireAsrClarifications(owner.id, { now });
      continue;
    }
    const { results, retiredAsr } = await runAll(owner.id, {
      timezone: owner.timezone || "UTC",
      now,
      model,
      // The sweep is the only caller that would otherwise retry a failing
      // project every ten minutes (run.ts FAILED_BACKOFF_MS).
      backoffAfterFailure: true,
    });
    const tally = tallyResults(results);
    total.ran += tally.ran;
    total.skipped += tally.skipped;
    total.failed += tally.failed;
    total.retiredAsr += retiredAsr;
  }

  // Quiet when nothing happened: the normal state of a sweep is every hash
  // matching, and a log line every ten minutes saying so would bury the
  // lines that matter.
  if (total.ran + total.failed + total.healed > 0) {
    console.log(
      `understanding: ${total.ran} ran, ${total.skipped} unchanged, ${total.failed} failed, ${total.healed} duplicate${total.healed === 1 ? "" : "s"} healed`
    );
  }
  return total;
}

// --------------------------------------------------------------------------
// Status, for Settings (app/api/understanding GET)
// --------------------------------------------------------------------------

export type ProjectRunStatus = {
  projectId: string;
  projectName: string;
  lastStatus: "ok" | "failed" | "skipped";
  /** ISO. */
  lastFinishedAt: string;
  lastModel: string | null;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastErrors: string[];
};

/**
 * The latest understanding_runs row per active project, one query (DISTINCT
 * ON project_id, newest first). A project that has never run is not here;
 * the section says so.
 */
export async function latestRunPerProject(userId: string): Promise<ProjectRunStatus[]> {
  const rows = await db
    .selectDistinctOn([understandingRuns.projectId], {
      projectId: understandingRuns.projectId,
      projectName: projects.name,
      lastStatus: understandingRuns.status,
      lastFinishedAt: understandingRuns.finishedAt,
      lastModel: understandingRuns.model,
      lastInputTokens: understandingRuns.inputTokens,
      lastOutputTokens: understandingRuns.outputTokens,
      lastErrors: understandingRuns.errors,
    })
    .from(understandingRuns)
    .innerJoin(
      projects,
      and(eq(projects.id, understandingRuns.projectId), eq(projects.userId, userId))
    )
    .where(
      and(
        eq(understandingRuns.userId, userId),
        isNotNull(understandingRuns.projectId),
        eq(projects.status, "active")
      )
    )
    .orderBy(understandingRuns.projectId, desc(understandingRuns.startedAt));

  return rows
    .filter((r): r is typeof r & { projectId: string } => r.projectId !== null)
    .map((r) => ({
      projectId: r.projectId,
      projectName: r.projectName,
      lastStatus: r.lastStatus,
      lastFinishedAt: r.lastFinishedAt.toISOString(),
      lastModel: r.lastModel,
      lastInputTokens: r.lastInputTokens,
      lastOutputTokens: r.lastOutputTokens,
      lastErrors: r.lastErrors,
    }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/** Open or asked questions of the three understanding kinds. */
export async function openQuestionCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(clarifications)
    .where(
      and(
        eq(clarifications.userId, userId),
        inArray(clarifications.kind, [...QUESTION_KINDS]),
        inArray(clarifications.status, ["open", "asked"])
      )
    );
  return row?.n ?? 0;
}
