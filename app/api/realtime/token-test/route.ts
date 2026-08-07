// Minimal ephemeral-secret mint for the /voicetest baseline page: simplest
// possible Realtime session — no instructions, no tools, no transcription, no
// turn_detection override, no quota or usage writes. Same auth guard and key
// handling as the real token route.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { REALTIME_MODEL_DEFAULT, REALTIME_VOICE } from "@/lib/openai";

export async function POST() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: REALTIME_MODEL_DEFAULT,
        output_modalities: ["audio"],
        audio: { output: { voice: REALTIME_VOICE } },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[voicetest] client_secrets failed:", res.status, detail.slice(0, 500));
    return NextResponse.json({ error: `client_secrets ${res.status}` }, { status: 502 });
  }
  const secret = (await res.json()) as { value: string };
  return NextResponse.json({ clientSecret: secret.value, model: REALTIME_MODEL_DEFAULT });
}
