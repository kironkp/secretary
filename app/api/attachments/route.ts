// Photo/file intake, step 1: upload. The composer posts each picked file here
// immediately (multipart), gets back an id, and passes the ids to /api/chat on
// send. Payloads live in Postgres — Heroku's filesystem is ephemeral.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { attachments } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";

// Images the vision model accepts; the client converts everything else
// (HEIC included) to JPEG before upload. PDFs go through as files.
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file" }, { status: 400 });
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return NextResponse.json(
      { error: "Photos (JPEG/PNG/WebP/GIF) and PDFs only." },
      { status: 415 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Too large — 8 MB max." }, { status: 413 });
  }

  const data = Buffer.from(await file.arrayBuffer());
  const [row] = await db
    .insert(attachments)
    .values({
      userId: user.id,
      mime: file.type,
      name: (file.name || "photo").slice(0, 200),
      data,
    })
    .returning({ id: attachments.id, mime: attachments.mime, name: attachments.name });

  return NextResponse.json(row);
}
