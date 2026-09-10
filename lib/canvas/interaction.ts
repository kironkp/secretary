// Canvas interactivity, as a pure function of a Document.
//
// This lives outside the React component for one reason: it is the part that
// was broken and could not be tested. vitest runs in node with no DOM, so the
// only canvas tests were of the SERVER helpers (collectCheckIds, doneCheckIds).
// The entire click path — box injection, hit testing, which element wins a tap —
// had no coverage at all, which is how "checkboxes on the canvas" was marked
// shipped while being unclickable in the product.
//
// Everything here takes a Document and returns nothing, so a jsdom test can
// drive it exactly as the browser does.

export type CheckState = (taskId: string) => boolean;

export type CanvasHandlers = {
  /** The user tapped a task's checkbox. `next` is the state they asked for —
   *  tapping a ticked box UN-ticks it, because an accidental tap must be
   *  undoable on the surface where it happened. */
  onCheck: (taskId: string, next: boolean) => void;
  /** A card wants to open its project/entity. */
  onLink: (id: string) => void;
  /** A tap landed inside this document's block (shared world model). */
  onSelect?: () => void;
  /** After an expand toggles, the block's height changed. */
  onResize?: () => void;
  /**
   * True while a momentum scroll is in flight, so a scroll-stop tap doesn't
   * count as intent. NOTE: this deliberately does NOT gate the checkbox — see
   * the click handler.
   */
  isMomentumTap?: () => boolean;
};

const BOX_CLASS = "cv-box";

/**
 * Draw the shell's checkbox into every task row and sync its state.
 *
 * Idempotent: safe to call on every poll and every re-wire, which matters
 * because a document can be replaced under us (the iOS srcdoc swap) and the
 * boxes have to come back.
 */
export function applyCheckState(doc: Document, isChecked: CheckState): void {
  for (const el of Array.from(doc.querySelectorAll("[data-check]"))) {
    const id = el.getAttribute("data-check");
    if (!id) continue;

    // A table row cannot host a positioned box (padding doesn't apply to
    // display:table-row, and a stray child becomes a phantom leading column),
    // so the box goes in the row's first cell instead.
    const host =
      el.tagName === "TR"
        ? (el.querySelector(":scope > td, :scope > th") as HTMLElement | null)
        : (el as HTMLElement);
    if (!host) continue;

    let box = host.querySelector(`:scope > .${BOX_CLASS}`) as HTMLElement | null;
    if (!box) {
      box = doc.createElement("span");
      box.className = BOX_CLASS;
      box.setAttribute("role", "checkbox");
      // Focusable so Space/Enter work — a checkbox reachable only by tap is
      // not a checkbox.
      box.setAttribute("tabindex", "0");
      host.classList.add("cv-checkable");
      // Painted cards carry their own INLINE padding, which beats the
      // stylesheet's padding-left, so the gutter is reserved inline — and only
      // when the card isn't already padded enough.
      const current = parseFloat(doc.defaultView?.getComputedStyle(host).paddingLeft || "0");
      if (!(current >= 30)) host.style.paddingLeft = "30px";
      host.insertBefore(box, host.firstChild);
    }

    const on = isChecked(id);
    box.setAttribute("aria-checked", on ? "true" : "false");
    box.setAttribute("aria-label", on ? "Mark not done" : "Mark done");
    el.classList.toggle("cv-done", on);
  }
}

/** The task id a checkbox belongs to. Resolved from the DOM, never from
 *  position or label, so two rows with identical text stay independent. */
export function taskIdForBox(box: Element): string | null {
  return box.closest("[data-check]")?.getAttribute("data-check") ?? null;
}

/**
 * Attach the shell's interaction to one canvas document.
 *
 * Returns a teardown so a replaced document doesn't leak listeners.
 */
export function wireCanvasDocument(doc: Document, handlers: CanvasHandlers): () => void {
  const onClick = (e: Event) => {
    const el = e.target as Element | null;

    // THE CHECKBOX IS NEVER GATED BY THE MOMENTUM GUARD.
    //
    // The guard exists because tapping to stop a scroll used to complete a
    // task — back when the whole card was the completion target. Now that
    // completing requires hitting an 18px box, the tap is unambiguously
    // deliberate, and the guard was doing real harm: the canvas re-measures
    // its blocks after load, which changes the board height, which fires page
    // scroll events, which kept isMomentumTap() true and silently swallowed
    // every checkbox click. That is the bug that made this feature look
    // shipped and behave broken.
    const box = el?.closest?.(`.${BOX_CLASS}`);
    if (box) {
      const id = taskIdForBox(box);
      // Stop the card underneath from also navigating on the same tap.
      e.preventDefault();
      e.stopPropagation();
      if (id) handlers.onCheck(id, box.getAttribute("aria-checked") !== "true");
      return;
    }

    // Card-level actions stay guarded: a scroll-stop tap should not navigate.
    if (handlers.isMomentumTap?.()) return;
    handlers.onSelect?.();

    const target = el?.closest?.("[data-expand],[data-link],[data-check]");
    if (!target) return;

    const link = target.getAttribute("data-link");
    if (link) {
      handlers.onLink(link);
      return;
    }
    target.classList.toggle("cv-expanded");
    handlers.onResize?.();
  };

  // Space/Enter on a focused checkbox, the same as clicking it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== " " && e.key !== "Enter") return;
    const box = (e.target as Element | null)?.closest?.(`.${BOX_CLASS}`);
    if (!box) return;
    e.preventDefault();
    const id = taskIdForBox(box);
    if (id) handlers.onCheck(id, box.getAttribute("aria-checked") !== "true");
  };

  doc.addEventListener("click", onClick);
  doc.addEventListener("keydown", onKeyDown as EventListener);
  return () => {
    doc.removeEventListener("click", onClick);
    doc.removeEventListener("keydown", onKeyDown as EventListener);
  };
}
