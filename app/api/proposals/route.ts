// Slow-loop proposal review (SPEC §7): list pending proposals with a sandboxed
// preview, approve (hot-register) or reject (tombstone). The preview renders
// through the same canvas sanitizer/srcdoc lockdown as everything model-made.
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { wishlist } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { buildCanvasSrcDoc, sanitizeCanvasMarkup } from "@/lib/canvas/sanitize";
import { approveProposal, readProposal, rejectProposal } from "@/lib/layout/slow-loop";

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const rows = await db
    .select()
    .from(wishlist)
    .where(and(eq(wishlist.userId, user.id), eq(wishlist.status, "proposed")));
  const proposals = rows.flatMap((row) => {
    if (!row.proposalName) return [];
    const p = readProposal(row.proposalName);
    if (!p) return [];
    return [
      {
        name: row.proposalName,
        need: row.need,
        description: p.meta.description,
        preview_srcdoc: buildCanvasSrcDoc(sanitizeCanvasMarkup(p.preview)),
      },
    ];
  });
  return NextResponse.json({ proposals });
}

const bodySchema = z.object({
  name: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
});

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;
  if (parsed.decision === "approve") {
    const res = await approveProposal(user.id, parsed.name);
    if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
    return NextResponse.json({ ok: true, registry_version: res.registryVersion });
  }
  await rejectProposal(user.id, parsed.name);
  return NextResponse.json({ ok: true });
}
