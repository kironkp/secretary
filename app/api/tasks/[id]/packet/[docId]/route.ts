// Take one file out of a task's packet. The filing goes; the attachment's
// bytes go with it unless a chat message still shows them.
import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { attachments, taskDocuments } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";
import { getPacket } from "@/lib/secretary/packets";

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id, docId } = await params;
  const [gone] = await db
    .delete(taskDocuments)
    .where(and(eq(taskDocuments.userId, user.id), eq(taskDocuments.taskId, id), eq(taskDocuments.id, docId)))
    .returning({ attachmentId: taskDocuments.attachmentId });
  if (!gone) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await db
    .delete(attachments)
    .where(and(eq(attachments.userId, user.id), eq(attachments.id, gone.attachmentId), isNull(attachments.messageId)));
  return NextResponse.json(await getPacket(user.id, id));
}
