// Shop requests plane: list for Settings; approve/reject (same actions the
// review_capability chat tool performs — one store, two doors).
import { NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { approveRequest, listRequests, rejectRequest, reviseRequest } from "@/lib/shop/shop";

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
      feedback: r.feedback,
      buildModel: r.buildModel,
      buildEffort: r.buildEffort,
      ultracode: r.ultracode,
      branch: r.branch,
      buildLog: r.status === "failed" ? r.buildLog : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
}

const bodySchema = z.object({
  id: z.string().min(1),
  action: z.enum(["approve", "reject", "feedback"]),
  feedback: z.string().max(4000).optional(),
  // Approve-time build preferences ("" = machine default)
  model: z.enum(["", "fable", "opus", "sonnet"]).optional(),
  effort: z.enum(["", "low", "medium", "high", "xhigh", "max"]).optional(),
  ultracode: z.boolean().optional(),
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
  if (parsed.action === "feedback") {
    if (!parsed.feedback?.trim()) {
      return NextResponse.json({ error: "Say what should change." }, { status: 400 });
    }
    const res = await reviseRequest(user.id, parsed.id, parsed.feedback.trim());
    return res.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: res.error }, { status: 400 });
  }
  const res = await approveRequest(user.id, parsed.id, undefined, {
    model: parsed.model,
    effort: parsed.effort,
    ultracode: parsed.ultracode,
  });
  return res.ok
    ? NextResponse.json({ ok: true, queued: res.queued })
    : NextResponse.json({ error: res.error }, { status: 400 });
}
