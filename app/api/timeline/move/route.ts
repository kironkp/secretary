// A move on the timeline (SEC-A009): a drag, a tray drop, an arrow key or an
// undo. The SAME operation as saying it (CLAUDE.md: a spoken move and a
// dragged move are the same operation on the same object): update_task or
// update_event through executeTool, in a live turn of the user's own, so a
// Google-synced event is patched on Google, a later due date counts as
// postponed, the dates are validated, and nothing here writes a row itself.
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { db } from "@/lib/db";
import { events } from "@/lib/db/schema";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";
import { eventSnapshot, eventTicket, sealUndo, taskSnapshot, taskTicket } from "@/lib/timeline-undo";

const iso = z.string().min(1).max(40);
const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task"),
    id: z.string().min(1).max(80),
    /** null takes the due date off (an undo of a drop from the No-date tray). */
    due_at: iso.nullable().optional(),
    /** null clears the planned start (an undo of pulling one out). */
    start_at: iso.nullable().optional(),
    reminders: z.array(iso).max(20).optional(),
  }),
  z.object({
    kind: z.literal("event"),
    id: z.string().min(1).max(80),
    starts_at: iso.optional(),
    ends_at: iso.optional(),
    reminders: z.array(iso).max(20).optional(),
  }),
]);

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  // The user's own move, in their own words as it were: Google is written at once.
  const ctx = liveTurnContext({ userId: user.id, timezone: user.timezone, attachmentCount: 0 });

  if (parsed.kind === "task") {
    // What Undo will need, read before the tool can change it.
    const snap = await taskSnapshot(user.id, parsed.id);
    const outcome = await executeTool(ctx, "update_task", {
      task: parsed.id,
      ...(parsed.due_at !== undefined ? { due_at: parsed.due_at ?? "none" } : {}),
      ...(parsed.start_at !== undefined ? { start_at: parsed.start_at ?? "none" } : {}),
      ...(parsed.reminders ? { reminders: parsed.reminders } : {}),
    });
    if (hasError(outcome.result) || !snap) return NextResponse.json(outcome, { status: 422 });
    return NextResponse.json({ ...outcome, undo: sealUndo(await taskTicket(user.id, parsed.id, snap)) });
  }

  // T2: a repeating event is moved by asking, not by dragging, in v1.
  const [event] = await db
    .select({ recurrence: events.recurrence })
    .from(events)
    .where(and(eq(events.id, parsed.id), eq(events.userId, user.id)))
    .limit(1);
  if (!event) return NextResponse.json({ result: { error: "Not found" } }, { status: 404 });
  if (event.recurrence.length > 0) {
    return NextResponse.json({ result: { error: "A repeating event moves when you ask, not by dragging." } }, { status: 409 });
  }
  const before = await eventSnapshot(user.id, parsed.id);
  const outcome = await executeTool(ctx, "update_event", {
    event: parsed.id,
    ...(parsed.starts_at ? { starts_at: parsed.starts_at } : {}),
    ...(parsed.ends_at ? { ends_at: parsed.ends_at } : {}),
    ...(parsed.reminders ? { reminders: parsed.reminders } : {}),
  });
  if (hasError(outcome.result) || !before) return NextResponse.json(outcome, { status: 422 });
  return NextResponse.json({ ...outcome, undo: sealUndo(await eventTicket(user.id, parsed.id, before)) });
}

const hasError = (r: unknown) => typeof r === "object" && r !== null && "error" in r;
