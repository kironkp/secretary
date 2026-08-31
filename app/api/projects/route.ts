import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";

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
