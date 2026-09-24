// Stop one check-in from the Memory tab. Scoped to the caller's own rows.
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { standingCheckins } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;
  const deleted = await db
    .delete(standingCheckins)
    .where(and(eq(standingCheckins.id, id), eq(standingCheckins.userId, user.id)))
    .returning({ id: standingCheckins.id });
  if (deleted.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
