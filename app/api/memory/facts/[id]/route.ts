// Forget one fact (the Memory tab's delete). Scoped to the caller's own rows:
// someone else's id is a 404, not a delete.
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;
  const deleted = await db
    .delete(memories)
    .where(and(eq(memories.id, id), eq(memories.userId, user.id)))
    .returning({ id: memories.id });
  if (deleted.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
