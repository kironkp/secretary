// A task's packet (docs/understanding/SPEC.md §6): GET the checklist with what
// is filed; POST a file (multipart: file, docType) to file it under a name.
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { attachments, tasks } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";
import { MAX_STORE_BYTES, safeName } from "@/lib/attachments";
import { fileDocument, getPacket } from "@/lib/secretary/packets";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;
  const packet = await getPacket(user.id, id);
  if (!packet) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(packet);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, user.id), eq(tasks.id, id)));
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const docType = String(form?.get("docType") ?? "").trim();
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }
  if (!docType) return NextResponse.json({ error: "Which document is this?" }, { status: 400 });
  if (file.size > MAX_STORE_BYTES) {
    return NextResponse.json({ error: "Too large — 25 MB max." }, { status: 413 });
  }
  const [att] = await db
    .insert(attachments)
    .values({
      userId: user.id,
      mime: file.type || "application/octet-stream",
      name: safeName(file.name || "file"),
      data: Buffer.from(await file.arrayBuffer()),
    })
    .returning({ id: attachments.id });
  await fileDocument(user.id, id, att.id, docType);
  return NextResponse.json(await getPacket(user.id, id));
}
