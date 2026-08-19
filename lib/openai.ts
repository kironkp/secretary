import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
