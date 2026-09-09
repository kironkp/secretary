// What a unit of model work costs, in dollars.
//
// Every rate here was read off the vendor's own pricing page on the date in
// `asOf`. Three rules make this trustworthy:
//
//   1. Rates come in three units in this app — per token, per minute of audio,
//      per 1,000 characters — so the unit is part of the type, never a
//      convention someone has to remember.
//   2. An unknown model is NOT free. It is priced at the most expensive rate we
//      know and flagged, because a new model silently costing $0.00 is exactly
//      how spend goes missing again.
//   3. Prices change. Never edit a card in place: append a new one with a later
//      `effectiveFrom`. A report for last month must keep using last month's
//      prices.
//
// Pure data plus two functions. No I/O, no database import.

/** Dollars per 1M tokens. */
export type TokenRate = {
  kind: "per_token";
  input: number;
  output: number;
  /** Discounted rate for re-read (cached) input. */
  cachedInput?: number;
};

/** Dollars per minute of audio. */
export type MinuteRate = { kind: "per_minute"; perMinute: number };

/** Dollars per 1,000 characters. */
export type CharacterRate = { kind: "per_character"; per1kChars: number };

/** Realtime bills AUDIO and TEXT at very different rates under one model id —
 *  audio input is 8× text input — so a row that doesn't know its split cannot
 *  be priced within a factor of eight. Kept apart here so the split can be
 *  used the moment we record it. */
export type RealtimeRate = { kind: "realtime"; audio: TokenRate; text: TokenRate };

export type Rate = TokenRate | MinuteRate | CharacterRate | RealtimeRate;

export type RateCard = {
  /** ISO date these prices took effect. */
  effectiveFrom: string;
  /** ISO date a human last verified them against the source. */
  asOf: string;
  source: Record<string, string>;
  rates: Record<string, Rate>;
};

const CARD_2026_09: RateCard = {
  effectiveFrom: "2026-09-01",
  asOf: "2026-09-09",
  source: {
    openai: "https://developers.openai.com/api/docs/pricing",
    anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
    elevenlabs: "https://elevenlabs.io/pricing/api",
  },
  rates: {
    // OpenAI text
    "gpt-5.5": { kind: "per_token", input: 5.0, output: 30.0, cachedInput: 0.5 },
    "gpt-5.4-mini": { kind: "per_token", input: 0.75, output: 4.5, cachedInput: 0.075 },
    "gpt-5.4-nano": { kind: "per_token", input: 0.2, output: 1.25, cachedInput: 0.02 },
    "gpt-5-mini": { kind: "per_token", input: 0.25, output: 2.0, cachedInput: 0.025 },

    // OpenAI realtime — audio is the expensive half by a long way.
    "gpt-realtime-2.1": {
      kind: "realtime",
      audio: { kind: "per_token", input: 32.0, output: 64.0, cachedInput: 0.4 },
      text: { kind: "per_token", input: 4.0, output: 24.0, cachedInput: 0.4 },
    },
    "gpt-realtime-2.1-mini": {
      kind: "realtime",
      audio: { kind: "per_token", input: 10.0, output: 20.0, cachedInput: 0.3 },
      text: { kind: "per_token", input: 0.6, output: 2.4, cachedInput: 0.06 },
    },

    // OpenAI transcription — per minute of audio, not per token.
    "gpt-transcribe": { kind: "per_minute", perMinute: 0.0045 },
    "gpt-4o-transcribe": { kind: "per_minute", perMinute: 0.006 },
    "gpt-live-transcribe": { kind: "per_minute", perMinute: 0.017 },

    // Anthropic
    "claude-fable-5": { kind: "per_token", input: 10, output: 50, cachedInput: 1.0 },
    "claude-opus-5": { kind: "per_token", input: 5, output: 25, cachedInput: 0.5 },
    "claude-sonnet-5": { kind: "per_token", input: 2, output: 10, cachedInput: 0.2 },

    // ElevenLabs — per 1,000 characters.
    "elevenlabs/eleven_v3": { kind: "per_character", per1kChars: 0.1 },
    "elevenlabs/eleven_flash_v2_5": { kind: "per_character", per1kChars: 0.05 },
  },
};

/** Newest LAST. Append, never edit. */
const CARDS: RateCard[] = [CARD_2026_09];

/** The most expensive per-token rate we know of, used when a model is unknown
 *  so an unpriced call reads as "look at me", never as free. */
const UNKNOWN_RATE: TokenRate = { kind: "per_token", input: 10, output: 50 };

export function cardFor(at: Date = new Date()): RateCard {
  const iso = at.toISOString().slice(0, 10);
  const applicable = CARDS.filter((c) => c.effectiveFrom <= iso);
  return applicable[applicable.length - 1] ?? CARDS[0];
}

export function rateFor(
  model: string | null | undefined,
  at: Date = new Date()
): { rate: Rate; known: boolean } {
  const rates = cardFor(at).rates;
  const exact = model ? rates[model] : undefined;
  if (exact) return { rate: exact, known: true };
  // ElevenLabs ids arrive prefixed; match the family if the exact voice model
  // isn't listed rather than falling all the way to unknown.
  if (model?.startsWith("elevenlabs/"))
    return { rate: { kind: "per_character", per1kChars: 0.1 }, known: false };
  return { rate: UNKNOWN_RATE, known: false };
}

export type Priced = {
  usd: number;
  /** False when the model wasn't in the rate card — the number is a ceiling. */
  known: boolean;
  /** True when the figure rests on an assumption worth showing the user. */
  estimated: boolean;
  note?: string;
};

export type PricedInput = {
  model: string | null | undefined;
  kind: string;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  /** Realtime only, once recorded: how much of the input was audio. */
  audioInputTokens?: number | null;
  audioOutputTokens?: number | null;
  cachedInputTokens?: number | null;
  at?: Date;
};

const PER_M = 1_000_000;

/** Dollars for one usage row. Never throws; an unpriceable row costs its
 *  ceiling rather than zero. */
export function priceUsage(row: PricedInput): Priced {
  const at = row.at ?? new Date();
  const { rate, known } = rateFor(row.model, at);

  if (rate.kind === "per_minute") {
    return { usd: (row.seconds / 60) * rate.perMinute, known, estimated: false };
  }

  if (rate.kind === "per_character") {
    // Character count is stored in inputTokens — see lib/usage.ts.
    return { usd: (row.inputTokens / 1000) * rate.per1kChars, known, estimated: false };
  }

  if (rate.kind === "realtime") {
    const audioIn = row.audioInputTokens ?? null;
    const audioOut = row.audioOutputTokens ?? null;
    if (audioIn === null || audioOut === null) {
      // Without the split we cannot be right within a factor of eight. Assume
      // audio — it is what a voice call mostly is, and the honest direction to
      // be wrong in is "too high", not "too low".
      const usd =
        (row.inputTokens / PER_M) * rate.audio.input +
        (row.outputTokens / PER_M) * rate.audio.output;
      return {
        usd,
        known,
        estimated: true,
        note: "audio/text split not recorded — priced as all audio (the expensive case)",
      };
    }
    const textIn = Math.max(0, row.inputTokens - audioIn);
    const textOut = Math.max(0, row.outputTokens - audioOut);
    const usd =
      (audioIn / PER_M) * rate.audio.input +
      (audioOut / PER_M) * rate.audio.output +
      (textIn / PER_M) * rate.text.input +
      (textOut / PER_M) * rate.text.output;
    return { usd, known, estimated: false };
  }

  // per_token
  const cached = Math.min(row.cachedInputTokens ?? 0, row.inputTokens);
  const fresh = row.inputTokens - cached;
  const usd =
    (fresh / PER_M) * rate.input +
    (cached / PER_M) * (rate.cachedInput ?? rate.input) +
    (row.outputTokens / PER_M) * rate.output;
  return {
    usd,
    known,
    estimated: !known,
    note: known ? undefined : `no rate for "${row.model ?? "unknown"}" — priced at the ceiling`,
  };
}

export function formatUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd > 0) return `<$0.01`;
  return "$0.00";
}
