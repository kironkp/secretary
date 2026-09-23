// The run — docs/understanding/SPEC.md §4 and §8.
//
// One model call per project whose inputs changed. The shape of a run never
// varies: gather, hash, compare, call, validate (up to three attempts, each
// quoting the errors of the one before), store. The model is an injected function so every test passes a
// fake and nothing here can reach a live model under vitest; the real one is
// whatever modelCallFor resolves — Claude, OpenAI, or Claude with OpenAI as
// the fallback. Storage is the only side effect, and it happens only after
// validation has passed: a failed run leaves the previous record, its
// questions and its words exactly as they were.
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { db } from "@/lib/db";
import { records, understandingRuns } from "@/lib/db/schema";
import { anthropicClientFor, BRAIN_EFFORTS, type BrainEffort, type KeySource } from "@/lib/anthropic";
import { recordUsage } from "@/lib/usage";
import { gatherAll, gatherProject, hashBundle } from "./gather";
import {
  CHECKING_LINE,
  STORING_LINE,
  drop,
  failedLines,
  failedOtherLines,
  finish,
  gatheringLines,
  nameOf,
  okLines,
  publish,
  readingLines,
  type Phase,
} from "./progress";
import {
  MODEL_ERROR_PREFIX,
  errorMessage,
  failureLogLine,
  noteProviderFailure,
  noteProviderOk,
  recordProviderError,
  taggedProviderFailures,
  tagProviderFailure,
  type ProviderName,
} from "./provider-health";
import {
  modelOutputSchema,
  renderBundle,
  toRunOutput,
  UNDERSTANDING_SYSTEM,
  type RunMode,
} from "./prompt";
import {
  questionIdentity,
  rankDraft,
  retireAsrClarifications,
  syncQuestions,
  type SyncResult,
} from "./questions";
import type { Bundle, ProjectRecord, RunOutput } from "./types";
import { repairIds, repairLine } from "./repair";
import { validateRunOutput } from "./validate";

// --------------------------------------------------------------------------
// The model
// --------------------------------------------------------------------------

/**
 * What a call knows about itself before it is made, for the progress line
 * ("Thinking with Claude Sonnet 5") and the provider memory (which key a
 * failure belongs to). All optional: a test's fake carries none, and the
 * run says "Thinking" and attributes a failure by its wording.
 */
export type CallMeta = {
  /** The model id the call would send: "claude-sonnet-5", "gpt-5.5". */
  modelName?: string;
  provider?: ProviderName;
  source?: KeySource;
};

export type ModelCall = ((input: {
  system: string;
  user: string;
  bundle: Bundle;
  /** 0 on the first call; 1 on the retry, with previousErrors filled. */
  attempt: number;
  previousErrors: string[];
}) => Promise<{
  output: unknown;
  model: string;
  /** Every input token billed, the cached prefix included. */
  inputTokens: number;
  /** The part of inputTokens served from the cache, billed at a tenth (lib/pricing.ts). */
  cachedInputTokens?: number;
  outputTokens: number;
}>) &
  CallMeta;

/**
 * Exported so Settings (lib/understanding/sweep.ts describeProvider) names
 * the same model a run would use.
 *
 * Opus at high effort, not Sonnet at medium, since 2026-09-23. Kiron's
 * words: "it's asked me about CPO 2110 like 10 times. It feels really
 * stupid. It's not thinking enough." Reading nine projects' worth of tasks,
 * messages and memories and noticing that a question has already been
 * settled in different words is the kind of work the deeper model is for,
 * and a run is hash-gated — it only happens when the data actually moved.
 * The measured cost goes from about $0.16 a run to about $0.50.
 */
export const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_EFFORT: BrainEffort = "high";
/**
 * Thinking counts against max_tokens when output_config.effort is set, and
 * a Sonnet 5 run at medium effort spent most of 16000 on it: the first
 * Caltrans dry run on 2026-09-23 had its JSON cut at 2,900 characters
 * (stop_reason max_tokens). Room for the thinking and a full record.
 */
const MAX_TOKENS = 32000;

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
 * The schema goes to Claude as text, not as an API-enforced format. The
 * API compiles a `format` into a grammar, and this schema (a record, words,
 * questions with a closed list of write ops) is over its size limit: on
 * 2026-09-23 every call was refused with "The compiled grammar is too
 * large". The schema in the cached system prompt costs its tokens once per
 * sweep, and validateRunOutput is the enforcement either way.
 */
const OUTPUT_FORMAT_TEXT =
  "\n\n## Output format\n" +
  "Reply with one JSON object and nothing else: no prose before or after it, no code fence. " +
  "It must match this JSON Schema:\n" +
  JSON.stringify(OUTPUT_FORMAT.schema);

/**
 * The model answered, and what it said was not the JSON asked for: text cut
 * short by max_tokens, a sentence around the object, a refusal, no text at
 * all. That is the validator's kind of failure, quoted back to the SAME
 * model on the next attempt; never a reason to switch providers, to count
 * against the provider's health, or to prefer the other road for an hour.
 * On 2026-09-23 one such answer did all three and ended a run as "the
 * model has no credits" while Claude was ready.
 */
export class ModelOutputError extends Error {
  /** What the answer cost, when the call knows: a refused answer is billed all the same. */
  readonly usage: CallUsage | null;
  /** Which provider gave the answer; tracked() fills it in. */
  provider: ProviderName | null = null;
  constructor(message: string, usage: CallUsage | null = null) {
    super(message);
    this.name = "ModelOutputError";
    this.usage = usage;
  }
}

/** The tokens one call was billed for, whatever came back. */
export type CallUsage = {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

/**
 * The JSON object in a model's text: the whole text when it is JSON, else
 * what lies between the first "{" and the last "}" (a code fence or a
 * sentence around the object is the usual noise). Throws like JSON.parse.
 */
export function jsonFromText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (first) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) throw first;
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

/**
 * The production model: the user's Claude client (connected account or house
 * key) with structured output enforced by the API. Null when there is no
 * client, when UNDERSTANDING_DISABLED is set, or under vitest — a test that
 * wants a model passes one.
 */
export async function anthropicModelCall(userId: string): Promise<ModelCall | null> {
  if (process.env.UNDERSTANDING_DISABLED === "true") return null;
  if (process.env.VITEST) return null;
  const resolved = await anthropicClientFor(userId);
  if (!resolved) return null;
  const { client, source } = resolved;

  const model = process.env.UNDERSTANDING_MODEL ?? DEFAULT_MODEL;
  const envEffort = process.env.UNDERSTANDING_EFFORT;
  const effort = isEffort(envEffort) ? envEffort : DEFAULT_EFFORT;

  const meta: CallMeta = { modelName: model, provider: "anthropic", source };
  return Object.assign(async ({ system, user, attempt, previousErrors }: Parameters<ModelCall>[0]) => {
    const content = attempt > 0 ? user + rejectionAddendum(previousErrors) : user;
    // Streamed, then read whole: the SDK refuses a plain create whose
    // max_tokens could take over ten minutes, and this one can.
    const response = await client.messages
      .stream({
        model,
        max_tokens: MAX_TOKENS,
        // The system prompt is identical for every project and every run; mark
        // it cacheable so a sweep over N projects pays for it once (SPEC §4).
        system: [
          { type: "text", text: system + OUTPUT_FORMAT_TEXT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content }],
        output_config: { effort },
      })
      .finalMessage();
    // input_tokens is the uncached part only: the system prompt and schema
    // this call marks cacheable are billed as cache_creation (the first
    // call) or cache_read (the rest) and are most of the prompt, so a row
    // counting input_tokens alone said a 30k-token call was 4k. Read before
    // the answer is judged: a refused answer was billed all the same.
    const usage = response.usage;
    const cached = usage.cache_read_input_tokens ?? 0;
    const billed: CallUsage = {
      model,
      inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + cached,
      cachedInputTokens: cached,
      outputTokens: usage.output_tokens,
    };
    if (response.stop_reason === "refusal") throw new ModelOutputError("claude refusal", billed);
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text.trim()) {
      throw new ModelOutputError(`claude returned no text (stop_reason ${response.stop_reason})`, billed);
    }
    let json: unknown;
    try {
      json = jsonFromText(text);
    } catch (e) {
      // max_tokens cutting the JSON short, or a slip in it; the retry quotes this.
      throw new ModelOutputError(
        `claude output is not JSON (stop_reason ${response.stop_reason}): ${e instanceof Error ? e.message : String(e)}`,
        billed
      );
    }
    return { output: toRunOutput(json), ...billed };
  }, meta);
}

// --------------------------------------------------------------------------
// The OpenAI model, and choosing between the two
// --------------------------------------------------------------------------

/** Exported for the same reason as DEFAULT_MODEL. */
export const DEFAULT_OPENAI_MODEL = "gpt-5.5";
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
 * The OpenAI model on the user's key: their connected OpenAI account first,
 * then the house key (lib/openai.ts openaiClientFor). Null under the same
 * guards as the Anthropic call, and with neither key. The same rules as
 * anthropicModelCall: raw text back, JSON-parsed here, validated by the run.
 */
export async function openaiModelCall(userId: string): Promise<ModelCall | null> {
  if (process.env.UNDERSTANDING_DISABLED === "true") return null;
  if (process.env.VITEST) return null;
  // Lazy: lib/openai.ts builds the house client at import time.
  const { openaiClientFor } = await import("@/lib/openai");
  const resolved = await openaiClientFor(userId);
  if (!resolved) return null;
  const { client: openai, source } = resolved;

  const model = process.env.UNDERSTANDING_OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  const envEffort = process.env.UNDERSTANDING_OPENAI_EFFORT;
  const effort = isOpenAIEffort(envEffort) ? envEffort : DEFAULT_OPENAI_EFFORT;

  const meta: CallMeta = { modelName: model, provider: "openai", source };
  return Object.assign(async ({ system, user, attempt, previousErrors }: Parameters<ModelCall>[0]) => {
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
    // OpenAI's input_tokens is the whole prompt; cached_tokens the part
    // served from cache. Read before the answer is judged (see the Claude call).
    const billed: CallUsage = {
      model,
      inputTokens: response.usage?.input_tokens ?? 0,
      cachedInputTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    };
    if (!text.trim()) throw new ModelOutputError("openai returned no text", billed);
    let json: unknown;
    try {
      json = jsonFromText(text);
    } catch (e) {
      throw new ModelOutputError(
        `openai output is not JSON: ${e instanceof Error ? e.message : String(e)}`,
        billed
      );
    }
    return { output: toRunOutput(json), ...billed };
  }, meta);
}

/** Any call to a model: the run's ModelCall, or interpret.ts's InterpretCall. */
type Call<Input, Output> = (input: Input) => Promise<Output>;

/**
 * A call that tries `primary` and, when the ROAD is closed — an API
 * rejection, a cap, a timeout — calls `secondary` with the same input.
 * `onFallback` sees the error once per fallback. A primary that answers is
 * never second-guessed: an output that fails validation, or that is not
 * JSON at all (ModelOutputError), is the run's retry to handle with the
 * same model, not a reason to switch providers. Generic over the call's
 * shape so the one-sentence read in interpret.ts gets the same second road
 * as the run.
 */
export function withFallback<Input, Output>(
  primary: Call<Input, Output>,
  secondary: Call<Input, Output>,
  onFallback?: (error: unknown) => void,
  /** Asked before every call: true sends it straight to `secondary`. The
   *  run's own retry reuses one ModelCall, so a preference set by the first
   *  attempt's failure has to be read here, per call, not once when the
   *  wrapper is built — otherwise the retry pays for the same rejection. */
  preferSecondary?: () => boolean,
  /** The preferred secondary threw and the primary then answered: the preference was wrong. */
  onRecovered?: (secondaryError: unknown) => void,
  /** Both roads closed: the error about to propagate, and the other road's, so the log can name both. */
  onBothClosed?: (thrown: unknown, other: unknown) => void
): Call<Input, Output> {
  return async (input) => {
    if (preferSecondary?.()) {
      // The preferred road first, and the other one when it is closed too.
      // A window that sends every call to OpenAI must not strand the call
      // when OpenAI is the one that is down: on 2026-09-23 production had
      // Claude back and OpenAI at 429, and every sweep failed until the
      // hour passed. The primary's own error is the one that propagates.
      try {
        return await secondary(input);
      } catch (e) {
        if (e instanceof ModelOutputError) throw e;
        try {
          const out = await primary(input);
          onRecovered?.(e);
          return out;
        } catch (e2) {
          // Whatever the primary did, closed or a bad answer, the error
          // that propagates carries the secondary's failure too.
          onBothClosed?.(e2, e);
          throw e2;
        }
      }
    }
    try {
      return await primary(input);
    } catch (e) {
      // A bad answer is not a closed road: it goes back to the same model.
      if (e instanceof ModelOutputError) throw e;
      onFallback?.(e);
      try {
        return await secondary(input);
      } catch (e2) {
        onBothClosed?.(e2, e);
        throw e2;
      }
    }
  };
}

const PROVIDERS = ["anthropic", "openai", "auto"] as const;
type Provider = (typeof PROVIDERS)[number];
/** After a Claude failure, every run in this window goes to OpenAI first. */
const PREFER_OPENAI_MS = 60 * 60_000;
/**
 * Module-level on purpose: one process, one memory of the last failure —
 * per Claude key, so the house key over its cap sends nobody's connected
 * key to OpenAI.
 */
const preferOpenaiUntil = new Map<KeySource, number>();

/**
 * A call that tells the provider memory how it went: every return is
 * noted ok for its key, every throw noted as what it said and tagged with
 * the provider (provider-health.ts), so the run can log "openai: 429 …" and
 * the progress route can say why reading is paused. The call's own
 * metadata rides along.
 */
function tracked<Input, Output>(
  call: Call<Input, Output> & CallMeta,
  provider: ProviderName
): Call<Input, Output> & CallMeta {
  const source = call.source ?? "house";
  const fn = async (input: Input): Promise<Output> => {
    try {
      const out = await call(input);
      noteProviderOk(provider, source);
      return out;
    } catch (e) {
      if (e instanceof ModelOutputError) {
        // The provider answered; the answer was bad. The road is open, and
        // a standing note of a cap or empty credits is stale now.
        noteProviderOk(provider, source);
        e.provider ??= provider;
        throw e;
      }
      const message = errorMessage(e);
      noteProviderFailure(provider, message, source);
      tagProviderFailure(e, { provider, source, message });
      throw e;
    }
  };
  return Object.assign(fn, { modelName: call.modelName, provider, source });
}

/**
 * The provider choice, by UNDERSTANDING_PROVIDER, for any call shape:
 *   anthropic  Claude or nothing.
 *   openai     OpenAI or nothing.
 *   auto       Claude with OpenAI behind it (the default). A Claude call that
 *              throws — the house key over its usage limit is a 400 — is
 *              answered by OpenAI on the same input, one console.warn is
 *              written, and OpenAI goes first for the next 60 minutes so a
 *              sweep over eight projects does not pay for eight rejections.
 *              With only one provider available, that one; null with neither.
 * The two builders are thunks so a provider the setting rules out is never
 * built (each costs a client lookup). `what` names the call in the warning.
 * The hour-long memory of a Claude failure is one per process and per
 * Claude key, shared by every caller: a read of one typed answer
 * (interpret.ts) has no reason to pay for a rejection the sweep just saw.
 * Every call handed back is tracked (above), whichever road it takes.
 */
export async function callByProvider<Input, Output>(
  claude: () => Promise<(Call<Input, Output> & CallMeta) | null>,
  gpt: () => Promise<(Call<Input, Output> & CallMeta) | null>,
  what: string
): Promise<(Call<Input, Output> & CallMeta) | null> {
  const env = process.env.UNDERSTANDING_PROVIDER;
  const provider: Provider = (PROVIDERS as readonly string[]).includes(env ?? "")
    ? (env as Provider)
    : "auto";
  if (provider === "anthropic") {
    const call = await claude();
    return call && tracked(call, "anthropic");
  }
  if (provider === "openai") {
    const call = await gpt();
    return call && tracked(call, "openai");
  }

  const [claudeCall, gptCall] = await Promise.all([claude(), gpt()]);
  if (!claudeCall) return gptCall && tracked(gptCall, "openai");
  if (!gptCall) return tracked(claudeCall, "anthropic");
  const primary = tracked(claudeCall, "anthropic");
  const secondary = tracked(gptCall, "openai");
  const source: KeySource = primary.source ?? "house";
  const preferSecondary = () => Date.now() < (preferOpenaiUntil.get(source) ?? 0);
  const call = withFallback(
    primary,
    secondary,
    (e) => {
      preferOpenaiUntil.set(source, Date.now() + PREFER_OPENAI_MS);
      console.warn(
        `understanding: claude ${what} failed (${e instanceof Error ? e.message : String(e)}); using openai for the next 60 minutes`
      );
    },
    preferSecondary,
    (e) => {
      // OpenAI was the road and it was closed; Claude answered. Back to
      // Claude first, now, not when the hour runs out.
      preferOpenaiUntil.delete(source);
      console.warn(
        `understanding: openai ${what} failed (${e instanceof Error ? e.message : String(e)}); claude answered, so claude goes first again`
      );
    },
    (thrown, other) => {
      // Both roads closed: the error that propagates carries the other
      // road's failure too, so the run's row says "anthropic: …" and
      // "openai: …", whichever was tried first.
      for (const f of recordProviderError(other)) tagProviderFailure(thrown, f);
    }
  );
  // Which road the NEXT call takes decides what the progress line names.
  return Object.defineProperties(call, {
    modelName: { get: () => (preferSecondary() ? secondary.modelName : primary.modelName) },
    provider: { get: () => (preferSecondary() ? "openai" : "anthropic") },
    source: { get: () => (preferSecondary() ? secondary.source : primary.source) },
  }) as Call<Input, Output> & CallMeta;
}

/** The production model for one user: the run's two calls, chosen as callByProvider says. */
export function modelCallFor(userId: string): Promise<ModelCall | null> {
  return callByProvider(() => anthropicModelCall(userId), () => openaiModelCall(userId), "call");
}

// --------------------------------------------------------------------------
// Results
// --------------------------------------------------------------------------

export type RunResult =
  | {
      status: "ok";
      recordId: string;
      version: number;
      questions: SyncResult;
      ledes: Record<string, string>;
      todayLine?: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      status: "skipped";
      reason: "unchanged" | "no-model" | "disabled" | "no-project" | "backoff" | "queued";
    }
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
  /** "interview": the user is on the Interview tab asking to be asked; the
   *  prompt gains one paragraph (prompt.ts INTERVIEW_ADDENDUM). Nothing else
   *  in the run changes: same gather, same validation, same storage. */
  mode?: RunMode;
  /** The sweep sets this: after a failed run on these same inputs, wait
   *  FAILED_BACKOFF_MS before calling the model again. A person pressing
   *  "Understand now" or answering a question is asking to try now. */
  backoffAfterFailure?: boolean;
};

/** A failed run stores no record, so without this the hash compare would call
 *  the model again every sweep for a project whose output keeps failing
 *  validation: six calls an hour, about a dollar each, for the same rejection.
 *  The first production sweep did exactly that on the Jazz project. */
const FAILED_BACKOFF_MS = 6 * 60 * 60_000;
/**
 * When this process started. A failure logged before that came from an
 * older build or an older process: a deploy that fixes what the validator
 * refused must get one fresh try per project, not wait six hours for it.
 */
const BOOTED_AT = Date.now() - process.uptime() * 1000;

/**
 * How a failure of the provider's own — the road was closed: a 429, a 400
 * over the usage cap, a timeout — is marked in a run's logged errors, apart
 * from the validator's and from a bad answer (ModelOutputError). The backoff above
 * reads it: such a run says nothing about the inputs, since the model never
 * answered on them, so it must not keep the next sweep from trying. After
 * the prefix, the provider that failed and what it said ("openai: 429 …";
 * provider-health.ts failureLogLine), so a restarted process can read the
 * provider's state back from the rows.
 */
export { MODEL_ERROR_PREFIX };

/**
 * Whether a failed run's logged errors say its LAST attempt failed at the
 * provider. The log is every provider failure plus the last attempt's own
 * errors (runOnce), so it is provider failures only exactly when the last
 * attempt was one; a rejection after a 429 leaves the validator's lines in
 * it. An empty log (a row from before errors were kept) is not a provider
 * failure either.
 */
function failedAtProvider(errors: string[]): boolean {
  return errors.length > 0 && errors.every((e) => e.startsWith(MODEL_ERROR_PREFIX));
}

type RunLog = {
  /** The run's id, fixed at its start: what created_by_run on a question names. */
  id: string;
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
      id: entry.id,
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

/**
 * Three, not two, since the schema stopped being API-enforced (see
 * OUTPUT_FORMAT_TEXT): a text-JSON answer trips the validator on one rule
 * at a time (an empty reason, then a banned word), and the Caltrans dry run
 * of 2026-09-23 needed the third go. Each retry quotes the errors of the
 * attempt before it (rejectionAddendum), not every error so far: the ones
 * an earlier retry fixed are no longer the model's to fix.
 */
const MAX_ATTEMPTS = 3;

/**
 * One run per project at a time, and never two on top of each other. Every
 * answer on Today starts a re-read of its project (answer.ts
 * rerunAfterAnswer); three answers in a minute started three re-reads, and
 * the first, gathered before the second answer, finished last and wrote
 * questions about rows the second answer had just settled. That is the loop
 * Kiron saw: "I'm pressing things and it seems like there's infinite doesn't
 * add up." A run that arrives while one is in flight is not started; it is
 * remembered, and when the running one finishes a single fresh run follows,
 * gathering the data as it is then.
 */
const projectRuns = new Map<string, { promise: Promise<RunResult>; again: RunOptions | null }>();

export async function runProject(
  userId: string,
  projectId: string,
  opts: RunOptions
): Promise<RunResult> {
  const key = `${userId}:${projectId}`;
  const current = projectRuns.get(key);
  if (current) {
    // A pre-gathered bundle is stale by definition here; the follow-up
    // gathers its own.
    current.again = { ...opts, bundle: undefined };
    return { status: "skipped", reason: "queued" };
  }
  const entry: { promise: Promise<RunResult>; again: RunOptions | null } = {
    promise: Promise.resolve({ status: "skipped", reason: "queued" }),
    again: null,
  };
  entry.promise = (async () => {
    try {
      return await runProjectNow(userId, projectId, opts);
    } finally {
      projectRuns.delete(key);
      const again = entry.again;
      if (again) {
        // The follow-up is on its way: say so until its gather is done and
        // it publishes its own phase (or skips, and drops the entry). The
        // name is the one the run that just finished published; with none
        // (it skipped before saying anything) the follow-up speaks first.
        const name = again.dryRun ? null : nameOf(userId, projectId);
        if (name) publish(userId, projectId, name, "queued", `Waiting to read ${name}`);
        void runProject(userId, projectId, again).catch((e) =>
          console.error(`understanding: queued run for ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`)
        );
      }
    }
  })();
  projectRuns.set(key, entry);
  return entry.promise;
}

async function runProjectNow(
  userId: string,
  projectId: string,
  opts: RunOptions
): Promise<RunResult> {
  const startedAt = new Date();
  const now = opts.now ?? new Date();
  // One id for the run, minted here: the understanding_runs row it logs and
  // created_by_run on every question it inserts carry the same one, so a
  // question points at the run that made it.
  const runId = randomUUID();
  if (opts.bundle && opts.bundle.project.id !== projectId) {
    return { status: "failed", errors: [`bundle is for project ${opts.bundle.project.id}, not ${projectId}`] };
  }
  try {
    return await runOnce(userId, projectId, opts, startedAt, now, runId);
  } catch (e) {
    // Nothing is thrown out of a run: one project's trouble must not end the
    // sweep (SPEC §8) or leave it unlogged. A database error in gather, the
    // upsert or the question sync is a failed run like a rejected output —
    // one line in the log, one understanding_runs row, the previous record
    // untouched — and a dry run writes nothing even then.
    const message = e instanceof Error ? e.message : String(e);
    console.error(`understanding: ${projectId} failed: ${message}`);
    if (!opts.dryRun) {
      await logRun({ id: runId, userId, projectId, startedAt, status: "failed", errors: [message] });
      // The screen hears about it too: a run that threw still ends its entry.
      const name = nameOf(userId, projectId) ?? opts.bundle?.project.name ?? "this project";
      const lines = failedOtherLines(name);
      finish(userId, projectId, name, "failed", lines.line, lines.detail, lines.reason);
    }
    return { status: "failed", errors: [message] };
  } finally {
    // A run that skipped published nothing, or inherited a "queued" entry
    // from the run before it: either way nothing is in flight now.
    if (!opts.dryRun) drop(userId, projectId);
  }
}

/** The run proper; runProject guards it. */
async function runOnce(
  userId: string,
  projectId: string,
  opts: RunOptions,
  startedAt: Date,
  now: Date,
  runId: string
): Promise<RunResult> {
  // --- gather and compare --------------------------------------------------
  const bundle =
    opts.bundle ?? (await gatherProject(userId, projectId, { now, timezone: opts.timezone }));
  if (!bundle) {
    // A dry run writes nothing, a skip row included (scripts/understand.ts --dry).
    if (!opts.dryRun) {
      await logRun({
        id: runId,
        userId,
        projectId: null,
        startedAt,
        status: "skipped",
        reason: "no-project",
      });
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

  if (opts.backoffAfterFailure && !opts.force) {
    const [last] = await db
      .select({
        status: understandingRuns.status,
        inputsHash: understandingRuns.inputsHash,
        finishedAt: understandingRuns.finishedAt,
        errors: understandingRuns.errors,
      })
      .from(understandingRuns)
      .where(and(eq(understandingRuns.userId, userId), eq(understandingRuns.projectId, projectId)))
      .orderBy(desc(understandingRuns.startedAt))
      .limit(1);
    if (
      last?.status === "failed" &&
      last.inputsHash === inputsHash &&
      last.finishedAt &&
      Date.now() - last.finishedAt.getTime() < FAILED_BACKOFF_MS &&
      last.finishedAt.getTime() > BOOTED_AT &&
      // Only a run the model answered and the validator refused is expected
      // to fail the same way again on the same inputs. A run whose last
      // attempt the provider failed (MODEL_ERROR_PREFIX) never got an answer
      // on them; it tries again. The log keeps every provider failure next
      // to the LAST attempt's errors, so it is all provider failures exactly
      // when the last attempt was one: a 429 on the first attempt followed
      // by a rejection on the second is a rejection, and backs off.
      !failedAtProvider(last.errors ?? [])
    ) {
      // Same inputs, same rejection expected; a change in the data tries at once.
      return { status: "skipped", reason: "backoff" };
    }
  }

  // --- the model -----------------------------------------------------------
  const model = opts.model ?? (await modelCallFor(userId));
  if (!model) {
    const reason = process.env.UNDERSTANDING_DISABLED === "true" ? "disabled" : "no-model";
    if (!opts.dryRun) {
      await logRun({ id: runId, userId, projectId, startedAt, status: "skipped", reason, inputsHash });
    }
    return { status: "skipped", reason };
  }

  // --- the screen ------------------------------------------------------------
  // From here the run is really happening (it did not skip), so the
  // progress channel hears each phase (SPEC §8). A dry run tells no one.
  const name = bundle.project.name;
  const tell = (phase: Phase, line: string, detail: string | null = null) => {
    if (!opts.dryRun) publish(userId, projectId, name, phase, line, detail);
  };
  const gathering = gatheringLines(name, bundle);
  tell("gathering", gathering.line, gathering.detail);

  const user = renderBundle(bundle, { mode: opts.mode });
  let output: RunOutput | null = null;
  let errors: string[] = [];
  /** Every attempt the provider itself failed, kept apart from the validator's errors (see MODEL_ERROR_PREFIX). */
  const providerErrors: string[] = [];
  let modelId = "";
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && !output; attempt++) {
    {
      // The gather is over in a blink, so the counts ride on the reading
      // line, which is the one the screen actually sees for a minute or
      // more: "Thinking with Claude Sonnet 5 · 43 tasks, 12 messages".
      const reading = readingLines(model.modelName, attempt, MAX_ATTEMPTS);
      tell("reading", reading.line, [reading.detail, gathering.detail].filter(Boolean).join(" · "));
    }
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
      if (e instanceof ModelOutputError) {
        // The model answered, badly. Billed all the same.
        if (e.usage) {
          modelId = e.usage.model;
          inputTokens += e.usage.inputTokens;
          cachedInputTokens += e.usage.cachedInputTokens;
          outputTokens += e.usage.outputTokens;
        }
        const closed = taggedProviderFailures(e);
        if (closed.length > 0) {
          // The road that goes first was closed and the other answered
          // badly: the inputs were never properly answered, so the log
          // reads as provider failures (both of them) and the next sweep
          // tries again, with the first road open by then or not.
          const lines = [...closed, { provider: e.provider, source: "house" as const, message: e.message }].map(
            (f) => `${MODEL_ERROR_PREFIX}${failureLogLine(f)}`
          );
          providerErrors.push(...lines);
          errors = lines;
        } else {
          // The validator's kind of rejection: quoted back on the next
          // attempt, with no word to the provider memory (the provider was
          // fine; the answer was not).
          errors = [e.message];
        }
        if (attempt + 1 < MAX_ATTEMPTS) {
          console.warn(`understanding: ${name}: attempt ${attempt + 1} of ${MAX_ATTEMPTS} refused: ${e.message}`);
        }
        continue;
      }
      // A throw is a failed attempt like any other; the retry quotes it.
      // One line per provider that failed on this attempt, each saying
      // which ("openai: 429 …"), and the provider memory hears about any
      // failure nothing tagged (recordProviderError).
      const messages = recordProviderError(e).map((f) => `${MODEL_ERROR_PREFIX}${failureLogLine(f)}`);
      providerErrors.push(...messages);
      errors = messages;
      continue;
    }
    tell("checking", CHECKING_LINE);
    modelId = result.model;
    inputTokens += result.inputTokens;
    cachedInputTokens += result.cachedInputTokens ?? 0;
    outputTokens += result.outputTokens;
    // A UUID copied with a slipped digit is mended to the one id it is that
    // close to before the validator sees it (repair.ts); the log says so.
    const { output: mended, repairs } = repairIds(result.output, bundle);
    if (repairs.length > 0) {
      console.warn(
        `understanding: ${bundle.project.name}: ${repairs.length} id${repairs.length === 1 ? "" : "s"} mended: ${repairs.map(repairLine).join("; ")}`
      );
    }
    const validated = validateRunOutput(mended, bundle);
    if (validated.ok) output = validated.value;
    else {
      errors = validated.errors;
      // The final refusal is logged with the failure below; the earlier
      // ones would otherwise be nowhere, and they are what the next attempt
      // was told.
      if (attempt + 1 < MAX_ATTEMPTS) {
        console.warn(
          `understanding: ${name}: attempt ${attempt + 1} of ${MAX_ATTEMPTS} refused: ${errors.join("; ")}`
        );
      }
    }
  }

  if (!output) {
    // The log carries every provider failure alongside the last rejection,
    // so the backoff can tell the two apart later.
    const logged = [...new Set([...providerErrors, ...errors])];
    console.error(
      `understanding: ${bundle.project.name} (${projectId}) failed after ${MAX_ATTEMPTS} attempts: ${logged.join("; ")}`
    );
    if (!opts.dryRun) {
      await logRun({
        id: runId,
        userId,
        projectId,
        startedAt,
        status: "failed",
        inputsHash,
        model: modelId || undefined,
        inputTokens,
        outputTokens,
        errors: logged,
      });
      // The attempts that answered were billed whether or not the answer
      // passed: three refused Sonnet answers are real spend.
      if (modelId && inputTokens + outputTokens > 0) {
        await recordUsage({
          userId,
          kind: "understanding",
          model: modelId,
          inputTokens,
          outputTokens,
          cachedInputTokens,
        });
      }
      const failed = failedLines(name, logged);
      finish(userId, projectId, name, "failed", failed.line, failed.detail, failed.reason);
    }
    return { status: "failed", errors: logged };
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
  tell("storing", STORING_LINE);
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
        // `asked` comes from the row as it is NOW, not from `previous`, which
        // was read before the model call. A run takes minutes; answering a
        // question starts one; so while it thinks, the user answers the next
        // question and upsertAsked appends that answer — and writing the
        // snapshot back here erased it. Kiron's three answers about CPO 2110
        // on 2026-09-23 were wiped that way within five minutes, which is why
        // the next run asked a fourth time: the history really was gone. The
        // merge is done in SQL for the same reason upsertAsked is (record.ts).
        body: sql`jsonb_set(${JSON.stringify(body)}::jsonb, '{asked}', coalesce(${records.body} -> 'asked', '[]'::jsonb))`,
        inputsHash,
        words,
        version: sql`${records.version} + 1`,
        updatedAt: now,
      },
    })
    .returning({ id: records.id, version: records.version });

  const questions = await syncQuestions(userId, projectId, output.questions, bundle, {
    createdBy: runId,
  });
  await recordUsage({
    userId,
    kind: "understanding",
    model: modelId,
    inputTokens,
    outputTokens,
    cachedInputTokens,
  });
  await logRun({
    id: runId,
    userId,
    projectId,
    startedAt,
    status: "ok",
    inputsHash,
    model: modelId,
    inputTokens,
    outputTokens,
  });
  {
    // A reopened question is a new card to the user (interview/more counts it the same way).
    const ok = okLines(name, {
      created: questions.created.length + questions.reopened.length,
      updated: questions.updated.length,
      dismissed: questions.dismissed.length,
      skippedSettled: questions.skippedSettled.length,
    });
    finish(userId, projectId, name, "ok", ok.line, ok.detail, null);
  }

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

export type RunAllResult = {
  results: Record<string, RunResult>;
  retiredAsr: number;
  /** True when a sweep for this user was already running and this call did nothing. */
  busy?: true;
};

/**
 * One sweep per user at a time. A second runAll for the same user while one
 * is in flight returns empty at once rather than queueing: the sweep it would
 * have done is the one already running, and two of them would race on the
 * same records and questions.
 */
const inFlight = new Map<string, Promise<RunAllResult>>();

/** Whether a sweep is running for this user right now (a route can say so before spending a quota). */
export function runInFlight(userId: string): boolean {
  return inFlight.has(userId);
}

export async function runAll(
  userId: string,
  opts: {
    timezone: string;
    now?: Date;
    model?: ModelCall;
    force?: boolean;
    dryRun?: boolean;
    mode?: RunMode;
    backoffAfterFailure?: boolean;
  }
): Promise<RunAllResult> {
  if (inFlight.has(userId)) return { results: {}, retiredAsr: 0, busy: true };

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
        mode: opts.mode,
        backoffAfterFailure: opts.backoffAfterFailure,
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
