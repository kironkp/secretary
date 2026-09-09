// Canvas data plane: latest snapshot (polled while painting), history list,
// one-tap restore, and the geometry operations that make the canvas a
// workspace.
//
// The split that matters here: `action: "ops"` changes ORDER, SIZE, VISIBILITY
// and THEME with no model call and no repaint — a jsonb write and the shell
// animates. Only content changes go through the painter.
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { canvasSnapshots } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import {
  doneCheckIds,
  latestSnapshot,
  listSnapshots,
  readComposition,
  restoreSnapshot,
} from "@/lib/canvas/painter";
import { buildCanvasSrcDoc } from "@/lib/canvas/sanitize";
import {
  applyCanvasOps,
  canvasOpSchema,
  compositionToMarkup,
  DEFAULT_THEME,
} from "@/lib/canvas/composition";

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

  const composition = readComposition(latest);
  const theme = composition?.theme ?? DEFAULT_THEME;

  return NextResponse.json({
    snapshot: {
      id: latest.id,
      brief: latest.brief,
      painting: latest.painting,
      createdAt: latest.createdAt.toISOString(),
      // Whole-canvas document: still served so the shell can fall back to the
      // single-frame render (and so anything else reading this keeps working).
      srcdoc: buildCanvasSrcDoc(latest.markup, { dark, theme }),
      theme,
      // The workspace: one sandboxed document per block, laid out by the shell.
      blocks: (composition?.blocks ?? [])
        .filter((b) => !b.hidden)
        .map((b) => ({
          id: b.id,
          span: b.span,
          pinned: b.pinned,
          srcdoc: buildCanvasSrcDoc(b.markup, { dark, theme, block: true }),
        })),
      // Cross-offs survive reloads (SPEC §7.6): tasks in this markup already
      // done, so the shell can seed its crossed-off set.
      doneTaskIds: await doneCheckIds(user.id, latest.markup),
    },
  });
}

const bodySchema = z.union([
  z.object({ action: z.literal("restore"), id: z.string().min(1) }),
  z.object({ action: z.literal("ops"), ops: z.array(canvasOpSchema).min(1).max(20) }),
]);

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;
  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  if (parsed.action === "restore") {
    const ok = await restoreSnapshot(user.id, parsed.id);
    if (!ok) return NextResponse.json({ error: "No such snapshot" }, { status: 404 });
    return NextResponse.json({ ok: true });
  }

  // Geometry: mutate the CURRENT snapshot in place. This is explicitly not a
  // new snapshot — rearranging the room is not a new picture, and a history
  // entry per nudge would bury the paints that matter.
  const latest = await latestSnapshot(user.id);
  const composition = readComposition(latest);
  if (!latest || !composition) {
    return NextResponse.json({ error: "No canvas yet" }, { status: 404 });
  }

  const { composition: next, applied, rejected } = applyCanvasOps(composition, parsed.ops);
  if (applied.length) {
    await db
      .update(canvasSnapshots)
      .set({ composition: next, markup: compositionToMarkup(next) })
      .where(and(eq(canvasSnapshots.id, latest.id), eq(canvasSnapshots.userId, user.id)));
  }
  return NextResponse.json({ ok: applied.length > 0, applied, rejected });
}
