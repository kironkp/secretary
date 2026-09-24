// Forget one process (a pipeline template) from the Memory tab. Scoped to the
// caller's own rows. Tasks already built from the template keep their steps:
// they copied them, they do not reference the template.
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pipelineTemplates } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;
  const deleted = await db
    .delete(pipelineTemplates)
    .where(and(eq(pipelineTemplates.id, id), eq(pipelineTemplates.userId, user.id)))
    .returning({ id: pipelineTemplates.id });
  if (deleted.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
