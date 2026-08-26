// Shop requests plane: list for Settings; approve/reject (same actions the
// review_capability chat tool performs — one store, two doors).
import { NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { approveRequest, listRequests, rejectRequest } from "@/lib/shop/shop";

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const rows = await listRequests(user.id);
  return NextResponse.json({
    requests: rows.map((r) => ({
      id: r.id,
      need: r.need,
      status: r.status,
      plan: r.plan,
      branch: r.branch,
      buildLog: r.status === "failed" ? r.buildLog : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
}

const bodySchema = z.object({
  id: z.string().min(1),
  action: z.enum(["approve", "reject"]),
});

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  if (parsed.action === "reject") {
    const ok = await rejectRequest(user.id, parsed.id);
    return ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const res = await approveRequest(user.id, parsed.id);
  return res.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: res.error }, { status: 400 });
}
