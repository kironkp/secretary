// The workspace model. The point of every test here is the same: geometry is
// DATA the shell owns, so moving, resizing, hiding and restyling never involve
// the model — and content is never touched by a geometry op.
import { describe, expect, it } from "vitest";
import {
  applyCanvasOps,
  compositionFromMarkup,
  compositionToMarkup,
  describeComposition,
  validateComposition,
  DEFAULT_THEME,
  type CanvasComposition,
} from "@/lib/canvas/composition";
import { buildCanvasSrcDoc } from "@/lib/canvas/sanitize";

const MARKUP =
  '<div id="overdue" style="padding:16px">2 overdue: ADM-2011 signature packet</div>' +
  '<div id="today" style="padding:16px">5 things today</div>' +
  '<div id="album" style="padding:16px">Album mixing session</div>';

const base = () => compositionFromMarkup(MARKUP);

describe("compositionFromMarkup", () => {
  it("turns painted markup into addressable blocks with default geometry", () => {
    const c = base();
    expect(c.blocks.map((b) => b.id)).toEqual(["overdue", "today", "album"]);
    expect(c.blocks.every((b) => b.span === "full" && !b.hidden && !b.pinned)).toBe(true);
    expect(c.theme).toEqual(DEFAULT_THEME);
  });

  it("migrates a legacy single-wrapper canvas to one block", () => {
    const legacy = '<div style="display:flex"><div>a</div><div>b</div></div>';
    const c = compositionFromMarkup(legacy);
    expect(c.blocks).toHaveLength(1);
    expect(compositionToMarkup(c)).toBe(legacy);
  });

  it("carries hand-placed geometry through a repaint", () => {
    // The assistant arranges the room; what the user's hand touched stays put.
    const moved = applyCanvasOps(base(), [{ op: "resize", id: "album", span: "half" }]).composition;
    const repainted = compositionFromMarkup(MARKUP, { previous: moved });
    expect(repainted.blocks.find((b) => b.id === "album")).toMatchObject({
      span: "half",
      pinned: true,
    });
    // and an untouched block keeps the default
    expect(repainted.blocks.find((b) => b.id === "today")?.span).toBe("full");
  });

  it("drops a structurally unsafe block rather than composing it in", () => {
    const c = compositionFromMarkup('<div id="ok">fine</div><div><span>bad</div></span>');
    expect(c.blocks.map((b) => b.id)).toEqual(["ok"]);
  });
});

describe("geometry operations", () => {
  it("moves a block without touching any content", () => {
    const before = base();
    const { composition, applied } = applyCanvasOps(before, [
      { op: "move", id: "album", to: 0 },
    ]);
    expect(applied).toEqual(["move album→0"]);
    expect(composition.blocks.map((b) => b.id)).toEqual(["album", "overdue", "today"]);
    // markup is byte-identical — a move is not a repaint
    expect(composition.blocks.map((b) => b.markup).sort()).toEqual(
      before.blocks.map((b) => b.markup).sort()
    );
  });

  it("pins what the user touched, so the model may not re-place it", () => {
    const { composition } = applyCanvasOps(base(), [{ op: "move", id: "today", to: 0 }]);
    expect(composition.blocks[0]).toMatchObject({ id: "today", pinned: true });
    expect(composition.blocks.find((b) => b.id === "album")?.pinned).toBe(false);
  });

  it("hides and shows without losing the block", () => {
    const hidden = applyCanvasOps(base(), [{ op: "hide", id: "album" }]).composition;
    expect(compositionToMarkup(hidden)).not.toContain("Album mixing");
    expect(hidden.blocks).toHaveLength(3); // still there, just not rendered
    const shown = applyCanvasOps(hidden, [{ op: "show", id: "album" }]).composition;
    expect(compositionToMarkup(shown)).toContain("Album mixing");
  });

  it("reports an unknown block instead of guessing which one was meant", () => {
    const { applied, rejected } = applyCanvasOps(base(), [{ op: "move", id: "nope", to: 0 }]);
    expect(applied).toEqual([]);
    expect(rejected[0].reason).toMatch(/no block "nope"/);
  });

  it("refuses to empty the canvas", () => {
    const ops = base().blocks.map((b) => ({ op: "hide" as const, id: b.id }));
    const { composition, applied, rejected } = applyCanvasOps(base(), ops);
    expect(applied).toEqual([]);
    expect(rejected.at(-1)?.reason).toMatch(/empty the canvas/);
    expect(compositionToMarkup(composition)).toContain("5 things today");
  });

  it("applies a run of ops in order", () => {
    const { composition } = applyCanvasOps(base(), [
      { op: "move", id: "album", to: 0 },
      { op: "resize", id: "album", span: "half" },
      { op: "hide", id: "overdue" },
    ]);
    expect(composition.blocks[0]).toMatchObject({ id: "album", span: "half" });
    expect(compositionToMarkup(composition)).not.toContain("ADM-2011");
  });
});

describe("theme", () => {
  it("is data, and reaches painted markup through CSS variables", () => {
    const { composition } = applyCanvasOps(base(), [
      { op: "set_theme", theme: { scale: 1.5, font: "serif" } },
    ]);
    expect(composition.theme.scale).toBe(1.5);
    // content untouched: "make the font bigger" is not a repaint
    expect(compositionToMarkup(composition)).toBe(compositionToMarkup(base()));

    const doc = buildCanvasSrcDoc("<p>x</p>", { theme: composition.theme });
    expect(doc).toContain("--font-ui:ui-serif");
    expect(doc).toContain("--s1:21px"); // 14 * 1.5
  });

  it("clamps a hostile scale rather than rendering an unusable canvas", () => {
    const { composition } = applyCanvasOps(base(), [{ op: "set_theme", theme: { scale: 99 } }]);
    expect(composition.theme.scale).toBeLessThanOrEqual(2);
  });

  it("a per-block frame is transparent — the shell owns the space between", () => {
    const block = buildCanvasSrcDoc("<p>x</p>", { block: true });
    expect(block).toContain("background:transparent");
    expect(block).toContain("padding:0");
    // the whole-canvas document still paints its own background
    expect(buildCanvasSrcDoc("<p>x</p>")).toContain("background:var(--bg)");
  });
});

describe("validateComposition", () => {
  it("drops bad blocks and keeps the rest, never throwing", () => {
    const { composition, warnings } = validateComposition({
      v: 1,
      theme: DEFAULT_THEME,
      blocks: [
        { id: "a", markup: "<div>a</div>", span: "full", hidden: false, pinned: false },
        { id: "b", markup: "<div>oops", span: "full", hidden: false, pinned: false },
        { id: "a", markup: "<div>dup</div>", span: "full", hidden: false, pinned: false },
      ],
    });
    expect(composition?.blocks.map((b) => b.id)).toEqual(["a"]);
    expect(warnings).toHaveLength(2);
  });

  it("rejects an unparseable composition outright", () => {
    expect(validateComposition({ v: 2, blocks: [] }).composition).toBeNull();
    expect(validateComposition(null).composition).toBeNull();
  });
});

describe("describeComposition", () => {
  it("gives the model a map of the world, without shipping the markup", () => {
    const seen = describeComposition(base());
    expect(seen.map((s) => s.id)).toEqual(["overdue", "today", "album"]);
    expect(seen[0].summary).toContain("ADM-2011");
    expect(JSON.stringify(seen)).not.toContain("style=");
    expect(seen[0].position).toBe(0);
  });
});

describe("the shape that makes it a workspace", () => {
  it("every geometry op is pure data — no markup changes anywhere", () => {
    const before: CanvasComposition = base();
    const after = applyCanvasOps(before, [
      { op: "move", id: "album", to: 0 },
      { op: "resize", id: "today", span: "half" },
      { op: "set_theme", theme: { density: "roomy" } },
    ]).composition;
    const markupOf = (c: CanvasComposition) =>
      Object.fromEntries(c.blocks.map((b) => [b.id, b.markup]));
    expect(markupOf(after)).toEqual(markupOf(before));
  });
});

describe("arrange_canvas (the voice path)", () => {
  it("is on the voice session and is distinguished from a repaint", async () => {
    const { VOICE_TOOL_NAMES, openAIVoiceToolDefs } = await import(
      "@/lib/secretary/tool-schemas"
    );
    expect(VOICE_TOOL_NAMES).toContain("arrange_canvas");
    const def = openAIVoiceToolDefs().find((t) => t.name === "arrange_canvas");
    // The model must be able to tell "move it" from "change what it says".
    expect(def?.description).toMatch(/no repainting/i);
    expect(def?.description).toMatch(/move the album up/i);
    expect(def?.description).toMatch(/NOT edit_canvas/);
  });

  it("rejects an operation vocabulary it does not know, rather than guessing", async () => {
    const { canvasOpSchema } = await import("@/lib/canvas/composition");
    expect(canvasOpSchema.safeParse({ op: "rotate", id: "a" }).success).toBe(false);
    expect(canvasOpSchema.safeParse({ op: "move", id: "a", to: 0 }).success).toBe(true);
    // ids stay id-shaped: they are used as DOM and storage keys
    expect(canvasOpSchema.safeParse({ op: "hide", id: "a b" }).success).toBe(false);
  });
});
