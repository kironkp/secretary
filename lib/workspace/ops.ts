// The geometry engine. Pure functions over a Board: no database, no React, no
// model call. Voice and touch both come here, which is what makes "move that
// up" and a drag the same operation on the same object.
//
// Every op is clamped rather than rejected. A spoken "make it huge" should land
// at the widest the board allows, not fail.
import {
  EMPTY_BOARD,
  GRID_COLS,
  MAX_WIDGETS,
  MIN_H,
  MIN_W,
  type Board,
  type Op,
  type Widget,
} from "./types";

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Geometry only. Bodies are large and never change under an op. */
function snapshot(widgets: Widget[]): Widget[] {
  return widgets.map((w) => ({ ...w }));
}

function withHistory(board: Board, next: Widget[]): Board {
  // Spread, never re-list: a field added to Board later must not silently be
  // dropped by every op that rebuilds one.
  return {
    ...board,
    widgets: next,
    undo: [snapshot(board.widgets), ...board.undo].slice(0, 20),
    redo: [],
  };
}

/** The schema's ceiling. A value past it fails validation on the next read,
 *  and a board that fails validation is REPLACED — so raising a widget a
 *  thousand times would silently destroy an arrangement. */
const MAX_Z = 999;

/** Highest z in use, so a raised widget always lands on top. */
function topZ(widgets: Widget[]): number {
  return widgets.reduce((m, w) => Math.max(m, w.z), 0);
}

/** Renumber from 1 when the stack hits the ceiling, preserving order. */
function normalizeZ(widgets: Widget[]): Widget[] {
  if (widgets.every((w) => w.z <= MAX_Z)) return widgets;
  const order = [...widgets].sort((a, b) => a.z - b.z).map((w) => w.id);
  return widgets.map((w) => ({ ...w, z: order.indexOf(w.id) + 1 }));
}

/**
 * Pack widgets upward, preserving reading order, removing vertical gaps and
 * overlaps. This is what rescues a board after a clumsy drag, so it is a
 * first-class command and not a debug tool.
 */
export function tidy(widgets: Widget[]): Widget[] {
  const order = [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  // Per-column skyline: the first free row in each grid column.
  const floor = new Array<number>(GRID_COLS).fill(0);
  return order.map((w) => {
    const x = clamp(w.x, 0, GRID_COLS - w.w);
    const span = floor.slice(x, x + w.w);
    const y = span.length ? Math.max(...span) : 0;
    for (let c = x; c < x + w.w; c++) floor[c] = y + w.h;
    return { ...w, x, y };
  });
}

/** Board height in grid rows, for sizing the scroll area. */
export function boardRows(widgets: Widget[]): number {
  return widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
}

function applyOne(board: Board, op: Op): Board {
  if (op.op === "undo") {
    const [prev, ...rest] = board.undo;
    if (!prev) return board;
    return {
      ...board,
      widgets: prev,
      undo: rest,
      redo: [snapshot(board.widgets), ...board.redo].slice(0, 20),
    };
  }
  if (op.op === "redo") {
    const [next, ...rest] = board.redo;
    if (!next) return board;
    return {
      ...board,
      widgets: next,
      undo: [snapshot(board.widgets), ...board.undo].slice(0, 20),
      redo: rest,
    };
  }
  if (op.op === "tidy") return withHistory(board, tidy(board.widgets));

  const target = board.widgets.find((w) => w.id === op.id);
  if (!target) return board;

  // Focus is interaction state, not geometry: it does not enter the undo stack,
  // because undoing a glance is meaningless.
  if (op.op === "focus") return { ...board, focusId: target.id };

  if (op.op === "remove") {
    return withHistory(
      board,
      board.widgets.filter((w) => w.id !== target.id)
    );
  }

  const edit = (fn: (w: Widget) => Widget) =>
    withHistory(
      board,
      board.widgets.map((w) => (w.id === target.id ? fn(w) : w))
    );

  switch (op.op) {
    case "collapse":
      return edit((w) => ({ ...w, collapsed: true }));
    case "expand":
      return edit((w) => ({ ...w, collapsed: false }));
    case "raise": {
      const raised = edit((w) => ({ ...w, z: Math.min(MAX_Z, topZ(board.widgets) + 1) }));
      return { ...raised, widgets: normalizeZ(raised.widgets) };
    }
    case "move": {
      const w = op.w ?? target.w;
      return edit((t) => ({
        ...t,
        x: clamp(op.x ?? t.x, 0, GRID_COLS - w),
        y: Math.max(0, op.y ?? t.y),
      }));
    }
    case "resize": {
      const width = clamp(op.w ?? target.w, MIN_W, GRID_COLS);
      return edit((t) => ({
        ...t,
        w: width,
        h: Math.max(MIN_H, op.h ?? t.h),
        // Keep it on the board when it grows at the right edge.
        x: clamp(t.x, 0, GRID_COLS - width),
      }));
    }
    default:
      return board;
  }
}

/** Apply a batch. One history entry per batch, so undo matches one gesture. */
export function applyOps(board: Board, ops: Op[]): Board {
  if (ops.length === 0) return board;
  let next = board;
  for (const op of ops) next = applyOne(next, op);
  // Collapse the batch's history to a single step, so one gesture is one undo.
  // Entries are PREPENDED, so of the ones this batch added, the oldest — the
  // state before the gesture — is the LAST of them. Keep that, drop the
  // intermediate states, and leave earlier history untouched.
  const added = next.undo.length - board.undo.length;
  if (added > 1) {
    next = { ...next, undo: [next.undo[added - 1], ...next.undo.slice(added)] };
  }
  return next;
}

/** A widget id that is stable, readable, and unused on this board. */
export function nextWidgetId(widgets: Widget[], seed: string): string {
  const base =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "widget";
  if (!widgets.some((w) => w.id === base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}-${n}`;
    if (!widgets.some((w) => w.id === candidate)) return candidate;
  }
  return `${base}-${widgets.length + 1}`;
}

/** Place a new widget below everything, full width by default. */
export function addWidget(board: Board, widget: Omit<Widget, "y" | "z">): Board {
  if (board.widgets.length >= MAX_WIDGETS) return board;
  const placed: Widget = {
    ...widget,
    y: boardRows(board.widgets),
    z: topZ(board.widgets) + 1,
  };
  return withHistory(board, [...board.widgets, placed]);
}

export { EMPTY_BOARD };
