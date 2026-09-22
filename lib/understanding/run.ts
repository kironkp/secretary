// The run — docs/understanding/SPEC.md §4 and §8.
//
// One model call per project whose inputs changed. The shape of a run never
// varies: gather, hash, compare, call, validate (retry once with the errors
// quoted), store. The model is an injected function so every test passes a
// fake and nothing here can reach a live model under vitest; the real one is
// whatever modelCallFor resolves — Claude, OpenAI, or Claude with OpenAI as
// the fallback. Storage is the only side effect, and it happens only after
// validation has passed: a failed run leaves the previous record, its
// questions and its words exactly as they were.
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { db } from "@/lib/db";
import { records, understandingRuns } from "@/lib/db/schema";
import { anthropicFor, BRAIN_EFFORTS, type BrainEffort } from "@/lib/anthropic";
import { recordUsage } from "@/lib/usage";
import { gatherAll, gatherProject, hashBundle } from "./gather";
import { modelOutputSchema, renderBundle, toRunOutput, UNDERSTANDING_SYSTEM } from "./prompt";
import { questionIdentity, rankDraft, retireAsrClarifications, syncQuestions } from "./questions";
import type { Bundle, ProjectRecord, RunOutput } from "./types";
import { validateRunOutput } from "./validate";

// --------------------------------------------------------------------------
// The model
// --------------------------------------------------------------------------

export type ModelCall = (input: {
  system: string;
  user: string;
  bundle: Bundle;
  /** 0 on the first call; 1 on the retry, with previousErrors filled. */
  attempt: number;
  previousErrors: string[];
}) => Promise<{ output: unknown; model: string; inputTokens: number; outputTokens: number }>;

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_EFFORT: BrainEffort = "medium";
const MAX_TOKENS = 16000;

const isEffort = (v: string | undefined): v is BrainEffort =>
  v !== undefined && (BRAIN_EFFORTS as readonly string[]).includes(v);

/**
 * The retry's addendum (SPEC §4 step 1: "retried once with the error
 * quoted"). Appended to the user message, not the system prompt, so the
 * cached prefix survives the retry.
 */
export function rejectionAddendum(errors: string[]): string {
  return (
    "\n\nYour previous output was rejected for these reasons; fix them and answer again:\n" +
    errors.map((e) => `- ${e}`).join("\n")
  );
}

/**
 * The wire schema, built once. Only zodOutputFormat's JSON schema is sent,
 * and the call below is messages.create rather than messages.parse, on
 * purpose: the wire schema demotes every enum to a description (the API does
 * not enforce op, kind, confidence or recurrence), so a wrong value would
 * make the SDK's own parse throw from inside the call — losing the response
 * and its usage, and handing the retry a ZodError dump instead of the
 * validator's path-and-rule message (SPEC §4 step 1: "retried once with the
 * error quoted"). The text comes back raw, is JSON-parsed here, and
 * validateRunOutput is the one that says what is wrong with it.
 */
const OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: zodOutputFormat(modelOutputSchema).schema,
};

/**
 * The production model: the user's Claude client (connected account or house
 * key) with structured output enforced by the API. Null when there is no
 * client, when UNDERSTANDING_DISABLED is set, or under vitest — a test that
 * wants a model passes one.
 */
export async function anthropicModelCall(userId: string): Promise<ModelCall | null> {
  if (process.env.UNDERSTANDING_DISABLED === "true") return null;
  if (process.env.VITEST) return null;
  const client = await anthropicFor(userId);
  if (!client) return null;

  const model = process.env.UNDERSTANDING_MODEL ?? DEFAULT_MODEL;
  const envEffort = process.env.UNDERSTANDING_EFFORT;
  const effort = isEffort(envEffort) ? envEffort : DEFAULT_EFFORT;

  return async ({ system, user, attempt, previousErrors }) => {
    const content = attempt > 0 ? user + rejectionAddendum(previousErrors) : user;
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      // The system prompt is identical for every project and every run; mark
      // it cacheable so a sweep over N projects pays for it once (SPEC §4).
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
      output_config: { effort, format: OUTPUT_FORMAT },
    });
    if (response.stop_reason === "refusal") throw new Error("claude refusal");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text.trim()) {
      throw new Error(`claude returned no text (stop_reason ${response.stop_reason})`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      // Almost always max_tokens cutting the JSON short; the retry quotes this.
      throw new Error(
        `claude output is not JSON (stop_reason ${response.stop_reason}): ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return {
      output: toRunOutput(json),
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  };
}

// --------------------------------------------------------------------------
// The OpenAI model, and choosing between the two
// --------------------------------------------------------------------------

const DEFAULT_OPENAI_MODEL = "gpt-5.5";
/** The Responses API's ladder for gpt-5.5 (lib/anthropic.ts CHAT_EFFORTS). */
const OPENAI_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
type OpenAIEffort = (typeof OPENAI_EFFORTS)[number];
const DEFAULT_OPENAI_EFFORT: OpenAIEffort = "medium";

const isOpenAIEffort = (v: string | undefined): v is OpenAIEffort =>
  v !== undefined && (OPENAI_EFFORTS as readonly string[]).includes(v);

/**
 * The same model-facing schema as the Anthropic call, in the Responses API's
 * shape. strict is off on purpose: strict mode demands every property be
 * required and additionalProperties false at every level, which the optional
 * fields (objective, nextAction, todayLine, quote) do not satisfy, and the
 * output is validated by validateRunOutput either way.
 */
const OPENAI_OUTPUT_SCHEMA = z.toJSONSchema(modelOutputSchema) as Record<string, unknown>;

/**
 * The OpenAI model on the house key. Null under the same guards as the
 * Anthropic call, and when there is no OPENAI_API_KEY. The same rules as
 * anthropicModelCall: raw text back, JSON-parsed here, validated by the run.
 */
export async function openaiModelCall(userId: string): Promise<ModelCall | null> {
  if (process.env.UNDERSTANDING_DISABLED === "true") return null;
  if (process.env.VITEST) return null;
  if (!process.env.OPENAI_API_KEY) return null;
  // The OpenAI path has no per-user key today; the parameter is the same
  // shape as anthropicModelCall so the two are interchangeable.
  void userId;
  // Lazy so this module stays importable with no key at all (lib/openai.ts
  // builds its client at import time).
  const { openai } = await import("@/lib/openai");

  const model = process.env.UNDERSTANDING_OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  const envEffort = process.env.UNDERSTANDING_OPENAI_EFFORT;
  const effort = isOpenAIEffort(envEffort) ? envEffort : DEFAULT_OPENAI_EFFORT;

  return async ({ system, user, attempt, previousErrors }) => {
    const input = attempt > 0 ? user + rejectionAddendum(previousErrors) : user;
    const response = await openai.responses.create({
      model,
      instructions: system,
      input,
      reasoning: { effort },
      text: {
        format: {
          type: "json_schema",
          name: "understanding",
          strict: false,
          schema: OPENAI_OUTPUT_SCHEMA,
        },
      },
    });
    const text = response.output_text ?? "";
    if (!text.trim()) throw new Error("openai returned no text");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(
        `openai output is not JSON: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return {
      output: toRunOutput(json),
      model,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
  };
}

/**
 * A ModelCall that tries `primary` and, when it THROWS — any error: an API
 * rejection, a refusal, output that is not JSON — calls `secondary` with the
 * same input. `onFallback` sees the error once per fallback. A primary that
 * returns is never second-guessed: an output that fails validation is the
 * run's retry to handle, not a reason to switch providers.
 */
export function withFallback(
  primary: ModelCall,
  secondary: ModelCall,
  onFallback?: (error: unknown) => void
): ModelCall {
  return async (input) => {
    try {
      return await primary(input);
    } catch (e) {
      onFallback?.(e);
      return secondary(input);
    }
  };
}

const PROVIDERS = ["anthropic", "openai", "auto"] as const;
type Provider = (typeof PROVIDERS)[number];
/** After a Claude failure, every run in this window goes to OpenAI first. */
const PREFER_OPENAI_MS = 60 * 60_000;
/** Module-level on purpose: one process, one memory of the last failure. */
let preferOpenaiUntil = 0;

/**
 * The production model for one user, by UNDERSTANDING_PROVIDER:
 *   anthropic  Claude or nothing.
 *   openai     OpenAI or nothing.
 *   auto       Claude with OpenAI behind it (the default). A Claude call that
 *              throws — the house key over its usage limit is a 400 — is
 *              answered by OpenAI on the same input, one console.warn is
 *              written, and OpenAI goes first for the next 60 minutes so a
 *              sweep over eight projects does not pay for eight rejections.
 *              With only one provider available, that one; null with neither.
 */
export async function modelCallFor(userId: string): Promise<ModelCall | null> {
  const env = process.env.UNDERSTANDING_PROVIDER;
  const provider: Provider = (PROVIDERS as readonly string[]).includes(env ?? "")
    ? (env as Provider)
    : "auto";
  if (provider === "anthropic") return anthropicModelCall(userId);
  if (provider === "openai") return openaiModelCall(userId);

  const [claude, gpt] = await Promise.all([anthropicModelCall(userId), openaiModelCall(userId)]);
  if (!claude) return gpt;
  if (!gpt) return claude;
  if (Date.now() < preferOpenaiUntil) return gpt;
  return withFallback(claude, gpt, (e) => {
    preferOpenaiUntil = Date.now() + PREFER_OPENAI_MS;
    console.warn(
      `understanding: claude call failed (${e instanceof Error ? e.message : String(e)}); using openai for the next 60 minutes`
    );
  });
}

// --------------------------------------------------------------------------
// Results
// --------------------------------------------------------------------------

export type RunResult =
  | {
      status: "ok";
      recordId: string;
      version: number;
      questions: { created: string[]; updated: string[]; dismissed: string[] };
      ledes: Record<string, string>;
      todayLine?: string;
      inputTokens: number;
      outputTokens: number;
    }
  | { status: "skipped"; reason: "unchanged" | "no-model" | "disabled" | "no-project" }
  | { status: "failed"; errors: string[] }
  | {
      /** opts.dryRun: the validated output, nothing written anywhere. */
      status: "dry";
      output: RunOutput;
      /** rankDraft for each of output.questions, in order. */
      ranks: number[];
      /** questionIdentity for each of output.questions, in order. */
      identities: string[];
      inputsHash: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
    };

export type RunOptions = {
  timezone: string;
  now?: Date;
  model?: ModelCall;
  /** Call the model even when the stored hash matches. */
  force?: boolean;
  /** A bundle already gathered (runAll hands these down); must be this project's. */
  bundle?: Bundle;
  /** Call and validate, then return without writing (scripts/understand.ts --dry). */
  dryRun?: boolean;
};

type RunLog = {
  userId: string;
  projectId: string | null;
  startedAt: Date;
  status: "ok" | "failed" | "skipped";
  reason?: string;
  inputsHash?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  errors?: string[];
};

/**
 * One row per run in understanding_runs (SPEC §8). Bookkeeping: losing a row
 * must never fail the run that produced it, but it should be loud.
 */
async function logRun(entry: RunLog): Promise<void> {
  try {
    await db.insert(understandingRuns).values({
      userId: entry.userId,
      projectId: entry.projectId,
      startedAt: entry.startedAt,
      finishedAt: new Date(),
      status: entry.status,
      reason: entry.reason ?? null,
      inputsHash: entry.inputsHash ?? null,
      model: entry.model ?? null,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
      errors: entry.errors ?? [],
    });
  } catch (e) {
    console.error(
      `understanding: failed to log run for project ${entry.projectId ?? "(none)"}:`,
      e instanceof Error ? e.message : e
    );
  }
}

// --------------------------------------------------------------------------
// One project
// --------------------------------------------------------------------------

const MAX_ATTEMPTS = 2;

export async function runProject(
  userId: string,
  projectId: string,
  opts: RunOptions
): Promise<RunResult> {
  const startedAt = new Date();
  const now = opts.now ?? new Date();
  if (opts.bundle && opts.bundle.project.id !== projectId) {
    return { status: "failed", errors: [`bundle is for project ${opts.bundle.project.id}, not ${projectId}`] };
  }
  try {
    return await runOnce(userId, projectId, opts, startedAt, now);
  } catch (e) {
    // Nothing is thrown out of a run: one project's trouble must not end the
    // sweep (SPEC §8) or leave it unlogged. A database error in gather, the
    // upsert or the question sync is a failed run like a rejected output —
    // one line in the log, one understanding_runs row, the previous record
    // untouched — and a dry run writes nothing even then.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`understanding: ${projectId} failed: ${message}`);
    if (!opts.dryRun) {
      await logRun({ userId, projectId, startedAt, status: "failed", errors: [message] });
    }
    return { status: "failed", errors: [message] };
  }
}

/** The run proper; runProject guards it. */
async function runOnce(
  userId: string,
  projectId: string,
  opts: RunOptions,
  startedAt: Date,
  now: Date
): Promise<RunResult> {
  // --- gather and compare --------------------------------------------------
  const bundle =
    opts.bundle ?? (await gatherProject(userId, projectId, { now, timezone: opts.timezone }));
  if (!bundle) {
    // A dry run writes nothing, a skip row included (scripts/understand.ts --dry).
    if (!opts.dryRun) {
      await logRun({ userId, projectId: null, startedAt, status: "skipped", reason: "no-project" });
    }
    return { status: "skipped", reason: "no-project" };
  }
  const inputsHash = hashBundle(bundle);

  const [previous] = await db
    .select({ inputsHash: records.inputsHash, body: records.body })
    .from(records)
    .where(and(eq(records.userId, userId), eq(records.projectId, projectId)))
    .limit(1);
  if (!opts.force && previous?.inputsHash === inputsHash) {
    // The sweep's normal state (SPEC §8); not logged, or the log would be
    // nothing but this.
    return { status: "skipped", reason: "unchanged" };
  }

  // --- the model -----------------------------------------------------------
  const model = opts.model ?? (await modelCallFor(userId));
  if (!model) {
    const reason = process.env.UNDERSTANDING_DISABLED === "true" ? "disabled" : "no-model";
    if (!opts.dryRun) {
      await logRun({ userId, projectId, startedAt, status: "skipped", reason, inputsHash });
    }
    return { status: "skipped", reason };
  }

  const user = renderBundle(bundle);
  let output: RunOutput | null = null;
  let errors: string[] = [];
  let modelId = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && !output; attempt++) {
    let result: Awaited<ReturnType<ModelCall>>;
    try {
      result = await model({
        system: UNDERSTANDING_SYSTEM,
        user,
        bundle,
        attempt,
        previousErrors: errors,
      });
    } catch (e) {
      // A throw is a failed attempt like any other; the retry quotes it.
      errors = [`model call failed: ${e instanceof Error ? e.message : String(e)}`];
      continue;
    }
    modelId = result.model;
    inputTokens += result.inputTokens;
    outputTokens += result.outputTokens;
    const validated = validateRunOutput(result.output, bundle);
    if (validated.ok) output = validated.value;
    else errors = validated.errors;
  }

  if (!output) {
    console.error(
      `understanding: ${bundle.project.name} (${projectId}) failed after ${MAX_ATTEMPTS} attempts: ${errors.join("; ")}`
    );
    if (!opts.dryRun) {
      await logRun({
        userId,
        projectId,
        startedAt,
        status: "failed",
        inputsHash,
        model: modelId || undefined,
        inputTokens,
        outputTokens,
        errors,
      });
    }
    return { status: "failed", errors };
  }

  if (opts.dryRun) {
    return {
      status: "dry",
      output,
      ranks: output.questions.map((q) => rankDraft(q, bundle)),
      identities: output.questions.map(questionIdentity),
      inputsHash,
      model: modelId,
      inputTokens,
      outputTokens,
    };
  }

  // --- store -----------------------------------------------------------------
  // The code owns `asked` (SPEC §5): it is the log of what was asked and what
  // the user said, written by the answer path, never by the model. Whatever
  // the model returned there is replaced with the stored list.
  const asked = previous?.body.asked ?? bundle.previousRecord?.asked ?? [];
  const body: ProjectRecord = { ...output.record, asked };
  const words = { todayLine: output.words.todayLine, ledes: output.words.ledes };

  const [stored] = await db
    .insert(records)
    .values({ userId, projectId, body, inputsHash, words, version: 1, updatedAt: now })
    .onConflictDoUpdate({
      target: [records.userId, records.projectId],
      set: {
        body,
        inputsHash,
        words,
        version: sql`${records.version} + 1`,
        updatedAt: now,
      },
    })
    .returning({ id: records.id, version: records.version });

  const questions = await syncQuestions(userId, projectId, output.questions, bundle);
  await recordUsage({ userId, kind: "understanding", model: modelId, inputTokens, outputTokens });
  await logRun({
    userId,
    projectId,
    startedAt,
    status: "ok",
    inputsHash,
    model: modelId,
    inputTokens,
    outputTokens,
  });

  return {
    status: "ok",
    recordId: stored.id,
    version: stored.version,
    questions,
    ledes: output.words.ledes,
    todayLine: output.words.todayLine,
    inputTokens,
    outputTokens,
  };
}

// --------------------------------------------------------------------------
// Every active project: the sweep (SPEC §8)
// --------------------------------------------------------------------------

export type RunAllResult = { results: Record<string, RunResult>; retiredAsr: number };

/**
 * One sweep per user at a time. A second runAll for the same user while one
 * is in flight returns empty at once rather than queueing: the sweep it would
 * have done is the one already running, and two of them would race on the
 * same records and questions.
 */
const inFlight = new Map<string, Promise<RunAllResult>>();

export async function runAll(
  userId: string,
  opts: { timezone: string; now?: Date; model?: ModelCall; force?: boolean; dryRun?: boolean }
): Promise<RunAllResult> {
  if (inFlight.has(userId)) return { results: {}, retiredAsr: 0 };

  const sweep = (async (): Promise<RunAllResult> => {
    const now = opts.now ?? new Date();
    // gatherAll reads the board, the memories and the messages once for every
    // project; the model is resolved once for the same reason.
    const bundles = await gatherAll(userId, { now, timezone: opts.timezone });
    const model = opts.model ?? (await modelCallFor(userId)) ?? undefined;

    const results: Record<string, RunResult> = {};
    for (const bundle of bundles) {
      results[bundle.project.id] = await runProject(userId, bundle.project.id, {
        timezone: opts.timezone,
        now,
        model,
        force: opts.force,
        bundle,
        dryRun: opts.dryRun,
      });
    }
    const retiredAsr = opts.dryRun ? 0 : await retireAsrClarifications(userId, { now });
    return { results, retiredAsr };
  })();

  inFlight.set(userId, sweep);
  try {
    return await sweep;
  } finally {
    inFlight.delete(userId);
  }
}
