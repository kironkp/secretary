// Progress — docs/understanding/SPEC.md §8.
//
// What the understanding loop is doing right now, for the screen: an
// in-process channel keyed by user and project. The run (run.ts) publishes
// a phase at each step and finishes with what it found or why it could
// not; GET /api/understanding/progress returns a snapshot. Every human line
// is authored here, on the server, so the screen shows words and never
// composes them. Memory only: a restart forgets what was in flight, which
// is right, because nothing is.
import type { ProviderName } from "./provider-health";
import {
  classifyProviderError,
  joinClauses,
  outageClause,
  parseLoggedFailure,
  type FailureState,
} from "./provider-health";
import type { Bundle } from "./types";

export type Phase = "queued" | "gathering" | "reading" | "checking" | "storing";
export type FinishStatus = "ok" | "failed";
export type FailReason = "no-credits" | "capped" | "auth" | "validation" | "other";

export type ActiveEntry = {
  projectId: string;
  projectName: string;
  phase: Phase;
  line: string;
  detail: string | null;
  /** ISO. */
  startedAt: string;
  /** ISO. */
  updatedAt: string;
};

export type RecentEntry = {
  projectId: string;
  projectName: string;
  status: FinishStatus;
  line: string;
  detail: string | null;
  reason: FailReason | null;
  /** ISO. */
  finishedAt: string;
};

export type ProgressSnapshot = { active: ActiveEntry[]; recent: RecentEntry[] };

export type ProgressEvent = { userId: string; projectId: string } & (
  | { kind: "active"; entry: ActiveEntry }
  | { kind: "finished"; entry: RecentEntry }
  | { kind: "dropped" }
);

/** A finished run stays in the snapshot this long, and at most this many per user. */
export const RECENT_MS = 5 * 60_000;
export const RECENT_MAX = 20;

// --------------------------------------------------------------------------
// The channel
// --------------------------------------------------------------------------

let clock: () => number = Date.now;

/** Tests only: what "now" is; null puts the wall clock back. */
export function setProgressClock(now: (() => number) | null): void {
  clock = now ?? Date.now;
}

type Active = ActiveEntry & { startedMs: number };
type Recent = RecentEntry & { finishedMs: number };

/** userId → projectId → the run in flight. */
const active = new Map<string, Map<string, Active>>();
/** userId → finished runs, newest first. */
const recent = new Map<string, Recent[]>();
/** `${userId}:${projectId}` → the project's name as last published, for a line before a gather. */
const names = new Map<string, string>();
const listeners = new Set<(event: ProgressEvent) => void>();

/** Every publish, finish and drop, as it happens; returns the unsubscribe. */
export function subscribeProgress(listener: (event: ProgressEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: ProgressEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // a listener's trouble is not the run's
    }
  }
}

/** The contract's shapes, without the ms the channel keeps for itself. */
const toActive = (e: Active): ActiveEntry => ({
  projectId: e.projectId,
  projectName: e.projectName,
  phase: e.phase,
  line: e.line,
  detail: e.detail,
  startedAt: e.startedAt,
  updatedAt: e.updatedAt,
});
const toRecent = (r: Recent): RecentEntry => ({
  projectId: r.projectId,
  projectName: r.projectName,
  status: r.status,
  line: r.line,
  detail: r.detail,
  reason: r.reason,
  finishedAt: r.finishedAt,
});

/** The project's phase right now. startedAt is the first publish of this run. */
export function publish(
  userId: string,
  projectId: string,
  projectName: string,
  phase: Phase,
  line: string,
  detail: string | null = null
): ActiveEntry {
  const now = clock();
  const iso = new Date(now).toISOString();
  const byProject = active.get(userId) ?? new Map<string, Active>();
  const previous = byProject.get(projectId);
  const startedMs = previous?.startedMs ?? now;
  const entry: Active = {
    projectId,
    projectName,
    phase,
    line,
    detail,
    startedAt: previous?.startedAt ?? iso,
    updatedAt: iso,
    startedMs,
  };
  byProject.set(projectId, entry);
  active.set(userId, byProject);
  names.set(`${userId}:${projectId}`, projectName);
  const out = toActive(entry);
  emit({ userId, projectId, kind: "active", entry: out });
  return out;
}

/** The run ended: out of active, into the ring. */
export function finish(
  userId: string,
  projectId: string,
  projectName: string,
  status: FinishStatus,
  line: string,
  detail: string | null,
  reason: FailReason | null
): RecentEntry {
  const now = clock();
  active.get(userId)?.delete(projectId);
  names.set(`${userId}:${projectId}`, projectName);
  const entry: Recent = {
    projectId,
    projectName,
    status,
    line,
    detail,
    reason: status === "failed" ? reason : null,
    finishedAt: new Date(now).toISOString(),
    finishedMs: now,
  };
  const ring = [entry, ...(recent.get(userId) ?? [])]
    .filter((r) => now - r.finishedMs < RECENT_MS)
    .slice(0, RECENT_MAX);
  recent.set(userId, ring);
  const out = toRecent(entry);
  emit({ userId, projectId, kind: "finished", entry: out });
  return out;
}

/** The run ended without a result to show (it skipped): out of active, nothing in the ring. */
export function drop(userId: string, projectId: string): void {
  if (active.get(userId)?.delete(projectId)) emit({ userId, projectId, kind: "dropped" });
}

/** The project's name as last published, for a line before its bundle is gathered. */
export function nameOf(userId: string, projectId: string): string | null {
  return names.get(`${userId}:${projectId}`) ?? null;
}

/** The contract's { active, recent }: active oldest first, recent newest first and under five minutes old. */
export function snapshot(userId: string): ProgressSnapshot {
  const now = clock();
  const activeEntries = [...(active.get(userId)?.values() ?? [])]
    .sort((a, b) => a.startedMs - b.startedMs)
    .map(toActive);
  const recentEntries = (recent.get(userId) ?? [])
    .filter((r) => now - r.finishedMs < RECENT_MS)
    .map(toRecent);
  return { active: activeEntries, recent: recentEntries };
}

/** Tests only: forget everything. */
export function resetProgress(): void {
  active.clear();
  recent.clear();
  names.clear();
}

// --------------------------------------------------------------------------
// The lines — every user-facing sentence about a run, in one place
// --------------------------------------------------------------------------

export const CHECKING_LINE = "Checking what it wrote";
export const STORING_LINE = "Writing the record";

const KNOWN_MODELS: Record<string, string> = {
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-5": "Claude Opus 5",
  "claude-fable-5": "Claude Fable 5",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4-mini": "GPT-5.4 mini",
  "gpt-5.4-nano": "GPT-5.4 nano",
};

/** "claude-sonnet-5" → "Claude Sonnet 5", "gpt-5.5" → "GPT-5.5"; an unknown id reads as itself. */
export function displayModelName(id: string): string {
  const known = KNOWN_MODELS[id];
  if (known) return known;
  const claude = /^claude-(.+)$/.exec(id);
  if (claude) {
    return `Claude ${claude[1]
      .split("-")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")}`;
  }
  const gpt = /^gpt-(.+)$/.exec(id);
  if (gpt) return `GPT-${gpt[1]}`;
  return id;
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "Reading Caltrans" — "4 tasks, 4 messages, 2 memories, 2 events, 1 expectation" (the last two only when there are any). */
export function gatheringLines(
  projectName: string,
  bundle: Pick<Bundle, "tasksOpen" | "tasksDone" | "messages" | "memories" | "events" | "expectations">
): { line: string; detail: string } {
  const parts = [
    n(bundle.tasksOpen.length + bundle.tasksDone.length, "task"),
    n(bundle.messages.length, "message"),
    n(bundle.memories.length, "memory", "memories"),
  ];
  if (bundle.events.length > 0) parts.push(n(bundle.events.length, "event"));
  if (bundle.expectations.length > 0) parts.push(n(bundle.expectations.length, "expectation"));
  return { line: `Reading ${projectName}`, detail: parts.join(", ") };
}

/** "Thinking with Claude Sonnet 5" — "attempt 2 of 2" on a retry; "Thinking" when the call names no model. */
export function readingLines(
  modelId: string | undefined,
  attempt: number,
  maxAttempts: number
): { line: string; detail: string | null } {
  return {
    line: modelId ? `Thinking with ${displayModelName(modelId)}` : "Thinking",
    detail: attempt > 0 ? `attempt ${attempt + 1} of ${maxAttempts}` : null,
  };
}

/** "Read Caltrans" — "2 new questions, 1 updated" or "nothing new to ask". */
export function okLines(
  projectName: string,
  counts: { created: number; updated?: number; dismissed?: number; skippedSettled?: number }
): { line: string; detail: string } {
  const parts: string[] = [];
  if (counts.created > 0) parts.push(n(counts.created, "new question"));
  if ((counts.updated ?? 0) > 0) parts.push(`${counts.updated} updated`);
  if ((counts.dismissed ?? 0) > 0) parts.push(`${counts.dismissed} dismissed`);
  if ((counts.skippedSettled ?? 0) > 0) parts.push(`${counts.skippedSettled} already settled`);
  return { line: `Read ${projectName}`, detail: parts.length ? parts.join(", ") : "nothing new to ask" };
}

export type FailedLines = { line: string; detail: string; reason: FailReason };

const REASON_OF: Record<Exclude<FailureState, "other">, FailReason> = {
  "no-credits": "no-credits",
  capped: "capped",
  auth: "auth",
};

/**
 * "Could not read Caltrans" with why, from a failed run's logged errors: a
 * log that is provider failures only (every line carries
 * MODEL_ERROR_PREFIX; run.ts failedAtProvider says the same) is the
 * provider's own trouble, worded per provider — "the Claude limit resets on
 * October 1 and OpenAI has no credits" — or as "the model" when only one is
 * named; anything else is the validator's, and reads as "the model's answer
 * did not check out".
 */
export function failedLines(projectName: string, errors: string[]): FailedLines {
  const line = `Could not read ${projectName}`;
  if (errors.length === 0) return { line, detail: "something went wrong", reason: "other" };
  const failures = errors.map(parseLoggedFailure);
  if (failures.some((f) => f === null)) {
    return { line, detail: "the model's answer did not check out", reason: "validation" };
  }
  // The last word per provider, in provider order; the reason is the first
  // failure logged that says anything (the call that finally threw).
  const byProvider = new Map<ProviderName | null, { state: FailureState; until: Date | null }>();
  let reason: FailReason = "other";
  for (const f of failures) {
    if (!f) continue;
    const c = classifyProviderError(f.message);
    byProvider.set(f.provider, c);
    if (reason === "other" && c.state !== "other") reason = REASON_OF[c.state];
  }
  const named = [...byProvider.entries()].filter(([, c]) => c.state !== "other");
  if (named.length === 0) return { line, detail: "the model did not answer", reason: "other" };
  const order = (p: ProviderName | null) => (p === "anthropic" ? 0 : p === "openai" ? 1 : 2);
  named.sort(([a], [b]) => order(a) - order(b));
  const single = named.length === 1;
  const clauses = named.map(([p, c]) => outageClause(p ?? "openai", c, single || p === null));
  return { line, detail: joinClauses(clauses), reason };
}

/** A run that threw before it could say anything else (a database error in gather or the store). */
export function failedOtherLines(projectName: string): FailedLines {
  return { line: `Could not read ${projectName}`, detail: "something went wrong", reason: "other" };
}
