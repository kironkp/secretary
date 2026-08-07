// Structured briefing for the chat briefing card (W6) — same source of truth
// as the voice greeting.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { buildBriefing } from "@/lib/secretary/briefing";

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const briefing = await buildBriefing(user.id, user.timezone);
  return NextResponse.json(briefing.card);
}
