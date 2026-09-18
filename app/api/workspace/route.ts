// The Workspace board: read it, and change its geometry.
//
// The split that matters (the same one app/api/canvas/route.ts draws): a POST
// here changes POSITION, SIZE, VISIBILITY, STACKING and FOCUS with no model
// call and no repaint. It is a jsonb write, and the shell animates. Voice will
// reach the identical engine in phase 4 through lib/workspace/ops.ts, so a
// spoken move and a dragged move are the same operation on the same object.
import { NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { applyOps } from "@/lib/workspace/ops";
import { getBoard, saveBoard } from "@/lib/workspace/store";
import { opSchema } from "@/lib/workspace/types";

const bodySchema = z.object({
  // Bounded: a batch is one gesture or one spoken sentence, never a program.
  operations: z.array(opSchema).min(1).max(20),
  // The version the client last saw. Omit only for a deliberate overwrite.
  version: z.number().int().min(0).optional(),
});

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const stored = await getBoard(user.id);
  return NextResponse.json({
    id: stored.id,
    name: stored.name,
    version: stored.version,
    widgets: stored.board.widgets,
    focusId: stored.board.focusId,
    canUndo: stored.board.undo.length > 0,
    canRedo: stored.board.redo.length > 0,
  });
}

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const stored = await getBoard(user.id);
  const next = applyOps(stored.board, parsed.operations);

  const saved = await saveBoard(
    user.id,
    stored.id,
    next,
    parsed.version ?? stored.version
  );

  if (!saved) {
    // Someone else moved first. Hand back the truth rather than clobbering it;
    // the client re-renders from this instead of keeping its optimistic guess.
    const fresh = await getBoard(user.id);
    return NextResponse.json(
      {
        error: "stale",
        version: fresh.version,
        widgets: fresh.board.widgets,
        focusId: fresh.board.focusId,
        canUndo: fresh.board.undo.length > 0,
        canRedo: fresh.board.redo.length > 0,
      },
      { status: 409 }
    );
  }

  return NextResponse.json({
    id: saved.id,
    name: saved.name,
    version: saved.version,
    widgets: saved.board.widgets,
    focusId: saved.board.focusId,
    canUndo: saved.board.undo.length > 0,
    canRedo: saved.board.redo.length > 0,
  });
}
