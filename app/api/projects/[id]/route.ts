// Project management: detail, rename/recolor/archive, delete. Deleting a
// project unfiles its tasks/events/documents automatically (FK onDelete
// set-null) — nothing is ever destroyed except the project row itself.
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { documents, events, projects, tasks } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
    .limit(1);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [taskRows, eventRows, docRows] = await Promise.all([
    db.select().from(tasks).where(and(eq(tasks.userId, user.id), eq(tasks.projectId, id))),
    db.select().from(events).where(and(eq(events.userId, user.id), eq(events.projectId, id))),
    db
      .select()
      .from(documents)
      .where(and(eq(documents.userId, user.id), eq(documents.projectId, id))),
  ]);
  return NextResponse.json({ project, tasks: taskRows, events: eventRows, documents: docRows });
}

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  color: z.string().max(24).nullable().optional(),
  status: z.enum(["active", "someday", "archived"]).optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;

  const parsed = parseBody(patchSchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const updates: Partial<typeof projects.$inferInsert> = {};
  if (parsed.name !== undefined) updates.name = parsed.name;
  if (parsed.color !== undefined) updates.color = parsed.color;
  if (parsed.status !== undefined) updates.status = parsed.status;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const [updated] = await db
    .update(projects)
    .set(updates)
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
    .returning();
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ project: updated });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;

  const [deleted] = await db
    .delete(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
    .returning();
  if (!deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deleted: deleted.name, note: "its tasks/events/documents are now unfiled" });
}
