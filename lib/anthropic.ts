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

// ---------------------------------------------------------------------------
// Chat model registry: the composer chip's vocabulary. Two providers — the
// voice loop stays OpenAI Realtime, but the TEXT secretary can run on either.
// Effort ladders differ per provider (probed live 2026-08-25):
//   anthropic: low / medium / high / xhigh / max
//   openai   : none / low / medium / high / xhigh   ("minimal" 400s on gpt-5.5)
// ---------------------------------------------------------------------------
export type ChatProvider = "anthropic" | "openai";

export const CHAT_MODELS = [
  { id: "claude-fable-5", label: "Fable 5", provider: "anthropic", hint: "toughest problems" },
  { id: "claude-opus-5", label: "Opus 5", provider: "anthropic", hint: "complex work" },
  { id: "claude-sonnet-5", label: "Sonnet 5", provider: "anthropic", hint: "fast + efficient" },
  { id: "gpt-5.5", label: "GPT-5.5", provider: "openai", hint: "default" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", provider: "openai", hint: "quick answers" },
] as const;
export type ChatModel = (typeof CHAT_MODELS)[number]["id"];

export const CHAT_EFFORTS: Record<ChatProvider, readonly string[]> = {
  anthropic: BRAIN_EFFORTS,
  openai: ["none", "low", "medium", "high", "xhigh"],
};

export const DEFAULT_CHAT_MODEL: ChatModel = "gpt-5.5";
export const DEFAULT_CHAT_EFFORT = "medium";

export function chatProvider(model: string): ChatProvider {
  return CHAT_MODELS.find((m) => m.id === model)?.provider ?? "openai";
}

/** Keep a stored effort meaningful when the model (and its ladder) changes. */
export function clampEffort(provider: ChatProvider, effort: string | undefined): string {
  const ladder = CHAT_EFFORTS[provider];
  if (effort && ladder.includes(effort)) return effort;
  if (effort === "max") return "xhigh"; // anthropic-only top → openai top
  if (effort === "none") return "low"; // openai-only floor → anthropic floor
  return DEFAULT_CHAT_EFFORT;
}

export type ChatSettings = { model: ChatModel; effort: string };

/** Per-user chat model + effort from the composer chip (persona jsonb). */
export async function chatSettings(userId: string): Promise<ChatSettings> {
  const { db } = await import("@/lib/db");
  const { user } = await import("@/lib/db/schema");
  const [row] = await db
    .select({ persona: user.persona })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const p = row?.persona;
  const model = CHAT_MODELS.some((m) => m.id === p?.chatModel)
    ? (p!.chatModel as ChatModel)
    : DEFAULT_CHAT_MODEL;
  return { model, effort: clampEffort(chatProvider(model), p?.chatEffort) };
}

export const DEFAULT_BRAIN_MODEL: BrainModel = "claude-opus-5";
export const DEFAULT_BRAIN_EFFORT: BrainEffort = "high";

export type BrainSettings = { model: BrainModel; effort: BrainEffort };

/** Flag + never under vitest — CI must not touch a live model. Whether a KEY
 *  exists is per-user now (connected account or house key): callers resolve
 *  a client with anthropicFor(userId) and skip the Claude path on null. */
export function claudeBrainEnabled(): boolean {
  return process.env.CLAUDE_BRAIN === "true" && !process.env.VITEST;
}

let client: Anthropic | null = null;
/** House-key client (owner's .env). Lazy so import never throws keyless. */
export function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

const userClients = new Map<string, Anthropic>();

/**
 * Which key a call goes out on: the house key from the environment, or a
 * connected account's key named by its 4-char tail (never the key itself).
 * Provider health (lib/understanding/provider-health.ts) remembers failures
 * per key, so a house key over its cap says nothing about a connected one.
 */
export type KeySource = "house" | `connected:${string}`;

/**
 * The multi-user resolution with the key it landed on: the user's connected
 * Claude account first, then the house key, else null (caller falls back to
 * its OpenAI path). Site login and Claude connection are separate layers —
 * see connectedAccounts schema.
 */
export async function anthropicClientFor(
  userId: string
): Promise<{ client: Anthropic; source: KeySource } | null> {
  const { db } = await import("@/lib/db");
  const { connectedAccounts } = await import("@/lib/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const [row] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "anthropic")))
    .limit(1);
  if (row) {
    const source: KeySource = `connected:${row.keyTail}`;
    const cached = userClients.get(row.id);
    if (cached) return { client: cached, source };
    const { decryptSecret } = await import("@/lib/crypto");
    try {
      const c = new Anthropic({ apiKey: decryptSecret(row.encryptedKey) });
      userClients.set(row.id, c);
      return { client: c, source };
    } catch {
      // corrupt/undecryptable row — fall through to the house key
    }
  }
  return process.env.ANTHROPIC_API_KEY ? { client: anthropic(), source: "house" } : null;
}

/** anthropicClientFor without the key's name: the client, or null. */
export async function anthropicFor(userId: string): Promise<Anthropic | null> {
  return (await anthropicClientFor(userId))?.client ?? null;
}

/** Invalidate the per-user client cache after connect/disconnect. */
export function forgetUserClient(rowId: string): void {
  userClients.delete(rowId);
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
