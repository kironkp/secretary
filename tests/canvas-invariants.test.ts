// Standing canvas invariants.
//
// These pin findings that were fixed rather than merely documented. Each one
// is a thing that was actually broken and would be easy to re-break, so the
// assertion is deliberately about the OBSERVABLE behaviour, not the shape of
// the code that currently implements it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeCanvasMarkup, buildCanvasSrcDoc, CANVAS_SANDBOX } from "@/lib/canvas/sanitize";
import { VOICE_TOOL_NAMES, openAIVoiceToolDefs } from "@/lib/secretary/tool-schemas";
import { VOICE_MODALITY_RULES } from "@/lib/secretary/persona";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("1. model-authored classes cannot escape into app-level UI", () => {
  it("drops Tailwind utilities and the shell's own state classes", () => {
    // This sanitizer also guards the one path that renders model markup INLINE
    // in the app document, where Tailwind is live.
    expect(sanitizeCanvasMarkup('<div class="fixed inset-0 z-50 bg-white">x</div>')).toBe(
      "<div>x</div>"
    );
    for (const c of ["cv-box", "cv-checkable", "cv-done", "cv-expanded"]) {
      expect(sanitizeCanvasMarkup(`<div class="${c}">x</div>`)).toBe("<div>x</div>");
    }
    expect(sanitizeCanvasMarkup('<div class="cv-chart">x</div>')).toContain('class="cv-chart"');
  });

  it("blocks positioning that would cover the app", () => {
    for (const s of ["position:fixed;inset:0", "POSITION : FIXED", "position:/*x*/absolute"]) {
      expect(sanitizeCanvasMarkup(`<div style="${s}">x</div>`)).toBe("<div>x</div>");
    }
  });
});

describe("2. dark mode uses the real application theme", () => {
  it("reads data-theme, never a class the app never sets", () => {
    const src = read("components/canvas/canvas-view.tsx");
    expect(src).toContain('getAttribute("data-theme")');
    // The old check. If this comes back, the canvas renders light in a dark app.
    expect(src).not.toContain('classList.contains("dark")');
  });

  it("serves a genuinely different palette per theme", () => {
    const dark = buildCanvasSrcDoc("<p>x</p>", { dark: true });
    const light = buildCanvasSrcDoc("<p>x</p>", { dark: false });
    expect(dark).not.toBe(light);
    expect(dark).toContain("#0f1115"); // app's real dark --bg
    expect(light).toContain("#f6f7f9"); // app's real light --bg
  });
});

describe("3. prefers-reduced-motion is honored", () => {
  it("inside the canvas document", () => {
    expect(buildCanvasSrcDoc("<p>x</p>")).toContain("prefers-reduced-motion");
  });

  it("and app-wide, including the two infinite animations", () => {
    const css = read("app/globals.css");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation-iteration-count: 1 !important");
    // The guard must come last: it wins by source order, not specificity.
    expect(css.lastIndexOf("prefers-reduced-motion")).toBeGreaterThan(css.lastIndexOf("@keyframes"));
  });
});

describe("4. momentum scrolling cannot complete a task", () => {
  // The interaction path now lives in lib/canvas/interaction.ts precisely so it
  // can be tested by driving a real DOM — see tests/canvas-interaction.test.ts,
  // which asserts the BEHAVIOUR these two once approximated by reading source.
  it("the canvas still consults the dashboard's guard for card-level taps", () => {
    const src = read("lib/canvas/interaction.ts");
    expect(src).toContain("isMomentumTap");
    expect(src).toMatch(/if \(handlers\.isMomentumTap\?\.\(\)\) return;/);
    expect(read("components/canvas/canvas-view.tsx")).toContain("isMomentumTap");
  });

  it("but the guard is NOT what stands between a tap and the checkbox", () => {
    // The regression: board re-measurement changes document height, which fires
    // scroll events, which kept the guard true and ate every checkbox click.
    const src = read("lib/canvas/interaction.ts");
    const box = src.indexOf("const box = el?.closest?.(`.${BOX_CLASS}`);");
    const guard = src.indexOf("if (handlers.isMomentumTap?.()) return;");
    expect(box).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(box); // the box is hit-tested FIRST
  });

  it("and completion requires the shell's checkbox, not the whole card", () => {
    expect(read("lib/canvas/interaction.ts")).toContain("closest?.(`.${BOX_CLASS}`)");
  });

  it("so every data-check is guaranteed a checkbox that can render", () => {
    // An HTML box injected into SVG never renders; a data-check there would be
    // uncompletable, so it is dropped at the gate.
    const id = "4f9d2c10-93ab-4bfb-8c0e-1234567890ab";
    expect(sanitizeCanvasMarkup(`<rect data-check="${id}" />`)).not.toContain("data-check");
    expect(sanitizeCanvasMarkup(`<li data-check="${id}">x</li>`)).toContain("data-check");
  });
});

describe("5. voice can edit and arrange the canvas it is looking at", () => {
  it("both tools ride the voice session", () => {
    expect(VOICE_TOOL_NAMES).toContain("edit_canvas");
    expect(VOICE_TOOL_NAMES).toContain("arrange_canvas");
    const names = openAIVoiceToolDefs().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["edit_canvas", "arrange_canvas", "paint_canvas"]));
  });

  it("and the rules route a change to edit, not a repaint", () => {
    expect(VOICE_MODALITY_RULES).toMatch(/CHANGING WHAT'S ON SCREEN IS edit_canvas/);
  });
});

describe("6. the existing canvas stays visible during generation", () => {
  it("a new snapshot is seeded with what is on screen, never empty", () => {
    const src = read("lib/canvas/painter.ts");
    expect(src).toContain("markup: hold");
    expect(src).not.toMatch(/markup:\s*""\s*,\s*painting:\s*true/);
  });

  it("an edit holds it, and only a completed stream may be committed", () => {
    const src = read("lib/canvas/painter.ts");
    expect(src).toContain("if (isEdit) continue;");
    expect(src).toContain("completed ? sanitizeCanvasMarkup(finalRaw) : \"\"");
    // An epoch-zero lastFlush would wipe the seed on the first delta.
    expect(src).toContain("let lastFlush = Date.now()");
  });
});

describe("7. a finished canvas refreshes immediately, not on the poll", () => {
  it("the shell listens for the refresh event", () => {
    expect(read("components/canvas/canvas-view.tsx")).toContain("CANVAS_REFRESH_EVENT");
  });

  it("and both the chat and voice paths fire it", () => {
    expect(read("components/chat/chat-thread.tsx")).toContain("requestCanvasRefresh()");
    expect(read("components/chat/voice-mode.tsx")).toContain("requestCanvasRefresh()");
  });
});

describe("the security posture that made all of this acceptable", () => {
  it("model markup still cannot execute", () => {
    expect(CANVAS_SANDBOX).not.toContain("allow-scripts");
    const doc = buildCanvasSrcDoc("<p>x</p>");
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("script-src 'none'");
    expect(sanitizeCanvasMarkup('<img src=x onerror="alert(1)">')).toBe("");
    expect(sanitizeCanvasMarkup('<div onclick="x()">y</div>')).toBe("<div>y</div>");
  });

  it("and cannot express a network request", () => {
    for (const attr of ["src", "href", "xlink:href", "srcset", "formaction", "action"]) {
      expect(sanitizeCanvasMarkup(`<div ${attr}="http://evil">x</div>`)).toBe("<div>x</div>");
    }
    expect(sanitizeCanvasMarkup('<div style="background:url(http://evil)">x</div>')).toBe(
      "<div>x</div>"
    );
  });
});
