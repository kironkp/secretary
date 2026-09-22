// GET /api/today — the Today surface's data (docs/understanding/SPEC.md §9).
//
// Reads the last record and the stored questions; never waits for a run
// (SPEC §8, "never on read"). The page renders this once on the server and
// the client refetches it on focus and on a timer, so a question answered
// somewhere else disappears here without a reload.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { buildToday } from "@/lib/understanding/today";

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  return NextResponse.json(await buildToday(user.id, user.timezone));
}
