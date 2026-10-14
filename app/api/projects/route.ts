import { NextResponse } from "next/server";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

/** Project list for pickers (the task editor's "file under" select). */
export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const rows = await db
    .select({ id: projects.id, name: projects.name, color: projects.color })
    .from(projects)
    .where(eq(projects.userId, user.id))
    .orderBy(asc(projects.name));
  return NextResponse.json({ projects: rows });
}

const createSchema = z.object({ name: z.string().max(120) });

/**
 * The Projects tab's "New project" (docs/projects/SPEC.md §5): the same path
 * the chat's create_project takes, so a near-duplicate is the project he
 * already has, not a second one. It arrives unplaced, at its urgency place.
 * An empty name makes nothing.
 */
export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(createSchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;
  const name = parsed.name.trim();
  if (!name) return NextResponse.json({ error: "A project needs a name." }, { status: 400 });
  const ctx = liveTurnContext({ userId: user.id, timezone: user.timezone ?? "UTC", attachmentCount: 0 });
  const made = (await executeTool(ctx, "create_project", { name })).result as { project_id?: string; name?: string; already_existed?: boolean; error?: string };
  if (!made.project_id) return NextResponse.json({ error: made.error ?? "Couldn't make the project." }, { status: 400 });
  return NextResponse.json({ projectId: made.project_id, name: made.name, alreadyExisted: made.already_existed === true }, { status: made.already_existed ? 200 : 201 });
}
