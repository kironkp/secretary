// Claude "brain" plane: the swappable intelligence behind extraction, the
// canvas painter, and the layout planner. CLAUDE_BRAIN=true + ANTHROPIC_API_KEY
// turn it on; every call site falls back to its OpenAI path on error or
// refusal, so flipping the flag can never break the app. The realtime voice
// loop (ears/mouth) stays OpenAI — Anthropic has no speech-to-speech API.
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";

// The Settings dropdown. Haiku is excluded on purpose: no `effort` support,
// and the whole point of the swap is smarter parsing.
export const BRAIN_MODELS = [
  { id: "claude-fable-5", label: "Fable 5", hint: "smartest — 2× Opus price" },
  { id: "claude-opus-5", label: "Opus 5", hint: "default — deep reasoning" },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "fast + cheaper" },
] as const;
export type BrainModel = (typeof BRAIN_MODELS)[number]["id"];

export const BRAIN_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type BrainEffort = (typeof BRAIN_EFFORTS)[number];

export const DEFAULT_BRAIN_MODEL: BrainModel = "claude-opus-5";
export const DEFAULT_BRAIN_EFFORT: BrainEffort = "high";

export type BrainSettings = { model: BrainModel; effort: BrainEffort };

/** Flag + key + never under vitest — CI must not touch a live model. */
export function claudeBrainEnabled(): boolean {
  return (
    process.env.CLAUDE_BRAIN === "true" &&
    !!process.env.ANTHROPIC_API_KEY &&
    !process.env.VITEST
  );
}

let client: Anthropic | null = null;
/** Lazy so importing this module never throws when the key is absent. */
export function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** Per-user model + effort from Settings (persona jsonb); Opus 5 @ high default. */
export async function brainSettings(userId: string): Promise<BrainSettings> {
  const { db } = await import("@/lib/db");
  const { user } = await import("@/lib/db/schema");
  const [row] = await db
    .select({ persona: user.persona })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const p = row?.persona;
  const model = BRAIN_MODELS.some((m) => m.id === p?.brainModel)
    ? (p!.brainModel as BrainModel)
    : DEFAULT_BRAIN_MODEL;
  const effort = BRAIN_EFFORTS.includes(p?.brainEffort as BrainEffort)
    ? (p!.brainEffort as BrainEffort)
    : DEFAULT_BRAIN_EFFORT;
  return { model, effort };
}
