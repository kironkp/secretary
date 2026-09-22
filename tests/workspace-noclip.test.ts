// "Nothing is cut off" (docs/understanding/SPEC.md §9), the half a unit test
// can see. The stylesheet rule on `.wk-body` is the shell's, and the one thing
// in CSS that beats it is an inline `!important` — which the shared sanitizer
// used to pass through. The Workspace surface of the sanitizer is what closes
// that: it strips `!important` and drops the declarations that clip text,
// before the body reaches the DOM. The Canvas surface must stay byte-identical,
// because a painted picture inside the iframe is allowed to decide its own
// wrapping.
//
// The layout half — that the title is actually read in full in a browser — is
// e2e/workspace.spec.ts, at both profiles.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeCanvasMarkup } from "@/lib/canvas/sanitize";

const ws = (html: string) => sanitizeCanvasMarkup(html, { surface: "workspace" });

describe("the Workspace surface drops what would cut a row off", () => {
  it("strips !important, so the shell's stylesheet wins", () => {
    expect(ws('<li style="color:red !important">x</li>')).toBe('<li style="color:red">x</li>');
    expect(ws('<li style="color:red ! IMPORTANT ;padding:4px">x</li>')).toBe(
      '<li style="color:red;padding:4px">x</li>'
    );
  });

  it("drops nowrap, ellipsis and line clamps, and keeps the rest", () => {
    expect(
      ws('<li style="white-space:nowrap !important;text-overflow:ellipsis;color:red">x</li>')
    ).toBe('<li style="color:red">x</li>');
    expect(ws('<li style="display:-webkit-box;-webkit-line-clamp:2;line-clamp:2">x</li>')).toBe(
      '<li style="display:-webkit-box">x</li>'
    );
    expect(ws('<li style="white-space:pre">x</li>')).toBe("<li>x</li>");
    // Wrapping values of white-space are not the problem.
    expect(ws('<li style="white-space:pre-wrap">x</li>')).toBe('<li style="white-space:pre-wrap">x</li>');
  });

  it("drops max-height and overflow hidden/clip, keeps height and scrolling overflow", () => {
    expect(ws('<div style="max-height:20px;overflow-y:hidden;height:8px">x</div>')).toBe(
      '<div style="height:8px">x</div>'
    );
    expect(ws('<div style="overflow:clip">x</div>')).toBe("<div>x</div>");
    expect(ws('<div style="overflow-x:auto">x</div>')).toBe('<div style="overflow-x:auto">x</div>');
  });

  it("the style attribute goes entirely when nothing survives", () => {
    expect(ws('<li style="white-space:nowrap !important">x</li>')).toBe("<li>x</li>");
    expect(ws('<li style="garbage">x</li>')).toBe("<li>x</li>");
  });

  it("the Canvas surface is untouched by any of this", () => {
    const painted = '<li style="white-space:nowrap !important;text-overflow:ellipsis">x</li>';
    expect(sanitizeCanvasMarkup(painted)).toBe(painted);
    expect(sanitizeCanvasMarkup(painted, { surface: "canvas" })).toBe(painted);
  });

  it("the loads-and-escapes rule still applies first on the Workspace surface", () => {
    expect(ws('<div style="background:url(http://evil);color:red">x</div>')).toBe("<div>x</div>");
    expect(ws('<div style="position:fixed;inset:0">x</div>')).toBe("<div>x</div>");
  });

  it("is idempotent, so a stored body survives a read unchanged", () => {
    const once = ws('<li style="color:red !important;white-space:nowrap">x</li>');
    expect(ws(once)).toBe(once);
  });
});

describe("every path that serves a widget body names the Workspace surface", () => {
  // The two places a stored body becomes a served one: the board store (page
  // and API payload alike) and the page itself, which sanitizes again.
  it.each(["lib/workspace/store.ts", "app/(app)/workspace/page.tsx"])("%s", (file) => {
    const src = readFileSync(file, "utf8");
    expect(src).toContain('sanitizeCanvasMarkup(w.body, { surface: "workspace" })');
    expect(src).not.toMatch(/sanitizeCanvasMarkup\(w\.body\)/);
  });

  it("the stylesheet states the rule the sanitizer now guarantees can win", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const rule = css.slice(css.indexOf(".wk-body,"), css.indexOf(".wk-body pre"));
    expect(rule).toContain("white-space: normal !important");
    expect(rule).toContain("text-overflow: clip !important");
    expect(rule).toContain("-webkit-line-clamp: none !important");
  });
});
