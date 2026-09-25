// Compile PDF (docs/understanding/SPEC.md §6): the packet as one PDF, cover
// checklist first, then the files in process order. Inline, so an iPad opens
// it in its viewer, where Share saves or sends it.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { compilePacket, getPacket } from "@/lib/secretary/packets";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const { id } = await params;
  const pdf = await compilePacket(user.id, id);
  if (!pdf) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const packet = await getPacket(user.id, id);
  const name = (packet?.title ?? "packet").replace(/[^\w .-]+/g, "").trim().slice(0, 80) || "packet";
  return new Response(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}
