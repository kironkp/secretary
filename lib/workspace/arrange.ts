// Arranging the Workspace by voice or chat (SEC-A008a, docs/workspace/SPEC.md
// §6): "put the overdue one at the top right", "move projects up", "make
// coming up bigger". The words name a widget and a place; this turns them
// into the same geometry ops a drag or the phone's move buttons send
// (ops.ts), applied and saved the same way the board's own POST does. No
// model call: the model only picks the op and repeats the user's words.
import { applyOps, boardRows, readingOrder } from "./ops";
import { getBoard, saveBoard } from "./store";
import { ARRANGE_WORKSPACE_OPS, GRID_COLS, MIN_H, MIN_W, PLACES, SIZES, type Op, type Widget } from "./types";
export { ARRANGE_WORKSPACE_OPS, PLACES, SIZES };


export type SpokenOp = {
  op: (typeof ARRANGE_WORKSPACE_OPS)[number];
  widget?: string;
  where?: (typeof PLACES)[number];
  size?: (typeof SIZES)[number];
};

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(the|my|our|widget|box|card|panel|one|section)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The widget the user named: its title or id, whole or in part. */
export function findWidget(widgets: Widget[], said: string): Widget | { error: string } {
  const want = words(said);
  const titled = widgets.map((w) => ({ w, title: words(w.title), id: words(w.id.replace(/-/g, " ")) }));
  const exact = titled.filter((t) => t.title === want || t.id === want);
  if (exact.length === 1) return exact[0].w;
  const partial = titled.filter((t) => want && (t.title.includes(want) || want.includes(t.title)));
  if (partial.length === 1) return partial[0].w;
  const names = widgets.map((w) => w.title).join(", ");
  return { error: partial.length > 1 ? `"${said}" could be ${partial.map((p) => p.w.title).join(" or ")}. Which one?` : `There's no "${said}" on the Workspace. It has: ${names}.` };
}

/** The engine ops for one spoken op, against the board as it is now. */
export function compile(widgets: Widget[], spoken: SpokenOp): { ops: Op[]; said: string } | { error: string } {
  if (spoken.op === "tidy" || spoken.op === "undo" || spoken.op === "redo") {
    return { ops: [{ op: spoken.op }], said: spoken.op === "tidy" ? "tidied the board" : spoken.op === "undo" ? "undid the last change" : "redid it" };
  }
  if (!spoken.widget) return { error: `Which widget? It has: ${widgets.map((w) => w.title).join(", ")}.` };
  const found = findWidget(widgets, spoken.widget);
  if ("error" in found) return found;
  const w = found;
  const order = readingOrder(widgets);
  const at = order.findIndex((x) => x.id === w.id);
  const below = boardRows(widgets.filter((x) => x.id !== w.id));
  switch (spoken.op) {
    case "move_to_top":
      return at <= 0 ? { ops: [], said: `${w.title} is already at the top` } : { ops: [{ op: "move_before", id: w.id, before: order[0].id }], said: `moved ${w.title} to the top` };
    case "move_to_bottom":
      return { ops: [{ op: "place", id: w.id, x: w.x, y: below }], said: `moved ${w.title} to the bottom` };
    case "move_up":
      return at <= 0 ? { ops: [], said: `${w.title} is already first` } : { ops: [{ op: "move_before", id: w.id, before: order[at - 1].id }], said: `moved ${w.title} up` };
    case "move_down":
      return at >= order.length - 1
        ? { ops: [], said: `${w.title} is already last` }
        : { ops: [{ op: "move_before", id: order[at + 1].id, before: w.id }], said: `moved ${w.title} down` };
    case "place": {
      const where = spoken.where ?? "top";
      const right = GRID_COLS - w.w;
      const spot: Record<(typeof PLACES)[number], { x: number; y: number }> = {
        top_left: { x: 0, y: 0 },
        top_right: { x: right, y: 0 },
        bottom_left: { x: 0, y: below },
        bottom_right: { x: right, y: below },
        top: { x: w.x, y: 0 },
        bottom: { x: w.x, y: below },
        left: { x: 0, y: w.y },
        right: { x: right, y: w.y },
      };
      return { ops: [{ op: "place", id: w.id, ...spot[where] }], said: `moved ${w.title} to the ${where.replace("_", " ")}` };
    }
    case "resize": {
      const size = spoken.size ?? "bigger";
      const clampW = (n: number) => Math.min(GRID_COLS, Math.max(MIN_W, n));
      const clampH = (n: number) => Math.min(60, Math.max(MIN_H, n));
      const to: Record<(typeof SIZES)[number], { w: number; h: number }> = {
        small: { w: 4, h: 4 },
        medium: { w: 6, h: 6 },
        large: { w: 8, h: 9 },
        full_width: { w: GRID_COLS, h: w.h },
        bigger: { w: clampW(w.w + 2), h: clampH(w.h + 2) },
        smaller: { w: clampW(w.w - 2), h: clampH(w.h - 2) },
      };
      // Resize, then settle it where it is: a widget that grew pushes what it
      // now covers down rather than sitting on top of it.
      return {
        ops: [
          { op: "resize", id: w.id, ...to[size] },
          { op: "place", id: w.id },
        ],
        said: `made ${w.title} ${size === "full_width" ? "full width" : size}`,
      };
    }
    case "collapse":
    case "expand":
    case "remove":
      return { ops: [{ op: spoken.op, id: w.id }], said: `${spoken.op === "remove" ? "removed" : spoken.op === "collapse" ? "collapsed" : "opened"} ${w.title}` };
  }
}

export type ArrangeWorkspaceResult = { ok: true; said: string[]; version: number } | { ok: false; error: string };

/**
 * Apply spoken ops to the user's board, one after another (each against the
 * board the previous one left), as ONE batch: one save, one undo step.
 */
export async function arrangeWorkspace(userId: string, spoken: SpokenOp[]): Promise<ArrangeWorkspaceResult> {
  const stored = await getBoard(userId);
  let board = stored.board;
  const ops: Op[] = [];
  const said: string[] = [];
  for (const s of spoken) {
    const compiled = compile(board.widgets, s);
    if ("error" in compiled) return { ok: false, error: compiled.error };
    if (compiled.ops.length) board = applyOps(board, compiled.ops);
    ops.push(...compiled.ops);
    said.push(compiled.said);
  }
  if (ops.length === 0) return { ok: true, said, version: stored.version };
  // The whole request as one batch from the stored board: one history entry.
  const saved = await saveBoard(userId, stored.id, applyOps(stored.board, ops), stored.version);
  if (!saved) return { ok: false, error: "The Workspace changed while I was moving things. Say it again?" };
  return { ok: true, said, version: saved.version };
}
