// Provider health — docs/understanding/SPEC.md §8.
//
// Whether the models a run would use can be used right now, and why not
// when they cannot. Nothing here calls a model. The memory is written by the
// calls themselves — run.ts callByProvider on every failure and success,
// the chat and voice routes on theirs — and read by every route that has to
// say why reading is paused rather than "try again". It is per process, so
// a fresh dyno reads the newest run rows of the user until a call of its
// own says otherwise; per key, so a house key over its cap says nothing
// about a key the user connected.
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { connectedAccounts, understandingRuns } from "@/lib/db/schema";
import type { KeySource } from "@/lib/anthropic";

export type ProviderName = "anthropic" | "openai";
export const PROVIDER_NAMES: readonly ProviderName[] = ["anthropic", "openai"];

/** What a failed call said about its key; "other" is a timeout, a refusal, a 500: nothing about the key. */
export type FailureState = "capped" | "no-credits" | "auth" | "other";
export type ProviderState = "ok" | "capped" | "no-credits" | "auth" | "missing" | "unknown";

export type ProviderStatus = {
  state: ProviderState;
  /** ISO, when a cap names the day it lifts. */
  until: string | null;
  /** A connected_accounts row for this provider exists for the user. */
  connected: boolean;
};

/** The contract's provider object (GET /api/understanding/progress). */
export type ProviderHealth = {
  /** At least one provider the setting allows has a key and no known reason to fail. */
  ok: boolean;
  /** "Reading is paused: the model has no credits." — null when ok. */
  line: string | null;
  /** What to do about it — null when ok. */
  action: string | null;
  anthropic: ProviderStatus;
  openai: ProviderStatus;
};

/**
 * How a failure of the provider's own is marked in a run's logged errors,
 * apart from the validator's (run.ts reads it for the backoff, this module
 * to rebuild the memory after a restart). Lives here rather than in run.ts
 * so neither module has to import the other for a string.
 */
export const MODEL_ERROR_PREFIX = "model: ";
/** The prefix an older run.ts wrote; rows from before 2026-09-23 carry it. */
const LEGACY_MODEL_ERROR_PREFIX = "model call failed: ";

export const PROVIDER_ACTION = "Add credits, raise the limit, or connect your own key in Settings.";
const AUTH_ACTION = "Check the key in Settings, or connect another.";
const NO_KEY_ACTION = "Connect your own key in Settings.";

// --------------------------------------------------------------------------
// Reading what a provider said
// --------------------------------------------------------------------------

/** Anthropic's cap message: "You will regain access on 2026-10-01 at 00:00 UTC." */
const REGAIN_ACCESS =
  /regain access on (\d{4})-(\d{2})-(\d{2})(?:(?: at|T) ?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:UTC|Z)?)?/i;

/**
 * What an error message from either SDK says about the key. The SDKs put
 * the HTTP status first ("429 You have no credits remaining…", "400 {…}"),
 * so a 401 or 403 is a refused key before anything else is read; a cap
 * with a date parses it (UTC), a cap without one is still a cap.
 */
export function classifyProviderError(message: string): { state: FailureState; until: Date | null } {
  const text = message.trim();
  const status = /^(\d{3})\b/.exec(text)?.[1];
  const lower = text.toLowerCase();
  if (
    status === "401" ||
    status === "403" ||
    /invalid (?:x-)?api[ _-]?key|incorrect api key|invalid_api_key|authentication_error|permission_error|unauthori[sz]ed/.test(
      lower
    )
  ) {
    return { state: "auth", until: null };
  }
  if (
    /no credits|credit balance|insufficient[_ ]quota|exceeded your current quota|add credits|purchase credits/.test(
      lower
    )
  ) {
    return { state: "no-credits", until: null };
  }
  const m = REGAIN_ACCESS.exec(text);
  if (m) {
    const until = new Date(
      Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        m[4] ? Number(m[4]) : 0,
        m[5] ? Number(m[5]) : 0,
        m[6] ? Number(m[6]) : 0
      )
    );
    return { state: "capped", until: Number.isNaN(until.getTime()) ? null : until };
  }
  if (/usage limits?|spend(?:ing)? limit|monthly limit|regain access/.test(lower)) {
    return { state: "capped", until: null };
  }
  return { state: "other", until: null };
}

/**
 * Which provider an error message came from, by its wording, for an error
 * nothing tagged: a fake in a test, a client used outside callByProvider,
 * a run row logged before failures were tagged. Null when the words do not
 * say.
 */
export function guessProvider(message: string): ProviderName | null {
  const lower = message.toLowerCase();
  if (/openai|no credits remaining|exceeded your current quota|insufficient_quota|\bgpt-/.test(lower)) {
    return "openai";
  }
  if (/anthropic|claude|specified api usage limits|regain access|credit balance is too low/.test(lower)) {
    return "anthropic";
  }
  return null;
}

/** The provider a run row's `model` names ("claude-sonnet-5", "gpt-5.5"); null for a fake. */
export function providerOfModel(model: string | null | undefined): ProviderName | null {
  if (!model) return null;
  if (model.startsWith("claude")) return "anthropic";
  if (/^(gpt|o\d)/.test(model)) return "openai";
  return null;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --------------------------------------------------------------------------
// The memory
// --------------------------------------------------------------------------

export type ProviderNote = {
  state: Exclude<ProviderState, "missing">;
  until: Date | null;
  /** What the provider said, for the log; null after a success. */
  message: string | null;
  /** When it was noted, ms. */
  at: number;
};

/** `${provider}:${source}` → the last thing that key did. One per process. */
const memory = new Map<string, ProviderNote>();

const keyOf = (provider: ProviderName, source: KeySource) => `${provider}:${source}`;

/**
 * A call on this key failed. A failure that says something about the key
 * (a cap, no credits, a refused key) is what the memory keeps; a failure
 * that says nothing (a timeout, a refusal, output that was not JSON) leaves
 * a standing note alone and only marks a key nothing was known about as
 * unknown. Returns the classification for the caller's own line.
 */
export function noteProviderFailure(
  provider: ProviderName,
  message: string,
  source: KeySource = "house"
): { state: FailureState; until: Date | null } {
  const c = classifyProviderError(message);
  const key = keyOf(provider, source);
  if (c.state === "other") {
    if (!memory.has(key)) memory.set(key, { state: "unknown", until: null, message, at: Date.now() });
    return c;
  }
  memory.set(key, { state: c.state, until: c.until, message, at: Date.now() });
  return c;
}

/** A call on this key returned: whatever was noted about it no longer holds. */
export function noteProviderOk(provider: ProviderName, source: KeySource = "house"): void {
  memory.set(keyOf(provider, source), { state: "ok", until: null, message: null, at: Date.now() });
}

/** What the memory holds for this key, if anything. */
export function providerNote(provider: ProviderName, source: KeySource = "house"): ProviderNote | undefined {
  return memory.get(keyOf(provider, source));
}

/** Tests only: forget every note. */
export function resetProviderMemory(): void {
  memory.clear();
}

// --------------------------------------------------------------------------
// Failures carried on errors, so the run can log which provider said what
// --------------------------------------------------------------------------

export type ProviderFailure = {
  /** Null when nothing tagged the error and its wording does not say. */
  provider: ProviderName | null;
  source: KeySource;
  message: string;
};

type Tagged = { providerFailures?: ProviderFailure[] };

/**
 * Mark an error thrown by a provider's call with the provider and key it
 * came from (run.ts callByProvider does this at the throw site), so the run
 * that catches it can log "openai: 429 …" rather than a bare message. The
 * error object is the carrier: the same one propagates through
 * withFallback, and a fallback that fails too adds the first road's
 * failure to the second's error.
 */
export function tagProviderFailure(e: unknown, failure: ProviderFailure): void {
  if (typeof e !== "object" || e === null) return;
  const tagged = e as Tagged;
  (tagged.providerFailures ??= []).push(failure);
}

/**
 * The provider failures behind an error the run caught. A tagged error was
 * noted in the memory where it was thrown; an untagged one (a fake, a
 * client used directly) is attributed by its wording and noted here, since
 * nothing else has seen it.
 */
export function recordProviderError(e: unknown): ProviderFailure[] {
  const tagged = typeof e === "object" && e !== null ? (e as Tagged).providerFailures : undefined;
  if (tagged && tagged.length > 0) return tagged;
  const message = errorMessage(e);
  const provider = guessProvider(message);
  if (provider) noteProviderFailure(provider, message, "house");
  return [{ provider, source: "house", message }];
}

/** How a failure reads in a run's logged errors, after MODEL_ERROR_PREFIX: "openai: 429 …". */
export function failureLogLine(f: ProviderFailure): string {
  return f.provider ? `${f.provider}: ${f.message}` : f.message;
}

/**
 * A logged run error read back: null for a validator's line, else the
 * provider (tagged, or guessed for an older row) and what it said.
 */
export function parseLoggedFailure(entry: string): { provider: ProviderName | null; message: string } | null {
  let rest: string;
  if (entry.startsWith(MODEL_ERROR_PREFIX)) rest = entry.slice(MODEL_ERROR_PREFIX.length);
  else if (entry.startsWith(LEGACY_MODEL_ERROR_PREFIX)) rest = entry.slice(LEGACY_MODEL_ERROR_PREFIX.length);
  else return null;
  const tag = /^(anthropic|openai): /.exec(rest);
  if (tag) return { provider: tag[1] as ProviderName, message: rest.slice(tag[0].length) };
  return { provider: guessProvider(rest), message: rest };
}

// --------------------------------------------------------------------------
// Words
// --------------------------------------------------------------------------

/** "October 1", in UTC, since the cap's date is given in UTC. */
export function resetDay(until: Date | string): string {
  const d = typeof until === "string" ? new Date(until) : until;
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(d);
}

/**
 * One clause about one provider's state, for a sentence: "the Claude limit
 * resets on October 1", "OpenAI has no credits", "the OpenAI key was
 * refused". With `single` the provider is not named ("the model has no
 * credits"): there is only one it could be.
 */
export function outageClause(
  provider: ProviderName,
  status: { state: ProviderState | FailureState; until: Date | string | null },
  single: boolean
): string {
  const name = provider === "anthropic" ? "Claude" : "OpenAI";
  switch (status.state) {
    case "capped": {
      const day = status.until ? resetDay(status.until) : null;
      if (single) return day ? `the model's limit resets on ${day}` : "the model is over its limit";
      return day ? `the ${name} limit resets on ${day}` : `${name} is over its limit`;
    }
    case "no-credits":
      return `${single ? "the model" : name} has no credits`;
    case "auth":
      return `${single ? "the model's" : `the ${name}`} key was refused`;
    case "missing":
      return `${single ? "the model" : name} has no key`;
    default:
      return `${single ? "the model" : name} is not answering`;
  }
}

/** "a", "a and b", "a, b and c". */
export function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? "";
  return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
}

/**
 * A route's own sentence about one failed call: "The secretary could not
 * respond: OpenAI has no credits. Add credits, raise the limit, or connect
 * your own key in Settings." Null when the failure says nothing about the
 * key, so the route keeps its usual text.
 */
export function outageLine(
  prefix: string,
  provider: ProviderName,
  failure: { state: FailureState; until: Date | null }
): string | null {
  if (failure.state === "other") return null;
  const action = failure.state === "auth" ? AUTH_ACTION : PROVIDER_ACTION;
  return `${prefix}: ${outageClause(provider, failure, false)}. ${action}`;
}

// --------------------------------------------------------------------------
// The user's health
// --------------------------------------------------------------------------

/** The providers UNDERSTANDING_PROVIDER lets a run use (run.ts callByProvider). */
export function allowedProviders(): ProviderName[] {
  const env = process.env.UNDERSTANDING_PROVIDER;
  if (env === "anthropic") return ["anthropic"];
  if (env === "openai") return ["openai"];
  return ["anthropic", "openai"];
}

const usable = (s: ProviderStatus) => s.state === "ok" || s.state === "unknown";

/**
 * ok, line and action from the two statuses: pure, so a test can hand it
 * states. Reading is paused when no allowed provider with a key is usable;
 * the line names each keyed provider's trouble, or says "the model" when
 * only one has a key at all.
 */
export function describeHealth(statuses: Record<ProviderName, ProviderStatus>): ProviderHealth {
  const allowed = allowedProviders();
  const keyed = allowed.filter((p) => statuses[p].state !== "missing");
  if (keyed.some((p) => usable(statuses[p]))) {
    return { ok: true, line: null, action: null, ...statuses };
  }
  if (keyed.length === 0) {
    return { ok: false, line: "Reading is paused: no model is connected.", action: NO_KEY_ACTION, ...statuses };
  }
  const single = keyed.length === 1;
  const clauses = keyed.map((p) => outageClause(p, statuses[p], single));
  const allAuth = keyed.every((p) => statuses[p].state === "auth");
  return {
    ok: false,
    line: `Reading is paused: ${joinClauses(clauses)}.`,
    action: allAuth ? AUTH_ACTION : PROVIDER_ACTION,
    ...statuses,
  };
}

const RUNS_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const RUNS_LOOKBACK_ROWS = 20;

/**
 * What the newest run rows say about each provider, for a process whose
 * memory is empty: walking newest first, the first row with evidence about
 * a provider decides — an ok row names the model that answered, a failed
 * row's errors name (or, for older rows, imply) the provider that refused
 * and what it said. Nothing older than a week, nothing past 20 rows.
 */
async function notesFromRuns(userId: string): Promise<Map<ProviderName, ProviderNote>> {
  const rows = await db
    .select({
      status: understandingRuns.status,
      model: understandingRuns.model,
      errors: understandingRuns.errors,
      finishedAt: understandingRuns.finishedAt,
    })
    .from(understandingRuns)
    .where(
      and(
        eq(understandingRuns.userId, userId),
        inArray(understandingRuns.status, ["ok", "failed"]),
        gte(understandingRuns.finishedAt, new Date(Date.now() - RUNS_LOOKBACK_MS))
      )
    )
    .orderBy(desc(understandingRuns.startedAt))
    .limit(RUNS_LOOKBACK_ROWS);

  const notes = new Map<ProviderName, ProviderNote>();
  for (const row of rows) {
    const at = row.finishedAt.getTime();
    if (row.status === "ok") {
      const p = providerOfModel(row.model);
      if (p && !notes.has(p)) notes.set(p, { state: "ok", until: null, message: null, at });
      continue;
    }
    for (const entry of row.errors ?? []) {
      const parsed = parseLoggedFailure(entry);
      if (!parsed?.provider || notes.has(parsed.provider)) continue;
      const c = classifyProviderError(parsed.message);
      if (c.state === "other") continue;
      notes.set(parsed.provider, { state: c.state, until: c.until, message: parsed.message, at });
    }
  }
  return notes;
}

/**
 * The contract's provider object for one user. Per provider: "missing"
 * with neither an env key nor a connected one; else the memory's note for
 * the key this user would use, or the run rows' when the memory has none;
 * else "unknown". A cap whose day has passed is unknown again, not capped.
 * Two small queries at most: the user's connected accounts, and the run
 * rows only when the memory is empty for a key.
 */
export async function providerHealth(userId: string): Promise<ProviderHealth> {
  const rows = await db
    .select({ provider: connectedAccounts.provider, keyTail: connectedAccounts.keyTail })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.userId, userId));
  const tailOf = (p: ProviderName) => rows.find((r) => r.provider === p)?.keyTail ?? null;
  const envKey = (p: ProviderName) =>
    Boolean(p === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY);

  let fromRuns: Map<ProviderName, ProviderNote> | null = null;
  const statusOf = async (p: ProviderName): Promise<ProviderStatus> => {
    const tail = tailOf(p);
    const connected = tail !== null;
    const source: KeySource | null = tail ? `connected:${tail}` : envKey(p) ? "house" : null;
    if (!source) return { state: "missing", until: null, connected };
    let note = memory.get(keyOf(p, source));
    if (!note) {
      fromRuns ??= await notesFromRuns(userId);
      note = fromRuns.get(p);
    }
    if (!note) return { state: "unknown", until: null, connected };
    const expired = note.state === "capped" && note.until !== null && note.until.getTime() <= Date.now();
    const state: ProviderState = expired ? "unknown" : note.state;
    return {
      state,
      until: state === "capped" && note.until ? note.until.toISOString() : null,
      connected,
    };
  };

  const anthropic = await statusOf("anthropic");
  const openai = await statusOf("openai");
  return describeHealth({ anthropic, openai });
}

/** The line a route shows when reading is paused, or null when it is not. */
export async function providerLine(userId: string): Promise<string | null> {
  return (await providerHealth(userId)).line;
}
