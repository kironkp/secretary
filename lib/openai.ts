import OpenAI from "openai";
import type { KeySource } from "@/lib/anthropic";

/**
 * The house client (OPENAI_API_KEY). Built with a placeholder when the key
 * is missing so this module stays importable keyless: a call on it is then
 * a 401 the caller reports, not a throw at import that takes the whole
 * route module down. openaiClientFor never hands it out without the key.
 */
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "missing" });

const userClients = new Map<string, OpenAI>();

/**
 * The key a request for this user goes out on: the user's connected OpenAI
 * account first (decrypted the way app/api/connections stores it), then the
 * house key, else null. For the one caller that speaks to OpenAI with a bare
 * fetch (app/api/realtime/token mints a Realtime secret); everything else
 * takes the client from openaiClientFor.
 */
export async function openaiKeyFor(
  userId: string
): Promise<{ apiKey: string; source: KeySource; rowId: string | null } | null> {
  const { db } = await import("@/lib/db");
  const { connectedAccounts } = await import("@/lib/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const [row] = await db
    .select()
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.userId, userId), eq(connectedAccounts.provider, "openai")))
    .limit(1);
  if (row) {
    const { decryptSecret } = await import("@/lib/crypto");
    try {
      return { apiKey: decryptSecret(row.encryptedKey), source: `connected:${row.keyTail}`, rowId: row.id };
    } catch {
      // corrupt/undecryptable row — fall through to the house key
    }
  }
  return process.env.OPENAI_API_KEY
    ? { apiKey: process.env.OPENAI_API_KEY, source: "house", rowId: null }
    : null;
}

/**
 * The multi-user resolution, mirroring anthropicClientFor (lib/anthropic.ts):
 * a client on the user's connected OpenAI key, else the house client, else
 * null. The env-key path is exactly what it was when nothing is connected.
 */
export async function openaiClientFor(
  userId: string
): Promise<{ client: OpenAI; source: KeySource } | null> {
  const key = await openaiKeyFor(userId);
  if (!key) return null;
  if (!key.rowId) return { client: openai, source: key.source };
  const cached = userClients.get(key.rowId);
  if (cached) return { client: cached, source: key.source };
  const client = new OpenAI({ apiKey: key.apiKey });
  userClients.set(key.rowId, client);
  return { client, source: key.source };
}

/** openaiClientFor without the key's name: the client, or null. */
export async function openaiFor(userId: string): Promise<OpenAI | null> {
  return (await openaiClientFor(userId))?.client ?? null;
}

/** Invalidate the per-user client cache after connect/disconnect. */
export function forgetOpenaiClient(rowId: string): void {
  userClients.delete(rowId);
}

export const TEXT_MODEL = process.env.TEXT_MODEL ?? "gpt-5.5";
// Layout planner (SPEC §6): small/fast tier — one JSON call per dashboard
// open on changed signals; quiet days are served from cache.
export const PLANNER_MODEL = process.env.PLANNER_MODEL ?? "gpt-5.4-nano";
// Dictation (HTTP /v1/audio/transcriptions). gpt-4o-transcribe hallucinated
// on silence/noise (verified: emitted Arabic for a silent clip); gpt-transcribe
// returns empty for silence and is the current flagship.
export const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL ?? "gpt-transcribe";
// Live captions inside realtime sessions — realtime-only model, purpose-built
// for streaming input transcription.
export const REALTIME_TRANSCRIBE_MODEL =
  process.env.REALTIME_TRANSCRIBE_MODEL ?? "gpt-live-transcribe";
// Pinning the language avoids whole-language misrecognitions on mumbles.
export const TRANSCRIBE_LANGUAGE = process.env.TRANSCRIBE_LANGUAGE ?? "en";
export const REALTIME_MODEL_DEFAULT =
  process.env.REALTIME_MODEL_DEFAULT ?? "gpt-realtime-2.1";
export const REALTIME_MODEL_MINI =
  process.env.REALTIME_MODEL_MINI ?? "gpt-realtime-2.1-mini";
export const REALTIME_VOICE = "marin";
// Reading a reply aloud (app/api/speak): the TTS model that speaks the
// realtime voices by name, and the ones it has.
export const TTS_MODEL = process.env.TTS_MODEL ?? "gpt-4o-mini-tts";
export const TTS_VOICES = [
  "marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse",
] as const;
// Every stock realtime voice (all mint-verified 2026-08-19). marin/cedar are
// the expressive flagship pair; the rest are the classic set.
export const REALTIME_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;
