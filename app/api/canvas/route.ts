// Canvas data plane: latest snapshot (polled while painting), history list,
// one-tap restore. The canvas never mutates app state — this route only
// touches canvas_snapshots.
import { NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { latestSnapshot, listSnapshots, restoreSnapshot } from "@/lib/canvas/painter";
import { buildCanvasSrcDoc } from "@/lib/canvas/sanitize";

export async function GET(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const url = new URL(req.url);
  if (url.searchParams.get("list") === "1") {
    return NextResponse.json({ snapshots: await listSnapshots(user.id) });
  }
  const dark = url.searchParams.get("dark") === "1";
  const latest = await latestSnapshot(user.id);
  if (!latest) return NextResponse.json({ snapshot: null });
  return NextResponse.json({
    snapshot: {
      id: latest.id,
      brief: latest.brief,
      painting: latest.painting,
      createdAt: latest.createdAt.toISOString(),
      srcdoc: buildCanvasSrcDoc(latest.markup, { dark }),
    },
  });
}

const bodySchema = z.object({ action: z.literal("restore"), id: z.string().min(1) });

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;
  const ok = await restoreSnapshot(user.id, parsed.id);
  if (!ok) return NextResponse.json({ error: "No such snapshot" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
