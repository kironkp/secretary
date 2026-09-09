// The shared world model. The bar: the user never speaks an id, voice and
// touch write the SAME state, and a destructive ambiguity asks rather than
// guesses.
import { describe, expect, it } from "vitest";
import { noteFocus, pruneFocus, resolveReference, type Resolvable } from "@/lib/canvas/focus";
import {
  applyCanvasOps,
  compositionFromMarkup,
  redoCanvas,
  undoCanvas,
} from "@/lib/canvas/composition";

const BLOCKS: Resolvable[] = [
  { id: "overdue", summary: "2 overdue: ADM-2011 signature packet", position: 0, hidden: false },
  { id: "today", summary: "5 things today", position: 1, hidden: false },
  { id: "caltrans-week", summary: "Caltrans this week: procurement, submittals", position: 2, hidden: false },
];

describe("resolving what the user meant", () => {
  it("a tap decides what \"this\" means a second later", () => {
    // The whole point of one shared state: touch writes it, voice reads it.
    const focus = noteFocus({}, { kind: "select", id: "today" });
    expect(resolveReference("this", BLOCKS, focus)).toMatchObject({ ids: ["today"] });
    expect(resolveReference("make this bigger", BLOCKS, focus).ok).toBe(true);
  });

  it("what Secretary just created is what \"that\" means", () => {
    const focus = noteFocus({}, { kind: "create", id: "caltrans-week" });
    expect(resolveReference("that", BLOCKS, focus)).toMatchObject({ ids: ["caltrans-week"] });
  });

  it("an explicit selection beats an older touch", () => {
    let focus = noteFocus({}, { kind: "move", id: "overdue" });
    focus = noteFocus(focus, { kind: "select", id: "today" });
    expect(resolveReference("it", BLOCKS, focus)).toMatchObject({ ids: ["today"] });
  });

  it("\"the other one\" means the previous referent", () => {
    let focus = noteFocus({}, { kind: "select", id: "overdue" });
    focus = noteFocus(focus, { kind: "select", id: "today" });
    expect(resolveReference("no, the other one", BLOCKS, focus)).toMatchObject({
      ids: ["overdue"],
    });
  });

  it("resolves by name, without the exact title", () => {
    expect(resolveReference("the caltrans one", BLOCKS, {})).toMatchObject({
      ids: ["caltrans-week"],
    });
    expect(resolveReference("procurement", BLOCKS, {})).toMatchObject({ ids: ["caltrans-week"] });
    expect(resolveReference("the overdue stuff", BLOCKS, {})).toMatchObject({ ids: ["overdue"] });
  });

  it("resolves by position", () => {
    expect(resolveReference("the top one", BLOCKS, {})).toMatchObject({ ids: ["overdue"] });
    expect(resolveReference("the last one", BLOCKS, {})).toMatchObject({ ids: ["caltrans-week"] });
  });

  it("\"those\" is the last group acted on, else everything visible", () => {
    const grouped = noteFocus({}, { kind: "group", ids: ["overdue", "today"] });
    expect(resolveReference("those", BLOCKS, grouped)).toMatchObject({
      ids: ["overdue", "today"],
    });
    const all = resolveReference("these", BLOCKS, {});
    expect(all.ok && all.ids).toHaveLength(3);
  });

  it("asks instead of guessing when it genuinely cannot tell", () => {
    const r = resolveReference("that", BLOCKS, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates).toHaveLength(3);
  });

  it("but one block on screen makes \"that\" unambiguous", () => {
    expect(resolveReference("that", [BLOCKS[0]], {})).toMatchObject({ ids: ["overdue"] });
  });

  it("reports ambiguity with candidates when a name matches several", () => {
    const many: Resolvable[] = [
      { id: "a", summary: "Caltrans procurement", position: 0, hidden: false },
      { id: "b", summary: "Caltrans submittals", position: 1, hidden: false },
    ];
    const r = resolveReference("the caltrans thing", many, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.candidates).toEqual(["a", "b"]);
  });

  it("an exact id always wins", () => {
    const focus = noteFocus({}, { kind: "select", id: "today" });
    expect(resolveReference("overdue", BLOCKS, focus)).toMatchObject({
      ids: ["overdue"],
      via: "id",
    });
  });

  it("forgets referents whose block is gone — a stale pronoun is worse than none", () => {
    const focus = noteFocus({}, { kind: "select", id: "album" });
    const pruned = pruneFocus(focus, ["overdue", "today"]);
    expect(pruned.selected).toBeUndefined();
    expect(resolveReference("that", BLOCKS, pruned).ok).toBe(false);
  });
});

const MARKUP =
  '<div id="overdue">2 overdue</div><div id="today">5 today</div><div id="album">mixing</div>';

describe("undo and redo", () => {
  it("puts a move back, instantly and with no model call", () => {
    const start = compositionFromMarkup(MARKUP);
    const moved = applyCanvasOps(start, [{ op: "move", id: "album", to: 0 }]).composition;
    expect(moved.blocks.map((b) => b.id)).toEqual(["album", "overdue", "today"]);

    const { composition: back, changed } = undoCanvas(moved);
    expect(changed).toBe(true);
    expect(back.blocks.map((b) => b.id)).toEqual(["overdue", "today", "album"]);
  });

  it("redoes what was undone, and a new action forks the timeline", () => {
    const start = compositionFromMarkup(MARKUP);
    const moved = applyCanvasOps(start, [{ op: "move", id: "album", to: 0 }]).composition;
    const undone = undoCanvas(moved).composition;
    expect(redoCanvas(undone).composition.blocks[0].id).toBe("album");

    // Doing something else after an undo discards the redo branch.
    const forked = applyCanvasOps(undone, [{ op: "hide", id: "today" }]).composition;
    expect(redoCanvas(forked).changed).toBe(false);
  });

  it("undoes a whole batch as one action, the way the user did it", () => {
    const start = compositionFromMarkup(MARKUP);
    const after = applyCanvasOps(start, [
      { op: "move", id: "album", to: 0 },
      { op: "resize", id: "album", span: "half" },
    ]).composition;
    const back = undoCanvas(after).composition;
    expect(back.blocks.map((b) => b.id)).toEqual(["overdue", "today", "album"]);
    expect(back.blocks.find((b) => b.id === "album")?.span).toBe("full");
  });

  it("restores theme changes too", () => {
    const start = compositionFromMarkup(MARKUP);
    const big = applyCanvasOps(start, [{ op: "set_theme", theme: { scale: 1.5 } }]).composition;
    expect(undoCanvas(big).composition.theme.scale).toBe(1);
  });

  it("says so rather than failing when there is nothing to undo", () => {
    const { changed, label } = undoCanvas(compositionFromMarkup(MARKUP));
    expect(changed).toBe(false);
    expect(label).toMatch(/nothing to undo/);
  });

  it("does not destroy blocks that arrived after the undone action", () => {
    const start = compositionFromMarkup(MARKUP);
    const moved = applyCanvasOps(start, [{ op: "move", id: "album", to: 0 }]).composition;
    // A repaint adds a block, carrying geometry and history forward.
    const withNew = {
      ...moved,
      blocks: [...moved.blocks, { id: "music", markup: "<div id=\"music\">x</div>", span: "full" as const, hidden: false, pinned: false }],
    };
    const back = undoCanvas(withNew).composition;
    expect(back.blocks.map((b) => b.id)).toContain("music");
  });

  it("hidden state round-trips through undo", () => {
    const start = compositionFromMarkup(MARKUP);
    const hidden = applyCanvasOps(start, [{ op: "hide", id: "album" }]).composition;
    expect(hidden.blocks.find((b) => b.id === "album")?.hidden).toBe(true);
    expect(undoCanvas(hidden).composition.blocks.find((b) => b.id === "album")?.hidden).toBe(false);
  });
});

describe("focus survives the world changing", () => {
  it("a repaint keeps referents for blocks that are still there", () => {
    const start = applyCanvasOps(compositionFromMarkup(MARKUP), [
      { op: "move", id: "today", to: 0 },
    ]).composition;
    const repainted = compositionFromMarkup(MARKUP, { previous: start });
    expect(repainted.focus?.lastMoved).toBe("today");
  });

  it("a newly painted block becomes what \"that\" refers to", () => {
    const before = compositionFromMarkup('<div id="overdue">a</div>');
    const after = compositionFromMarkup(
      '<div id="overdue">a</div><div id="music">Album mixing</div>',
      { previous: before }
    );
    expect(after.focus?.lastCreated).toBe("music");
  });
});
