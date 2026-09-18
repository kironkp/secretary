// @vitest-environment jsdom
//
// The binding applier, against a real DOM. This is the half of the Workspace
// that turns a template into live data, and the failure it must never have is
// the Canvas's: rebuilding everything on a refresh and losing what the user was
// doing inside a widget.
import { beforeEach, describe, expect, it } from "vitest";
import { applyBindings } from "@/lib/workspace/apply-bindings";
import { sanitizeCanvasMarkup } from "@/lib/canvas/sanitize";
import { FIELDS, type BoundRow } from "@/lib/workspace/types";

const row = (id: string, fields: Record<string, string>): BoundRow => ({ id, fields });

function mount(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const LIST =
  '<ul data-each><li data-row-check><span data-field="title"></span>' +
  '<em data-field="due"></em></li></ul>' +
  "<p data-empty>Nothing here.</p>";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("repeating a template", () => {
  it("renders one node per row, filling the named fields", () => {
    const el = mount(LIST);
    applyBindings(el, [
      row("t1", { title: "Pay rent", due: "today" }),
      row("t2", { title: "Call Marissa", due: "Fri" }),
    ]);
    const items = el.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector("[data-field='title']")?.textContent).toBe("Pay rent");
    expect(items[1].querySelector("[data-field='due']")?.textContent).toBe("Fri");
  });

  it("writes the row's real id into data-check, so a tick hits the right task", () => {
    const el = mount(LIST);
    applyBindings(el, [row("task-abc", { title: "A" })], { checkable: true });
    expect(el.querySelector("li")?.getAttribute("data-check")).toBe("task-abc");
  });

  it("leaves data-check off a row that is not a task", () => {
    // A project id in the completion attribute would send the task API an id
    // it does not recognise.
    const el = mount(LIST);
    applyBindings(el, [row("project-1", { name: "Caltrans" })], { checkable: false });
    expect(el.querySelector("li")?.hasAttribute("data-check")).toBe(false);
  });

  it("never renders a prototype member for a field name", () => {
    const el = mount('<span data-field="constructor"></span>');
    applyBindings(el, [row("a", { title: "A" })]);
    expect(el.querySelector("span")?.textContent).toBe("");
  });

  it("writes values as text, never as markup", () => {
    const el = mount(LIST);
    applyBindings(el, [row("t1", { title: "<img src=x onerror=alert(1)>", due: "" })]);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("[data-field='title']")?.textContent).toContain("<img");
  });

  it("shows the empty state only when there are no rows", () => {
    const el = mount(LIST);
    applyBindings(el, []);
    expect((el.querySelector("[data-empty]") as HTMLElement).hidden).toBe(false);
    applyBindings(el, [row("t1", { title: "A" })]);
    expect((el.querySelector("[data-empty]") as HTMLElement).hidden).toBe(true);
  });

  it("counts rows for a summary line", () => {
    const el = mount('<p><span data-count></span> open</p>' + LIST);
    applyBindings(el, [row("a", {}), row("b", {}), row("c", {})]);
    expect(el.querySelector("[data-count]")?.textContent).toBe("3");
  });
});

describe("refreshing in place — the reason this runs in the DOM", () => {
  it("reuses the same node for a row that is still there", () => {
    const el = mount(LIST);
    applyBindings(el, [row("t1", { title: "Before" })]);
    const first = el.querySelector("li")!;
    // Something only the DOM knows, which a rebuild would destroy.
    (first as HTMLElement).dataset.userState = "kept";

    applyBindings(el, [row("t1", { title: "After" })]);
    const again = el.querySelector("li")!;
    expect(again).toBe(first);
    expect((again as HTMLElement).dataset.userState).toBe("kept");
    expect(again.querySelector("[data-field='title']")?.textContent).toBe("After");
  });

  it("keeps the widget's scroll position across a refresh", () => {
    const el = mount(LIST);
    applyBindings(
      el,
      Array.from({ length: 30 }, (_, i) => row(`t${i}`, { title: `Task ${i}` }))
    );
    el.scrollTop = 120;
    applyBindings(
      el,
      Array.from({ length: 30 }, (_, i) => row(`t${i}`, { title: `Task ${i} edited` }))
    );
    expect(el.scrollTop).toBe(120);
  });

  it("removes rows that are gone and adds ones that appeared", () => {
    const el = mount(LIST);
    applyBindings(el, [row("a", { title: "A" }), row("b", { title: "B" })]);
    applyBindings(el, [row("b", { title: "B" }), row("c", { title: "C" })]);
    const ids = Array.from(el.querySelectorAll("li")).map((n) => n.getAttribute("data-row-id"));
    expect(ids).toEqual(["b", "c"]);
  });

  it("puts rows in the order given, even when they were reordered", () => {
    const el = mount(LIST);
    applyBindings(el, [row("a", { title: "A" }), row("b", { title: "B" })]);
    applyBindings(el, [row("b", { title: "B" }), row("a", { title: "A" })]);
    const ids = Array.from(el.querySelectorAll("li")).map((n) => n.getAttribute("data-row-id"));
    expect(ids).toEqual(["b", "a"]);
  });

  it("is idempotent", () => {
    const el = mount(LIST);
    const rows = [row("a", { title: "A" })];
    applyBindings(el, rows);
    const html = el.innerHTML;
    applyBindings(el, rows);
    expect(el.innerHTML).toBe(html);
  });
});

describe("fields outside a repeat", () => {
  it("describe the first row, so a 'next up' widget reads naturally", () => {
    const el = mount('<h3 data-field="title"></h3><p data-field="due"></p>');
    applyBindings(el, [row("t1", { title: "Duty statement", due: "tomorrow" })]);
    expect(el.querySelector("h3")?.textContent).toBe("Duty statement");
    expect(el.querySelector("p")?.textContent).toBe("tomorrow");
  });

  it("go blank rather than stale when nothing matches", () => {
    const el = mount('<h3 data-field="title">placeholder</h3>');
    applyBindings(el, []);
    expect(el.querySelector("h3")?.textContent).toBe("");
  });
});

describe("robustness", () => {
  it("survives a repeat container with no row template", () => {
    const el = mount("<ul data-each></ul>");
    expect(() => applyBindings(el, [row("a", { title: "A" })])).not.toThrow();
  });

  it("ignores a field name the row does not carry", () => {
    const el = mount('<ul data-each><li><span data-field="nonesuch"></span></li></ul>');
    applyBindings(el, [row("a", { title: "A" })]);
    expect(el.querySelector("[data-field='nonesuch']")?.textContent).toBe("");
  });

  it("handles a body with no bindings at all", () => {
    const el = mount("<p>Just words.</p>");
    expect(() => applyBindings(el, [])).not.toThrow();
    expect(el.textContent).toBe("Just words.");
  });
});

describe("the sanitizer keeps the binding vocabulary closed", () => {
  it("preserves the attributes a template needs", () => {
    const clean = sanitizeCanvasMarkup(LIST);
    expect(clean).toContain("data-each");
    expect(clean).toContain("data-row-check");
    expect(clean).toContain('data-field="title"');
    expect(clean).toContain("data-empty");
  });

  it("accepts every field the vocabulary declares, and nothing else", () => {
    // The sanitizer keeps its own copy of the field names so it stays
    // dependency-free. This is the assertion that stops the two drifting: a
    // field added to FIELDS but not to the sanitizer would be silently
    // stripped, and the widget would render blanks forever.
    const declared = new Set(Object.values(FIELDS).flat());
    for (const field of declared) {
      expect(
        sanitizeCanvasMarkup(`<span data-field="${field}"></span>`),
        `the sanitizer strips the declared field "${field}"`
      ).toContain(`data-field="${field}"`);
    }
    expect(sanitizeCanvasMarkup('<span data-field="password"></span>')).not.toContain("data-field");
  });

  it("drops a field name that is not a field name", () => {
    const clean = sanitizeCanvasMarkup('<span data-field="../../etc/passwd"></span>');
    expect(clean).not.toContain("data-field");
  });

  it("drops a field name carrying an expression", () => {
    const clean = sanitizeCanvasMarkup('<span data-field="a();b()"></span>');
    expect(clean).not.toContain("data-field");
  });

  it("strips any value from the marker attributes", () => {
    const clean = sanitizeCanvasMarkup('<ul data-each="anything"><li></li></ul>');
    expect(clean).toContain('data-each=""');
    expect(clean).not.toContain("anything");
  });

  it("still refuses scripts and handlers inside a template", () => {
    const clean = sanitizeCanvasMarkup(
      '<ul data-each><li onclick="steal()"><script>x()</script><span data-field="title"></span></li></ul>'
    );
    expect(clean).not.toContain("onclick");
    expect(clean).not.toContain("script");
    expect(clean).toContain('data-field="title"');
  });
});
