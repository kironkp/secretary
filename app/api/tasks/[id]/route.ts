import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, tasks } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";

const bodySchema = z.object({
  status: z.enum(["inbox", "todo", "in_progress", "blocked", "done", "dropped"]).optional(),
  title: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.number().int().min(0).max(3).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const [existing] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, user.id)))
    .limit(1);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updates: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
  if (parsed.status) {
    updates.status = parsed.status;
    if (parsed.status === "done") updates.completedAt = new Date();
    if (parsed.status === "in_progress" && !existing.startedAt) updates.startedAt = new Date();
  }
  if (parsed.title) updates.title = parsed.title;
  if (parsed.notes !== undefined) updates.notes = parsed.notes;
  if (parsed.priority !== undefined) updates.priority = parsed.priority;
  if (parsed.dueAt !== undefined) {
    const newDue = parsed.dueAt ? new Date(parsed.dueAt) : null;
    if (newDue && existing.dueAt && newDue.getTime() > existing.dueAt.getTime()) {
      updates.postponedCount = existing.postponedCount + 1;
    }
    updates.dueAt = newDue;
  }

  const [updated] = await db
    .update(tasks)
    .set(updates)
    .where(and(eq(tasks.id, id), eq(tasks.userId, user.id)))
    .returning();

  if (parsed.status === "done") {
    await db.insert(checkins).values({
      userId: user.id,
      taskId: id,
      type: "user_update",
      note: "Marked done from dashboard",
    });
  }

  return NextResponse.json({ task: updated });
}
