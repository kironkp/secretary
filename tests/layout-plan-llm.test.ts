// Phase 2: planFromLLM fallback chain with recorded/mocked responses.
// CI NEVER calls a live model — every test injects `call`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey, clearPlanCache, planWithFallback } from "@/lib/layout/plan-from-llm";
import { defaultPlan } from "@/lib/layout/plan";
import { baseSignals } from "./fixtures/layout";

const recorded = readFileSync(join(__dirname, "fixtures/llm-plan-response.json"), "utf8");

const opts = { previousPlan: null, preferences: [], pinnedSections: [] };

beforeEach(() => clearPlanCache());

describe("planWithFallback", () => {
  it("uses a valid LLM plan and caches it by signals-hash", async () => {
    const call = vi.fn(async () => recorded);
    const signals = baseSignals();
    const first = await planWithFallback(signals, { ...opts, call });
    expect(first.source).toBe("llm");
    // Named by the server from the signals it answered (SEC-A007), not by the
    // model: the recorded response calls itself "llm-recorded-1".
    expect(JSON.parse(recorded).plan_id).toBe("llm-recorded-1");
    expect(first.plan.plan_id).toBe(`llm-${cacheKey(signals)}`);
    const second = await planWithFallback(signals, { ...opts, call });
    expect(second.source).toBe("llm-cache");
    expect(second.plan.plan_id).toBe(first.plan.plan_id);
    expect(call).toHaveBeenCalledTimes(1); // quiet repeat costs zero calls
  });

  it("falls back to rules when the LLM emits prose", async () => {
    const call = vi.fn(async () => "Sure! Here's a lovely layout:\n- timeline first");
    const res = await planWithFallback(baseSignals(), { ...opts, call });
    expect(res.source).toBe("rules");
  });

  it("falls back to rules when the LLM call throws", async () => {
    const call = vi.fn(async (): Promise<string> => {
      throw new Error("model unavailable");
    });
    const res = await planWithFallback(baseSignals(), { ...opts, call });
    expect(res.source).toBe("rules");
  });

  it("falls back to rules when the LLM plan violates an invariant", async () => {
    // Recorded plan minus the urgent patent card → validator rejects it.
    const bad = JSON.parse(recorded);
    bad.sections = bad.sections.filter(
      (s: { props?: { project_id?: string } }) => s.props?.project_id !== "patent"
    );
    const call = vi.fn(async () => JSON.stringify(bad));
    const res = await planWithFallback(baseSignals(), { ...opts, call });
    expect(res.source).toBe("rules");
    expect(
      res.plan.sections.some((s) => s.props?.project_id === "patent")
    ).toBe(true);
  });

  it("a planner's plan that carries what he banned is refused; the rules plan is judged without it", async () => {
    // people_index banned. The planner's plan contains it and is refused
    // (F7). Until v1.02 r5 the rules plan was refused for it too, and the
    // board fell back to the previous plan: a ban of his held the system's
    // own plan. It is taken out of the rules plan before that is judged.
    const signals = baseSignals();
    const previous = defaultPlan(signals);
    previous.sections = previous.sections.filter((s) => s.component !== "people_index");
    const call = vi.fn(async () => recorded);
    const res = await planWithFallback(signals, {
      previousPlan: previous,
      preferences: [{ kind: "ban_component", value: { component: "people_index" } }],
      pinnedSections: [],
      call,
    });
    expect(res.plan.sections.map((s) => s.component)).not.toContain("people_index");
    expect(call).toHaveBeenCalledTimes(1);
    expect(res.source).toBe("rules");
  });

  it("never emits an invalid plan even with llm disabled", async () => {
    const res = await planWithFallback(baseSignals(), { ...opts, llmEnabled: false });
    expect(res.source).toBe("rules");
    expect(res.plan.sections.length).toBeGreaterThan(0);
  });
});
