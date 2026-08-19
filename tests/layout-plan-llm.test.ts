// Phase 2: planFromLLM fallback chain with recorded/mocked responses.
// CI NEVER calls a live model — every test injects `call`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearPlanCache, planWithFallback } from "@/lib/layout/plan-from-llm";
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
    expect(first.plan.plan_id).toBe("llm-recorded-1");
    const second = await planWithFallback(signals, { ...opts, call });
    expect(second.source).toBe("llm-cache");
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

  it("walks past rules to the previous good plan when preferences reject both", async () => {
    // people_index banned: LLM plan and rules/default plans all contain it —
    // only the previous plan (already cleaned) survives validation.
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
    expect(["previous", "default"]).toContain(res.source);
  });

  it("never emits an invalid plan even with llm disabled", async () => {
    const res = await planWithFallback(baseSignals(), { ...opts, llmEnabled: false });
    expect(res.source).toBe("rules");
    expect(res.plan.sections.length).toBeGreaterThan(0);
  });
});
