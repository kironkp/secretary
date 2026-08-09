// Scene 3, the deliverable: one button, a file an office accepts. Word opens
// HTML served as .doc natively — no document library, no external services.
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { documents } from "@/lib/db/schema";
import { isErrorResponse, requireSession } from "@/lib/api";

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;

  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, user.id)))
    .limit(1);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = doc.sections
    .map(
      (s) =>
        `<h2>${esc(s.heading)}</h2>\n` +
        s.content
          .split(/\n{2,}/)
          .map((p) => `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`)
          .join("\n")
    )
    .join("\n");

  const html = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(doc.title)}</title>
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.5;max-width:7in;margin:1in auto}h1{font-size:16pt}h2{font-size:13pt;margin-top:18pt}</style>
</head><body><h1>${esc(doc.title)}</h1>\n${body}</body></html>`;

  const filename = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document";
  return new NextResponse(html, {
    headers: {
      "Content-Type": "application/msword",
      "Content-Disposition": `attachment; filename="${filename}.doc"`,
    },
  });
}
