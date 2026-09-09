// Serve an attachment back to its owner (thumbnails in the thread).
//
// Any file type can be uploaded, so this route is the security boundary: only
// INLINE_MIME (raster images + PDF) is echoed back with its own mime for the
// browser to render. Everything else becomes opaque bytes with
// Content-Disposition: attachment, because a stored .html or .svg served
// inline would be a same-origin document running script under the session
// cookie. next.config.ts adds `default-src 'none'` for this path on top —
// a route handler cannot set its own CSP, the config's value wins.
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { attachments } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";
import { contentDisposition, INLINE_MIME } from "@/lib/attachments";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;

  const [row] = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.userId, user.id)))
    .limit(1);
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ?download=1 forces the save dialog even for previewable types.
  const wantsDownload = new URL(req.url).searchParams.get("download") === "1";
  const inline = INLINE_MIME.has(row.mime) && !wantsDownload;

  return new Response(new Uint8Array(row.data), {
    headers: {
      // Off the preview list the browser is never told what this is, so it
      // can't be parsed as a document. nosniff (set globally too, kept here so
      // the route reads correctly on its own) is what makes trusting the
      // claimed mime safe for the inline set.
      "Content-Type": inline ? row.mime : "application/octet-stream",
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", row.name),
      "X-Content-Type-Options": "nosniff",
      // immutable content, private to the owner
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
