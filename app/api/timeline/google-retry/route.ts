// "Not on Google yet · Retry" after a moved event Google refused (SEC-A009,
// T6): the app keeps the move; this sends it again, through the same tool a
// spoken "add it to Google" uses.
import { NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

const bodySchema = z.object({ id: z.string().min(1).max(80) });

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;
  const ctx = liveTurnContext({ userId: user.id, timezone: user.timezone, attachmentCount: 0 });
  const outcome = await executeTool(ctx, "add_event_to_google", { event: parsed.id });
  return NextResponse.json(outcome);
}
