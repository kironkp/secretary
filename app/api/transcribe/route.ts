// Dictation transcription (C-6 / Flow 5) — its own authenticated endpoint with
// its own rate limit, separate from the Realtime session.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";
import { checkTranscribeQuota } from "@/lib/rate-limit";
import { openai, TRANSCRIBE_LANGUAGE, TRANSCRIBE_MODEL } from "@/lib/openai";

const MAX_BYTES = 25 * 1024 * 1024;

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const quota = await checkTranscribeQuota(user.id);
  if (!quota.ok) {
    return NextResponse.json({ error: quota.message }, { status: quota.status });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No audio provided" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Recording too long" }, { status: 413 });
  }

  try {
    const result = await openai.audio.transcriptions.create({
      file,
      model: TRANSCRIBE_MODEL,
      language: TRANSCRIBE_LANGUAGE,
    });
    await db.insert(usage).values({
      userId: user.id,
      kind: "transcribe",
      model: TRANSCRIBE_MODEL,
      seconds: Math.round(file.size / 16000), // rough estimate
    });
    return NextResponse.json({ text: result.text });
  } catch (e) {
    console.error("transcribe failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Transcription failed. Try again." }, { status: 502 });
  }
}
