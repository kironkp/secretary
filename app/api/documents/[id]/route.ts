// Document detail (page + dialog) and version restore.
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { documents, documentVersions } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { getDocumentDetail } from "@/lib/db/queries";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;
  const detail = await getDocumentDetail(user.id, id);
  if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(detail);
}

const bodySchema = z.object({
  action: z.literal("restore"),
  versionId: z.string(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, user.id)))
    .limit(1);
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [version] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.id, parsed.versionId),
        eq(documentVersions.userId, user.id),
        eq(documentVersions.documentId, id)
      )
    )
    .limit(1);
  if (!version) return NextResponse.json({ error: "Version not found" }, { status: 404 });

  // snapshot current state so the restore is itself revertible
  await db.insert(documentVersions).values({
    userId: user.id,
    documentId: id,
    title: doc.title,
    sections: doc.sections,
    note: "before restore",
  });
  const [updated] = await db
    .update(documents)
    .set({ title: version.title, sections: version.sections, updatedAt: new Date() })
    .where(and(eq(documents.id, id), eq(documents.userId, user.id)))
    .returning();

  return NextResponse.json({ document: updated });
}
