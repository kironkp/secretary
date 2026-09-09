// Pricing. The failure that matters here is silent: a model with no rate
// costing $0.00 reads as "nothing to see here", which is exactly how spend
// went missing in the first place.
import { describe, expect, it } from "vitest";
import { formatUsd, priceUsage, rateFor } from "@/lib/pricing";

describe("an unknown model is never free", () => {
  it("prices at a ceiling and says the number is not a fact", () => {
    const p = priceUsage({
      model: "gpt-99-turbo",
      kind: "chat",
      inputTokens: 1_000_000,
      outputTokens: 0,
      seconds: 0,
    });
    expect(p.usd).toBeGreaterThan(0);
    expect(p.known).toBe(false);
    expect(p.estimated).toBe(true);
    expect(p.note).toMatch(/ceiling/);
  });

  it("and a null model is treated the same way", () => {
    expect(priceUsage({ model: null, kind: "other", inputTokens: 1000, outputTokens: 0, seconds: 0 }).usd)
      .toBeGreaterThan(0);
  });
});

describe("token pricing", () => {
  it("charges input and output at their own rates", () => {
    const p = priceUsage({
      model: "claude-fable-5",
      kind: "chat",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      seconds: 0,
    });
    expect(p.usd).toBeCloseTo(60, 5); // $10 in + $50 out
    expect(p.known).toBe(true);
  });

  it("discounts cached input rather than billing it as fresh", () => {
    const full = priceUsage({
      model: "claude-fable-5",
      kind: "chat",
      inputTokens: 1_000_000,
      outputTokens: 0,
      seconds: 0,
    });
    const cached = priceUsage({
      model: "claude-fable-5",
      kind: "chat",
      inputTokens: 1_000_000,
      outputTokens: 0,
      seconds: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(full.usd).toBeCloseTo(10, 5);
    expect(cached.usd).toBeCloseTo(1, 5); // a tenth
  });

  it("never counts more cached tokens than there were input tokens", () => {
    const p = priceUsage({
      model: "claude-fable-5",
      kind: "chat",
      inputTokens: 100,
      outputTokens: 0,
      seconds: 0,
      cachedInputTokens: 999_999,
    });
    expect(p.usd).toBeGreaterThan(0);
    expect(p.usd).toBeLessThan(0.002);
  });
});

describe("realtime audio is the expensive half", () => {
  it("without a split, prices as all audio and says so", () => {
    const p = priceUsage({
      model: "gpt-realtime-2.1",
      kind: "voice",
      inputTokens: 1_000_000,
      outputTokens: 0,
      seconds: 600,
    });
    expect(p.usd).toBeCloseTo(32, 5);
    expect(p.estimated).toBe(true);
    expect(p.note).toMatch(/all audio/);
  });

  it("with a split, text is billed at its own much lower rate", () => {
    const p = priceUsage({
      model: "gpt-realtime-2.1",
      kind: "voice",
      inputTokens: 1_000_000,
      outputTokens: 0,
      seconds: 600,
      audioInputTokens: 0,
      audioOutputTokens: 0,
    });
    expect(p.usd).toBeCloseTo(4, 5); // all text
    expect(p.estimated).toBe(false);
  });

  it("so the split is worth 8x — the reason it is recorded at all", () => {
    const allAudio = priceUsage({
      model: "gpt-realtime-2.1",
      kind: "voice",
      inputTokens: 1_000_000,
      outputTokens: 0,
      seconds: 0,
      audioInputTokens: 1_000_000,
      audioOutputTokens: 0,
    });
    expect(allAudio.usd / 4).toBeCloseTo(8, 1);
  });
});

describe("the other billing units", () => {
  it("transcription is per minute of audio, not per token", () => {
    const p = priceUsage({
      model: "gpt-transcribe",
      kind: "transcribe",
      inputTokens: 0,
      outputTokens: 0,
      seconds: 600,
    });
    expect(p.usd).toBeCloseTo(0.045, 6); // 10 min at $0.0045
  });

  it("speech is per 1,000 characters", () => {
    const p = priceUsage({
      model: "elevenlabs/eleven_flash_v2_5",
      kind: "speech",
      inputTokens: 10_000, // characters live here
      outputTokens: 0,
      seconds: 0,
    });
    expect(p.usd).toBeCloseTo(0.5, 6);
  });

  it("an unlisted elevenlabs voice still prices per character, not as tokens", () => {
    const { rate } = rateFor("elevenlabs/some-new-voice");
    expect(rate.kind).toBe("per_character");
  });
});

describe("formatUsd is readable at every scale", () => {
  it("never shows a real cost as $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0004)).toBe("<$0.01");
    expect(formatUsd(0.042)).toBe("$0.042");
    expect(formatUsd(12.5)).toBe("$12.50");
  });
});
