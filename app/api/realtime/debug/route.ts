// Voice-call diagnostics beacon: the WebRTC client posts a few snapshots early
// in each call (connection state, outbound audio bytes/level, events received)
// so call failures on phones are debuggable from the server log.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const body = await req.json().catch(() => ({}));
  console.log(
    `[voice-debug] user=${user.id.slice(0, 8)} ${JSON.stringify(body)} ua=${req.headers.get("user-agent") ?? "?"}`
  );
  return NextResponse.json({ ok: true });
}
