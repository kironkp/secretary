// The geometry engine. Pure, so it is testable here; the parts that need a
// finger and a layout engine are in e2e/workspace.spec.ts, because nothing in
// this file can see whether a human can actually drag anything.
import { describe, expect, it } from "vitest";
import { addWidget, applyOps, boardRows, nextWidgetId, tidy } from "@/lib/workspace/ops";
import {
  boardSchema,
  EMPTY_BOARD,
  GRID_COLS,
  MIN_H,
  MIN_W,
  type Board,
  type Widget,
} from "@/lib/workspace/types";

const w = (id: string, over: Partial<Widget> = {}): Widget => ({
  id,
  title: id,
  x: 0,
  y: 0,
  w: 6,
  h: 4,
  z: 1,
  collapsed: false,
  body: "",
  ...over,
});

const board = (...widgets: Widget[]): Board => ({ ...EMPTY_BOARD, widgets });

describe("move", () => {
  it("clamps to the board instead of refusing", () => {
    const next = applyOps(board(w("a", { w: 6 })), [{ op: "move", id: "a", x: 99, y: 3, w: 6 }]);
    // Widest legal left edge for a 6-wide widget on a 12-column grid.
    expect(next.widgets[0].x).toBe(GRID_COLS - 6);
    expect(next.widgets[0].y).toBe(3);
  });

  it("never lets a widget go above the top", () => {
    const next = applyOps(board(w("a", { y: 2 })), [{ op: "move", id: "a", y: -5 }]);
    expect(next.widgets[0].y).toBe(0);
  });

  it("leaves every other widget untouched — the whole point of the surface", () => {
    const before = board(w("a"), w("b", { x: 6, y: 2 }));
    const next = applyOps(before, [{ op: "move", id: "a", x: 3, y: 7 }]);
    expect(next.widgets[1]).toEqual(before.widgets[1]);
  });
});

describe("resize", () => {
  it("honours the minimum", () => {
    const next = applyOps(board(w("a")), [{ op: "resize", id: "a", w: 1, h: 1 }]);
    expect(next.widgets[0].w).toBe(MIN_W);
    expect(next.widgets[0].h).toBe(MIN_H);
  });

  it("pulls a widget back onto the board when it grows at the right edge", () => {
    const next = applyOps(board(w("a", { x: 9, w: 3 })), [{ op: "resize", id: "a", w: 12 }]);
    expect(next.widgets[0].x).toBe(0);
    expect(next.widgets[0].w).toBe(GRID_COLS);
  });
});

describe("tidy", () => {
  it("packs upward and removes the gaps", () => {
    const next = tidy([w("a", { y: 5, w: 12, h: 2 }), w("b", { y: 20, w: 12, h: 3 })]);
    expect(next.map((x) => x.y)).toEqual([0, 2]);
  });

  it("keeps side-by-side widgets side by side", () => {
    const next = tidy([w("a", { x: 0, w: 6, h: 3 }), w("b", { x: 6, w: 6, h: 3 })]);
    expect(next.every((x) => x.y === 0)).toBe(true);
  });

  it("stacks widgets that share a column", () => {
    const next = tidy([w("a", { x: 0, w: 6, h: 3 }), w("b", { x: 3, w: 6, h: 3, y: 9 })]);
    expect(next[1].y).toBe(3);
  });
});

describe("undo and redo", () => {
  it("returns the board to where it was", () => {
    const start = board(w("a"));
    const moved = applyOps(start, [{ op: "move", id: "a", x: 4, y: 4 }]);
    const back = applyOps(moved, [{ op: "undo" }]);
    expect(back.widgets[0].x).toBe(0);
    expect(back.widgets[0].y).toBe(0);
    expect(applyOps(back, [{ op: "redo" }]).widgets[0].x).toBe(4);
  });

  it("treats one batch as one step, so undo matches one gesture", () => {
    const start = board(w("a"), w("b", { x: 6 }));
    const batched = applyOps(start, [
      { op: "move", id: "a", x: 2 },
      { op: "move", id: "b", x: 8 },
    ]);
    const back = applyOps(batched, [{ op: "undo" }]);
    expect(back.widgets.map((x) => x.x)).toEqual([0, 6]);
  });

  it("does nothing at the bottom of the stack", () => {
    const start = board(w("a"));
    expect(applyOps(start, [{ op: "undo" }]).widgets).toEqual(start.widgets);
  });

  it("drops the redo stack once a new move happens", () => {
    const start = board(w("a"));
    const undone = applyOps(applyOps(start, [{ op: "move", id: "a", x: 4 }]), [{ op: "undo" }]);
    expect(applyOps(undone, [{ op: "move", id: "a", x: 7 }]).redo).toHaveLength(0);
  });
});

describe("focus", () => {
  it("is interaction state, not geometry, so it never enters the undo stack", () => {
    const next = applyOps(board(w("a")), [{ op: "focus", id: "a" }]);
    expect(next.focusId).toBe("a");
    expect(next.undo).toHaveLength(0);
  });
});

describe("collapse, raise, remove", () => {
  it("collapses and expands", () => {
    const c = applyOps(board(w("a")), [{ op: "collapse", id: "a" }]);
    expect(c.widgets[0].collapsed).toBe(true);
    expect(applyOps(c, [{ op: "expand", id: "a" }]).widgets[0].collapsed).toBe(false);
  });

  it("raises above everything else", () => {
    const next = applyOps(board(w("a", { z: 1 }), w("b", { z: 9 })), [{ op: "raise", id: "a" }]);
    expect(next.widgets[0].z).toBeGreaterThan(9);
  });

  it("never lets z escape the range the schema accepts", () => {
    // A board that fails validation is REPLACED on the next read, so an
    // unbounded z would quietly destroy an arrangement after enough raises.
    let b = board(w("a", { z: 998 }), w("b", { z: 999 }));
    for (let i = 0; i < 12; i++) {
      b = applyOps(b, [{ op: "raise", id: i % 2 ? "a" : "b" }]);
    }
    for (const x of b.widgets) {
      expect(x.z).toBeGreaterThanOrEqual(0);
      expect(x.z).toBeLessThanOrEqual(999);
    }
    // And the whole board still parses, which is the thing that matters.
    expect(boardSchema.safeParse(b).success).toBe(true);
  });

  it("removes only the named widget", () => {
    const next = applyOps(board(w("a"), w("b")), [{ op: "remove", id: "a" }]);
    expect(next.widgets.map((x) => x.id)).toEqual(["b"]);
  });

  it("ignores an id that is not on the board", () => {
    const start = board(w("a"));
    expect(applyOps(start, [{ op: "move", id: "ghost", x: 5 }]).widgets).toEqual(start.widgets);
  });
});

describe("adding", () => {
  it("places a new widget below everything and on top of the stack", () => {
    const one = addWidget(EMPTY_BOARD, {
      id: "a",
      title: "A",
      x: 0,
      w: 12,
      h: 3,
      collapsed: false,
      body: "",
    });
    const two = addWidget(one, {
      id: "b",
      title: "B",
      x: 0,
      w: 12,
      h: 3,
      collapsed: false,
      body: "",
    });
    expect(two.widgets[1].y).toBe(3);
    expect(two.widgets[1].z).toBeGreaterThan(two.widgets[0].z);
  });

  it("makes ids readable, stable and unique", () => {
    const existing = [w("today")];
    expect(nextWidgetId(existing, "Today")).toBe("today-2");
    expect(nextWidgetId(existing, "Caltrans budget")).toBe("caltrans-budget");
    expect(nextWidgetId([], "!!!")).toBe("widget");
  });
});

describe("board height", () => {
  it("is the bottom of the lowest widget", () => {
    expect(boardRows([w("a", { y: 0, h: 3 }), w("b", { y: 7, h: 2 })])).toBe(9);
  });

  it("is zero for an empty board", () => {
    expect(boardRows([])).toBe(0);
  });
});
