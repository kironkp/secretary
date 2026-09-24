// Read a reply aloud (SPEC §7.7): POST {text, voice?} → mp3, in the user's
// chosen realtime voice through OpenAI TTS, so a typed answer sounds like the
// secretary on a call. The key never reaches the browser.
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { openai, REALTIME_VOICE, TTS_MODEL, TTS_VOICES } from "@/lib/openai";

const bodySchema = z.object({ text: z.string().trim().min(1).max(4000), voice: z.string().max(40).optional() });

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;
  // A voice the TTS model does not have (the ElevenLabs mouth, an old name)
  // falls back to the house voice rather than failing.
  const voice = (TTS_VOICES as readonly string[]).includes(parsed.voice ?? "") ? parsed.voice! : REALTIME_VOICE;

  try {
    const res = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice,
      input: parsed.text,
      response_format: "mp3",
    });
    await db.insert(usage).values({
      userId: user.id,
      kind: "voice",
      model: TTS_MODEL,
      seconds: Math.max(1, Math.round(parsed.text.length / 15)), // rough speech-time estimate
    });
    return new Response(res.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("speak failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not read that aloud right now." }, { status: 502 });
  }
}
