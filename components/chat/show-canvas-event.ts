"use client";

// Auto-open Canvas (SPEC §7.6 auto-open): tool outcomes carry a UI-only
// uiAction; the chat surface dispatches this cancelable event and whichever
// shell surface can show the canvas IN PLACE claims it via preventDefault
// (same idiom as SPLIT_EVENT). No claimant = navigate to the Canvas tab.
export const SHOW_CANVAS_EVENT = "secretary:show-canvas";

/** Dispatch the event; true = a surface claimed it and is showing the canvas. */
export function requestShowCanvas(): boolean {
  return !window.dispatchEvent(new CustomEvent(SHOW_CANVAS_EVENT, { cancelable: true }));
}
