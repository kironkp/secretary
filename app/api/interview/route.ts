// GET /api/interview — what the Interview tab reads (app/(app)/interview):
// every open question across the user's projects with its evidence, how many
// were answered today, and when a run last finished. It renders what is
// stored and never waits for a run (docs/understanding/SPEC.md §8).
//
// ?front=<question id> says which question the screen is showing when it is
// not the queue's own front (after "Skip for now"), so that one is the one
// marked surfaced: showing a question is asking it (SPEC §5).
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { buildInterview } from "@/lib/understanding/today";

export async function GET(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const front = new URL(req.url).searchParams.get("front")?.trim() || undefined;
  return NextResponse.json(await buildInterview(user.id, user.timezone, new Date(), { front }));
}
