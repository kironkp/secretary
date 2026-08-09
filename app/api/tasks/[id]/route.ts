import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, projects, tasks } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { spawnNextOccurrence } from "@/lib/secretary/recurrence";

/** Full detail for the task dialog: every tool-writable field + history. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;

  const [row] = await db
    .select({ task: tasks, projectName: projects.name, projectColor: projects.color })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.id, id), eq(tasks.userId, user.id)))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const history = await db
    .select()
    .from(checkins)
    .where(and(eq(checkins.userId, user.id), eq(checkins.taskId, id)))
    .orderBy(desc(checkins.at))
    .limit(30);

  return NextResponse.json({
    task: row.task,
    projectName: row.projectName,
    projectColor: row.projectColor,
    history: history.map((h) => ({ id: h.id, type: h.type, note: h.note, at: h.at })),
  });
}

const bodySchema = z.object({
  status: z.enum(["inbox", "todo", "in_progress", "blocked", "done", "dropped"]).optional(),
  title: z.string().min(1).optional(),
  notes: z.string().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.number().int().min(0).max(3).optional(),
  stages: z.array(z.object({ name: z.string().min(1), done: z.boolean() })).optional(),
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
  if (parsed.stages !== undefined) updates.stages = parsed.stages;
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
    if (existing.status !== "done") await spawnNextOccurrence(updated);
  }

  return NextResponse.json({ task: updated });
}
