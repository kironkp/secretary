// The drag on the Projects tab (docs/projects/SPEC.md §2, §5): a project to
// a place in its group, counted in the order he sees. The same move as
// move_project; no model is asked.
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { moveProject } from "@/lib/projects/order";

const bodySchema = z.object({
  projectId: z.string().min(1),
  /** The place in its group, 0 at the top. */
  to: z.number().int().min(0),
});

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;
  const [his] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, parsed.projectId), eq(projects.userId, user.id)));
  if (!his) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const moved = await moveProject(user.id, his.id, { index: parsed.to });
  if (!moved.ok) return NextResponse.json({ error: moved.error }, { status: 400 });
  return NextResponse.json({ ok: true, place: moved.place, of: moved.of, says: moved.says, overviewCardStays: moved.overviewCardStays });
}
