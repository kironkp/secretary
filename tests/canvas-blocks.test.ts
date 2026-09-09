// Canvas blocks — the substrate for the workspace model. Every canvas in the
// live database today is ONE wrapper div with zero ids, so these functions are
// what turn "an anonymous blob" into "objects the shell can move".
import { describe, expect, it } from "vitest";
import {
  composeBlocks,
  moveBlock,
  replaceBlock,
  segmentBlocks,
  verifyBlock,
} from "@/lib/canvas/blocks";
import { sanitizeCanvasMarkup } from "@/lib/canvas/sanitize";

const THREE =
  '<div id="overdue" style="padding:16px">2 items</div>' +
  '<div id="today" style="padding:16px">5 things today</div>' +
  '<div id="week" style="padding:16px">Undated</div>';

describe("segmentBlocks", () => {
  it("splits top-level siblings and keeps their ids", () => {
    const blocks = segmentBlocks(THREE);
    expect(blocks.map((b) => b.id)).toEqual(["overdue", "today", "week"]);
    expect(blocks[1].markup).toContain("5 things today");
  });

  it("does not mistake nesting for a new block", () => {
    const nested =
      '<div id="today"><div>a<div>deep</div></div><span>b</span></div>' +
      '<div id="week">w</div>';
    const blocks = segmentBlocks(nested);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].markup).toContain("deep");
  });

  it("names anonymous blocks and de-duplicates repeated ids", () => {
    const blocks = segmentBlocks(
      '<div>no id</div><div id="dup">a</div><div id="dup">b</div>'
    );
    expect(blocks[0].id).toBe("block-1");
    expect(blocks[1].id).toBe("dup");
    // A duplicate would make a targeted edit ambiguous.
    expect(blocks[2].id).toBe("dup-2");
    expect(new Set(blocks.map((b) => b.id)).size).toBe(3);
  });

  it("handles self-closing top-level elements", () => {
    const blocks = segmentBlocks('<div id="a">x</div><hr /><div id="b">y</div>');
    expect(blocks).toHaveLength(3);
    expect(blocks[1].markup).toBe("<hr />");
  });

  it("drops a truncated trailing element rather than emitting half a block", () => {
    const blocks = segmentBlocks('<div id="a">done</div><div id="b">unclosed');
    expect(blocks.map((b) => b.id)).toEqual(["a"]);
  });

  it("round-trips through compose", () => {
    expect(composeBlocks(segmentBlocks(THREE)).replace(/\n/g, "")).toBe(THREE);
  });

  it("segments a real single-wrapper canvas as one block (today's shape)", () => {
    // Every canvas in the live DB looks like this: one wrapper, no ids. It must
    // degrade to a single block rather than throwing or producing nonsense.
    const legacy = '<div style="display:flex;flex-direction:column"><div>a</div><div>b</div></div>';
    const blocks = segmentBlocks(legacy);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe("block-1");
    expect(blocks[0].markup).toBe(legacy);
  });
});

describe("verifyBlock", () => {
  it("accepts exactly one balanced root", () => {
    expect(verifyBlock('<div id="a"><span>x</span></div>').ok).toBe(true);
    expect(verifyBlock("<hr />").ok).toBe(true);
  });

  it("rejects an unbalanced fragment — spliced in, it re-parents its siblings", () => {
    // This exact string survives sanitization byte-for-byte, which is why the
    // check has to live here rather than relying on the sanitizer.
    const escaped = "<div><span>abc</div></span></div></div>";
    expect(sanitizeCanvasMarkup(escaped)).toBe(escaped);
    expect(verifyBlock(escaped).ok).toBe(false);
  });

  it("rejects multiple roots, unclosed elements and emptiness", () => {
    expect(verifyBlock("<div>a</div><div>b</div>")).toMatchObject({ ok: false });
    expect(verifyBlock("<div>a")).toMatchObject({ ok: false, reason: "unclosed element" });
    expect(verifyBlock("   ")).toMatchObject({ ok: false, reason: "empty" });
    expect(verifyBlock("</div>")).toMatchObject({ ok: false });
  });
});

describe("targeted change", () => {
  it("replaces one block and leaves the others byte-identical", () => {
    const blocks = segmentBlocks(THREE);
    const next = replaceBlock(blocks, "today", '<div id="today">6 things today</div>');
    expect(next).not.toBeNull();
    expect(next![1].markup).toContain("6 things");
    expect(next![0]).toEqual(blocks[0]);
    expect(next![2]).toEqual(blocks[2]);
  });

  it("refuses an unknown id or a malformed replacement", () => {
    const blocks = segmentBlocks(THREE);
    expect(replaceBlock(blocks, "nope", "<div>x</div>")).toBeNull();
    expect(replaceBlock(blocks, "today", "<div>oops")).toBeNull();
    expect(replaceBlock(blocks, "today", "<div>a</div><div>b</div>")).toBeNull();
  });

  it("moves a block without touching its content — no model call", () => {
    const blocks = segmentBlocks(THREE);
    const moved = moveBlock(blocks, "week", 0);
    expect(moved!.map((b) => b.id)).toEqual(["week", "overdue", "today"]);
    expect(moved!.map((b) => b.markup).sort()).toEqual(blocks.map((b) => b.markup).sort());
  });

  it("clamps an out-of-range move and refuses an unknown id", () => {
    const blocks = segmentBlocks(THREE);
    expect(moveBlock(blocks, "overdue", 99)!.map((b) => b.id)).toEqual([
      "today",
      "week",
      "overdue",
    ]);
    expect(moveBlock(blocks, "overdue", -5)!.map((b) => b.id)).toEqual([
      "overdue",
      "today",
      "week",
    ]);
    expect(moveBlock(blocks, "nope", 0)).toBeNull();
  });
});
