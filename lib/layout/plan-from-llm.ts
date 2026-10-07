// Planner v2 (SPEC §6): LLM behind the same interface as planFromRules.
// Selection: validate(LLM) ?? validate(rules) ?? previous good plan ?? DEFAULT.
// The model call is injectable so tests use recorded responses — CI never
// talks to a live model.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openai, PLANNER_MODEL } from "@/lib/openai";
import type Anthropic from "@anthropic-ai/sdk";
import { REGISTRY_VERSION } from "./registry";
import { defaultPlan, type LayoutPlan } from "./plan";
import { planFromRules } from "./plan-from-rules";
import { signalsHash, type Signals } from "./signals";
import { applyBans, validatePlan, type LayoutPreference } from "./validator";

export type PlannerCall = (systemPrompt: string, signalsJson: string) => Promise<string>;

let promptCache: string | null = null;
export function plannerPrompt(): string {
  promptCache ??= readFileSync(
    join(process.cwd(), "docs/adaptive-ui/planner-prompt.md"),
    "utf8"
  );
  return promptCache;
}

// The LLM runs in the background (persistPlan), never on the render path —
// measured nano latency ~5s; Claude at low effort can take longer. This is the
// background budget, not a render stall.
const LLM_TIMEOUT_MS = 60000;

/** What the last planner call cost. The planner runs in the background on
 *  every dashboard render whose signals changed, so it is real recurring
 *  spend — and it recorded nothing from the day ADAPTIVE_V2 shipped, because
 *  the usage row lived in the v0 generator this path replaced. */
export const lastPlannerUsage: { model: string | null; input: number; output: number } = {
  model: null,
  input: 0,
  output: 0,
};

function notePlannerUsage(model: string, input: number, output: number) {
  lastPlannerUsage.model = model;
  lastPlannerUsage.input = input;
  lastPlannerUsage.output = output;
}

export const livePlannerCall: PlannerCall = async (systemPrompt, signalsJson) => {
  const response = await openai.responses.create({
    model: PLANNER_MODEL,
    instructions: systemPrompt,
    input: `Emit the LayoutPlan as a json object for these SIGNALS:\n${signalsJson}`,
    text: { format: { type: "json_object" } },
    temperature: 0.2,
  });
  notePlannerUsage(
    PLANNER_MODEL,
    response.usage?.input_tokens ?? 0,
    response.usage?.output_tokens ?? 0
  );
  return response.output_text ?? "";
};

/**
 * Claude planner (CLAUDE_BRAIN): user-chosen model, effort clamped to low —
 * background refinement doesn't need deep reasoning, the validator is the
 * gatekeeper either way. Throws on refusal; planWithFallback's catch → rules.
 */
export function claudePlannerCall(client: Anthropic, model: string): PlannerCall {
  return async (systemPrompt, signalsJson) => {
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Emit the LayoutPlan as a single JSON object for these SIGNALS. Respond with ONLY the JSON — no markdown fences, no prose.\n${signalsJson}`,
        },
      ],
      output_config: { effort: "low" },
    });
    notePlannerUsage(model, response.usage.input_tokens, response.usage.output_tokens);
    if (response.stop_reason === "refusal") throw new Error("claude refusal");
    const text = response.content
      .filter((b): b is Extract<(typeof response.content)[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    return text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  };
}

/** In-memory plan cache (SPEC §6): signals-hash + registry version. The
 *  durable layer is the decision log — plan-store also reuses the stored head
 *  when its signals_hash matches, so restarts don't re-spend calls. */
const planCache = new Map<string, LayoutPlan>();
const CACHE_MAX = 200;

export function cacheKey(signals: Signals): string {
  return `${REGISTRY_VERSION}:${signalsHash(signals, REGISTRY_VERSION)}`;
}

/**
 * The full fallback chain. Always returns a valid plan; never throws.
 * `call` defaults to the live model and is injected in tests.
 */
export async function planWithFallback(
  signals: Signals,
  opts: {
    previousPlan: LayoutPlan | null;
    preferences: LayoutPreference[];
    pinnedSections: string[];
    call?: PlannerCall;
    llmEnabled?: boolean;
    /** Approved dynamic components (SPEC v1.3): valid names + prompt rows. */
    dynamicComponents?: { name: string; description: string }[];
  }
): Promise<{
  plan: LayoutPlan;
  source: "llm" | "llm-cache" | "rules" | "previous" | "default";
  /** A live planner call returned (and was paid for), whatever became of its plan. */
  called?: boolean;
}> {
  const ctx = {
    signals,
    previousPlan: opts.previousPlan,
    preferences: opts.preferences,
    pinnedSections: opts.pinnedSections,
    defaultPlan: defaultPlan(signals),
    dynamicComponents: opts.dynamicComponents?.map((d) => d.name),
  };
  const key = cacheKey(signals);
  // A planner's plan is named by the server, never by the model (sec rev):
  // the validator measures a plan against the one before it, and treats a
  // previous plan named "default" as the default (SEC-A007), so a model that
  // wrote "default" would loosen the rationing for the plan after it.
  const serverId = (plan: LayoutPlan): LayoutPlan => ({ ...plan, plan_id: `llm-${key}` });
  let called = false;

  if (opts.llmEnabled !== false) {
    const cached = planCache.get(key);
    if (cached) {
      const v = validatePlan(serverId(cached), ctx);
      if (v.ok) return { plan: applyBans(v.plan, opts.preferences), source: "llm-cache" };
    }
    try {
      const call = opts.call ?? livePlannerCall;
      // Approved dynamic components join the prompt's registry table at load
      // time (SPEC v1.3c) — the prompt file on disk is never mutated.
      const prompt = opts.dynamicComponents?.length
        ? `${plannerPrompt()}\n## Approved dynamic components (also valid, props-less)\n${opts.dynamicComponents
            .map((d) => `| ${d.name} | — | ${d.description} |`)
            .join("\n")}\n`
        : plannerPrompt();
      // What this call costs is what it reports, not a figure left over
      // from an earlier call.
      lastPlannerUsage.model = null;
      lastPlannerUsage.input = 0;
      lastPlannerUsage.output = 0;
      const raw = await Promise.race([
        call(prompt, JSON.stringify(signals)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("planner timeout")), LLM_TIMEOUT_MS)
        ),
      ]);
      // It answered, so it was paid for, whether or not the answer validates.
      called = true;
      const v = validatePlan(raw, ctx);
      if (v.ok) {
        const plan = serverId(v.plan);
        if (planCache.size >= CACHE_MAX) {
          const oldest = planCache.keys().next().value;
          if (oldest) planCache.delete(oldest);
        }
        planCache.set(key, plan);
        return { plan: applyBans(plan, opts.preferences), source: "llm", called };
      }
    } catch {
      // fall through to rules
    }
  }

  const rules = validatePlan(planFromRules(signals), ctx);
  if (rules.ok) return { plan: applyBans(rules.plan, opts.preferences), source: "rules", called };

  if (opts.previousPlan) {
    const prev = validatePlan(opts.previousPlan, ctx);
    if (prev.ok) return { plan: applyBans(prev.plan, opts.preferences), source: "previous", called };
  }

  return { plan: applyBans(defaultPlan(signals), opts.preferences), source: "default", called };
}

/** test hook */
export function clearPlanCache() {
  planCache.clear();
}
