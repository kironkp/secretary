// @vitest-environment jsdom
//
// The canvas click path, driven through a real DOM.
//
// This file exists because its absence is why "checkboxes on the Canvas" was
// marked shipped while being unclickable. vitest runs in node, so the only
// canvas coverage was of SERVER helpers (collectCheckIds / doneCheckIds) —
// which were correct the whole time. Nothing ever clicked anything.
import { describe, expect, it, vi } from "vitest";
import { applyCheckState, taskIdForBox, wireCanvasDocument } from "@/lib/canvas/interaction";
import { buildCanvasSrcDoc } from "@/lib/canvas/sanitize";

const TASK_A = "8d99d882-6a68-4cbd-b062-b461df2a2cf5";
const TASK_B = "b660c487-07c8-4a8d-b331-cbe40abe799a";
const PROJECT = "7cb32464-f181-44a0-9d84-1e28fc547f02";

/** A row shaped exactly like the live painter's output: data-check AND
 *  data-link on the same div, with its own inline padding. */
const row = (task: string, text: string) =>
  `<div data-check="${task}" data-link="${PROJECT}" style="padding:13px 0;border-top:1px solid var(--edge)">` +
  `<div style="font-size:16px">${text}</div></div>`;

function canvas(markup: string, checked: Set<string> = new Set()) {
  document.documentElement.innerHTML = buildCanvasSrcDoc(markup, { block: true })
    .replace(/^[\s\S]*?<html>/, "")
    .replace(/<\/html>[\s\S]*$/, "");
  const handlers = {
    onCheck: vi.fn(),
    onLink: vi.fn(),
    onSelect: vi.fn(),
    onResize: vi.fn(),
    isMomentumTap: vi.fn(() => false),
  };
  applyCheckState(document, (id) => checked.has(id));
  const teardown = wireCanvasDocument(document, handlers);
  return { handlers, teardown };
}

const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const boxes = () => Array.from(document.querySelectorAll(".cv-box"));

describe("the checkbox is drawn by the shell", () => {
  it("appears on every task row, and only on task rows", () => {
    canvas(row(TASK_A, "Change tracking") + '<div style="padding:8px">just a heading</div>');
    expect(boxes()).toHaveLength(1);
    expect(taskIdForBox(boxes()[0])).toBe(TASK_A);
  });

  it("is focusable and announces itself, so Space/Enter can reach it", () => {
    canvas(row(TASK_A, "x"));
    const box = boxes()[0];
    expect(box.getAttribute("role")).toBe("checkbox");
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.getAttribute("aria-checked")).toBe("false");
  });

  it("reserves its gutter without clobbering the card's own padding", () => {
    canvas(row(TASK_A, "x"));
    const host = document.querySelector("[data-check]") as HTMLElement;
    expect(host.classList.contains("cv-checkable")).toBe(true);
    expect(host.style.paddingLeft).toBe("30px");
  });

  it("re-applying is idempotent — no duplicate boxes on every poll", () => {
    canvas(row(TASK_A, "x"));
    applyCheckState(document, () => false);
    applyCheckState(document, () => false);
    expect(boxes()).toHaveLength(1);
  });

  it("reflects done state and crosses the row off", () => {
    canvas(row(TASK_A, "x"), new Set([TASK_A]));
    expect(boxes()[0].getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector("[data-check]")!.classList.contains("cv-done")).toBe(true);
  });
});

describe("clicking the checkbox", () => {
  it("completes exactly that task, once", () => {
    const { handlers } = canvas(row(TASK_A, "x"));
    click(boxes()[0]);
    expect(handlers.onCheck).toHaveBeenCalledTimes(1);
    expect(handlers.onCheck).toHaveBeenCalledWith(TASK_A);
  });

  it("does NOT also navigate, select, or expand the card underneath", () => {
    const { handlers } = canvas(row(TASK_A, "x"));
    click(boxes()[0]);
    expect(handlers.onLink).not.toHaveBeenCalled();
    expect(handlers.onSelect).not.toHaveBeenCalled();
    expect(document.querySelector("[data-check]")!.classList.contains("cv-expanded")).toBe(false);
  });

  // THE REGRESSION. The canvas re-measures its blocks after load, which changes
  // the board height, which fires page scroll events — so the momentum guard
  // was true almost continuously and silently ate every checkbox click. A
  // deliberate 18px target must never be gated by it.
  it("still works while the momentum guard is active", () => {
    const { handlers } = canvas(row(TASK_A, "x"));
    handlers.isMomentumTap.mockReturnValue(true);
    click(boxes()[0]);
    expect(handlers.onCheck).toHaveBeenCalledWith(TASK_A);
  });

  it("but a scroll-stop tap on the CARD is still swallowed", () => {
    const { handlers } = canvas(row(TASK_A, "x"));
    handlers.isMomentumTap.mockReturnValue(true);
    click(document.querySelector("[data-check]")!);
    expect(handlers.onLink).not.toHaveBeenCalled();
    expect(handlers.onCheck).not.toHaveBeenCalled();
  });

  // Identical visible text, different tasks — the id must come from the DOM,
  // never from label text or row position.
  it("updates the right one when two rows read identically", () => {
    const { handlers } = canvas(row(TASK_A, "Follow up") + row(TASK_B, "Follow up"));
    expect(boxes()).toHaveLength(2);
    click(boxes()[1]);
    expect(handlers.onCheck).toHaveBeenCalledTimes(1);
    expect(handlers.onCheck).toHaveBeenCalledWith(TASK_B);
    click(boxes()[0]);
    expect(handlers.onCheck).toHaveBeenLastCalledWith(TASK_A);
  });

  it("works from the keyboard with Space and Enter", () => {
    const { handlers } = canvas(row(TASK_A, "x"));
    const box = boxes()[0];
    box.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.onCheck).toHaveBeenCalledTimes(2);
    expect(handlers.onCheck).toHaveBeenCalledWith(TASK_A);
  });

  it("ignores other keys", () => {
    const { handlers } = canvas(row(TASK_A, "x"));
    boxes()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(handlers.onCheck).not.toHaveBeenCalled();
  });
});

describe("the rest of the canvas still works", () => {
  it("tapping a card opens its project", () => {
    const { handlers } = canvas(row(TASK_A, "x"));
    click(document.querySelector("[data-check] div")!);
    expect(handlers.onLink).toHaveBeenCalledWith(PROJECT);
    expect(handlers.onCheck).not.toHaveBeenCalled();
  });

  it("tapping anywhere in the block selects it", () => {
    const { handlers } = canvas('<div style="padding:8px">plain content</div>');
    click(document.querySelector("div")!);
    expect(handlers.onSelect).toHaveBeenCalled();
  });

  it("data-expand toggles and reports the height change", () => {
    const { handlers } = canvas('<div data-expand="" style="padding:8px">more</div>');
    const el = document.querySelector("[data-expand]")!;
    click(el);
    expect(el.classList.contains("cv-expanded")).toBe(true);
    expect(handlers.onResize).toHaveBeenCalled();
    click(el);
    expect(el.classList.contains("cv-expanded")).toBe(false);
  });

  it("non-interactive content does nothing at all", () => {
    const { handlers } = canvas("<p>just words</p>");
    click(document.querySelector("p")!);
    expect(handlers.onCheck).not.toHaveBeenCalled();
    expect(handlers.onLink).not.toHaveBeenCalled();
  });

  it("teardown removes the listeners so a replaced document cannot double-fire", () => {
    const { handlers, teardown } = canvas(row(TASK_A, "x"));
    teardown();
    click(boxes()[0]);
    expect(handlers.onCheck).not.toHaveBeenCalled();
  });
});
