import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const TEXT_MODEL = process.env.TEXT_MODEL ?? "gpt-5.5";
// Layout planner (SPEC §6): small/fast tier — one JSON call per dashboard
// open on changed signals; quiet days are served from cache.
export const PLANNER_MODEL = process.env.PLANNER_MODEL ?? "gpt-5.4-nano";
export const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL ?? "gpt-4o-transcribe";
export const REALTIME_MODEL_DEFAULT =
  process.env.REALTIME_MODEL_DEFAULT ?? "gpt-realtime-2.1";
export const REALTIME_MODEL_MINI =
  process.env.REALTIME_MODEL_MINI ?? "gpt-realtime-2.1-mini";
export const REALTIME_VOICE = "marin";
