// Fill a widget's template from resolved rows, in place.
//
// This runs on the CLIENT, against a real DOM, for one reason: it lets the
// template stay put while only the values change. Re-rendering the markup on
// every refresh would reset scroll and lose selection inside the widget, which
// is precisely the "current state → objects move → new state" continuity the
// north star asks for.
//
// The vocabulary is closed and tiny (docs/workspace/SPEC.md §3.3):
//   data-each   on a container: repeat its first element child, once per row
//   data-field  replace text content with that field of the current row
//   data-count  replace text content with the number of rows
//   data-empty  shown only when the query returned nothing
//   data-row-check  marks a row as tickable; the shell writes the real task id
//                   into data-check once it has one. The template never carries
//                   an id, and data-check keeps its absolute id-shaped rule.
//
// Nothing here evaluates anything. A field name is a key lookup, never code.
import type { BoundRow } from "./types";

/** Only a task can be ticked. CLAUDE.md: data-check ids come from tasks only. */
export type ApplyOptions = { checkable?: boolean };

/** Where a repeated row keeps its identity, so a refresh reuses its node. */
const ROW_ID = "data-row-id";
/** The pristine template for each data-each container, kept off-DOM. */
const templates = new WeakMap<Element, Element>();

function fillFields(scope: Element, row: BoundRow, checkable: boolean): void {
  const targets = scope.matches("[data-field]")
    ? [scope, ...Array.from(scope.querySelectorAll("[data-field]"))]
    : Array.from(scope.querySelectorAll("[data-field]"));

  for (const el of targets) {
    const name = el.getAttribute("data-field");
    if (!name) continue;
    // hasOwn, not a bare lookup: `data-field="constructor"` would otherwise
    // reach Object.prototype and render its source into the widget.
    const value = Object.hasOwn(row.fields, name) ? row.fields[name] : "";
    // textContent, never innerHTML: a value is data and can never become markup.
    el.textContent = value;
    // Let a template hide its own empty parts without knowing the data:
    // `[data-field]:empty { display: none }` is up to the author.
    if (value === "") el.setAttribute("data-empty-value", "");
    else el.removeAttribute("data-empty-value");
  }

  // The row's identity travels with it, so the checkbox in phase 3 and the
  // Canvas's data-check convention address the same task id. A widget bound to
  // projects or events has ids that are NOT task ids: leave the marker empty
  // rather than hand the task API something it will not recognise.
  const checkTargets = scope.matches("[data-row-check]")
    ? [scope, ...Array.from(scope.querySelectorAll("[data-row-check]"))]
    : Array.from(scope.querySelectorAll("[data-row-check]"));
  for (const el of checkTargets) {
    if (checkable) el.setAttribute("data-check", row.id);
    else el.removeAttribute("data-check");
  }
}

/**
 * Reconcile one `data-each` container against rows, reusing nodes by row id so
 * a refresh moves and updates rather than rebuilding.
 */
function fillEach(container: Element, rows: BoundRow[], checkable: boolean): void {
  let template = templates.get(container);
  if (!template) {
    const first = container.firstElementChild;
    if (!first) return; // nothing to repeat; the author gave no row shape
    template = first.cloneNode(true) as Element;
    templates.set(container, template);
  }

  const existing = new Map<string, Element>();
  for (const child of Array.from(container.children)) {
    const key = child.getAttribute(ROW_ID);
    if (key) existing.set(key, child);
  }

  const wanted: Element[] = [];
  for (const row of rows) {
    const reused = existing.get(row.id);
    const node = reused ?? (template.cloneNode(true) as Element);
    if (reused) existing.delete(row.id);
    node.setAttribute(ROW_ID, row.id);
    fillFields(node, row, checkable);
    wanted.push(node);
  }

  // Drop the rows that are gone, then place the rest in order. appendChild
  // MOVES an existing node, so reused rows keep their state.
  for (const orphan of existing.values()) orphan.remove();
  for (const child of Array.from(container.children)) {
    if (!wanted.includes(child)) child.remove();
  }
  for (const node of wanted) container.appendChild(node);
}

/**
 * Apply rows to a widget body. Safe to call repeatedly with the same rows: it
 * is idempotent, and identical data produces no DOM writes worth noticing.
 */
export function applyBindings(
  root: HTMLElement,
  rows: BoundRow[],
  options: ApplyOptions = {}
): void {
  const checkable = options.checkable === true;
  for (const el of Array.from(root.querySelectorAll("[data-count]"))) {
    el.textContent = String(rows.length);
  }

  const containers = Array.from(root.querySelectorAll("[data-each]"));
  for (const container of containers) fillEach(container, rows, checkable);

  // Fields outside any data-each describe the FIRST row: "next up" widgets read
  // naturally that way, and a template with no rows leaves them blank.
  const outside = Array.from(root.querySelectorAll("[data-field]")).filter(
    (el) => !el.closest("[data-each]")
  );
  if (outside.length) {
    const first = rows[0] ?? { id: "", fields: {} };
    for (const el of outside) {
      const name = el.getAttribute("data-field");
      if (name) {
        el.textContent = Object.hasOwn(first.fields, name) ? first.fields[name] : "";
      }
    }
  }

  for (const el of Array.from(root.querySelectorAll("[data-empty]"))) {
    (el as HTMLElement).hidden = rows.length > 0;
  }
}
