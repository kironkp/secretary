// ElevenLabs config (the experimental "mouth" — SPEC voice track, Part B).
// Configured only when both env vars exist; everything degrades to the
// native OpenAI voice path when absent.
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
export const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
// eleven_v3 = max expressiveness (audio tags); eleven_flash_v2_5 = low latency.
export const EL_TTS_MODEL = process.env.EL_TTS_MODEL ?? "eleven_v3";

export const elevenLabsConfigured = () =>
  Boolean(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID);

/** Sentinel used in the voice dropdown / token request for the EL mouth. */
export const EL_MOUTH_VOICE = "elevenlabs";
