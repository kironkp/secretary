// Spend for one period. The UI swipes between periods, so this is called on
// every step — it reads priced rows and aggregates, nothing more.
import { NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { spendReport, spendWindow } from "@/lib/spend";

const querySchema = z.object({
  period: z.enum(["day", "week", "month"]),
  // Never positive: there is no spend in the future to look at.
  offset: z.number().int().min(-120).max(0),
});

export async function GET(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const url = new URL(req.url);
  const parsed = parseBody(querySchema, {
    period: url.searchParams.get("period") ?? "month",
    offset: Number(url.searchParams.get("offset") ?? 0),
  });
  if (isErrorResponse(parsed)) return parsed;

  const window = spendWindow(parsed.period, parsed.offset, user.timezone);
  return NextResponse.json({ report: await spendReport(user.id, window, user.timezone) });
}
