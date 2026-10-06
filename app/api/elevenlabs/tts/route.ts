// ElevenLabs TTS proxy: the key never reaches the browser. POST {text} →
// audio bytes (mp3). GET → {configured} so the voice picker knows whether to
// offer the ElevenLabs mouth at all.
import { NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import {
  EL_TTS_MODEL,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  elevenLabsConfigured,
} from "@/lib/elevenlabs";
import { recordUsage } from "@/lib/usage";

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  return NextResponse.json({ configured: elevenLabsConfigured(), model: EL_TTS_MODEL });
}

const bodySchema = z.object({ text: z.string().min(1).max(2000) });

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  if (!elevenLabsConfigured()) {
    return NextResponse.json({ error: "ElevenLabs isn't configured" }, { status: 503 });
  }
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: parsed.text, model_id: EL_TTS_MODEL }),
    }
  );
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    console.error("elevenlabs tts failed:", res.status, detail.slice(0, 300));
    return NextResponse.json({ error: "TTS failed" }, { status: 502 });
  }

  // "speech", priced per character, which is how ElevenLabs bills (SEC-A004):
  // filed as "voice" with seconds and no characters, every sentence cost $0
  // and used up a voice-call slot of the daily quota.
  await recordUsage({
    userId: user.id,
    kind: "speech",
    model: `elevenlabs/${EL_TTS_MODEL}`,
    characters: parsed.text.length,
  });

  return new Response(res.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}
