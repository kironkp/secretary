// Photo/file intake, step 1: upload. The composer posts each picked file here
// immediately (multipart), gets back an id, and passes the ids to /api/chat on
// send. Payloads live in Postgres — Heroku's filesystem is ephemeral.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { attachments } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";
import { MAX_STORE_BYTES, safeName } from "@/lib/attachments";

// Any file type may be stored. What the model can do with it is decided later
// by classifyAttachment, and what the browser is allowed to do with it is
// decided by the serving route — the mime here is client-supplied and is never
// trusted as a safety boundary.

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_STORE_BYTES) {
    return NextResponse.json({ error: "Too large — 25 MB max." }, { status: 413 });
  }

  const data = Buffer.from(await file.arrayBuffer());
  const [row] = await db
    .insert(attachments)
    .values({
      userId: user.id,
      mime: file.type || "application/octet-stream",
      name: safeName(file.name || "file"),
      data,
    })
    .returning({ id: attachments.id, mime: attachments.mime, name: attachments.name });

  return NextResponse.json(row);
}
