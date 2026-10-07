// Undo a timeline move (SEC-A009): it never happened. The browser hands back
// the sealed ticket the move returned (lib/timeline-undo.ts); the tool layer
// restores exactly what the move changed, and a Google-synced event is
// patched back on Google the same way it was moved.
import { NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { openUndo } from "@/lib/timeline-undo";
import { restoreEventMove, restoreTaskMove } from "@/lib/secretary/tools";

const bodySchema = z.object({ token: z.string().min(1).max(8_000) });

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const ticket = openUndo(parsed.token, user.id);
  if (!ticket) return NextResponse.json({ result: { error: "That undo is no longer available." } }, { status: 403 });

  const result = ticket.kind === "task" ? await restoreTaskMove(user.id, ticket) : await restoreEventMove(user.id, ticket);
  return NextResponse.json({ result }, { status: "error" in result ? 409 : 200 });
}
