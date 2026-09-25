// Where the minimized call draws itself: a slot inside the chat card (the
// dock's composer row), so a call and a chat are one widget — the same
// pill, the same grabber, the same conversation above it (Kiron,
// 2026-09-24: "merge the two… it's the same widget"). The chat card
// registers the element; the call (voice-mode.tsx) portals its row into it.
// With no dock on the page, the call falls back to its own floating pill.
import { useSyncExternalStore } from "react";

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** A ref callback: the chat card hands over its slot, or null when it goes. */
export function setCallSlot(el: HTMLElement | null) {
  if (slot === el) return;
  slot = el;
  listeners.forEach((l) => l());
}

export function useCallSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => slot,
    () => null
  );
}
