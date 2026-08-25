// Composer chip plumbing: the model registry, cross-provider effort clamping,
// and the Anthropic tool defs mirroring the OpenAI set (one source of truth).
import { describe, expect, it } from "vitest";
import {
  CHAT_EFFORTS,
  CHAT_MODELS,
  chatProvider,
  clampEffort,
  DEFAULT_CHAT_MODEL,
} from "@/lib/anthropic";
import { anthropicToolDefs, openAIToolDefs, VOICE_TOOL_NAMES } from "@/lib/secretary/tool-schemas";

describe("chat model registry", () => {
  it("both providers present; default is a registered model", () => {
    expect(CHAT_MODELS.some((m) => m.provider === "anthropic")).toBe(true);
    expect(CHAT_MODELS.some((m) => m.provider === "openai")).toBe(true);
    expect(CHAT_MODELS.some((m) => m.id === DEFAULT_CHAT_MODEL)).toBe(true);
  });

  it("providers resolve; unknown model falls back to openai", () => {
    expect(chatProvider("claude-fable-5")).toBe("anthropic");
    expect(chatProvider("gpt-5.5")).toBe("openai");
    expect(chatProvider("something-else")).toBe("openai");
  });

  it("effort ladders match what the APIs accept (probed 2026-08-25)", () => {
    expect(CHAT_EFFORTS.anthropic).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(CHAT_EFFORTS.openai).toEqual(["none", "low", "medium", "high", "xhigh"]);
  });

  it("clampEffort maps across ladders when the provider changes", () => {
    expect(clampEffort("openai", "max")).toBe("xhigh"); // anthropic top → openai top
    expect(clampEffort("anthropic", "none")).toBe("low"); // openai floor → anthropic floor
    expect(clampEffort("anthropic", "high")).toBe("high"); // valid passes through
    expect(clampEffort("openai", undefined)).toBe("medium"); // default
    expect(clampEffort("anthropic", "bogus")).toBe("medium");
  });
});

describe("anthropic tool defs (the Claude chat port)", () => {
  it("mirrors the OpenAI tool set exactly — same names, same count", () => {
    const oai = openAIToolDefs();
    const ant = anthropicToolDefs();
    expect(ant.map((t) => t.name)).toEqual(oai.map((t) => t.name));
  });

  it("every def carries the Messages-API shape", () => {
    for (const def of anthropicToolDefs()) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.input_schema).toMatchObject({ type: "object" });
    }
  });

  it("consult_brain exists for both providers and rides the voice session", () => {
    expect(anthropicToolDefs().some((t) => t.name === "consult_brain")).toBe(true);
    expect(VOICE_TOOL_NAMES).toContain("consult_brain");
  });
});
