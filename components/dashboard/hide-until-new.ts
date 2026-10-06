"use client";

// "Hide until something new" (SEC-A006, Kiron's pick): hiding the past-due
// chip, or the suggestions, keeps them hidden until an item appears that was
// not there when they were hidden. The ids present at that moment are the
// snapshot; an item that is done or dropped meanwhile does not bring them
// back, a new one does. Kept per device in localStorage, which can be
// missing or throw (private mode): then nothing is hidden.
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

/** Still hidden: something was hidden, and every current id was already there then. */
export function stillHidden(current: readonly string[], snapshot: readonly string[] | null): boolean {
  if (!snapshot) return false;
  const seen = new Set(snapshot);
  return current.every((id) => seen.has(id));
}

const CHANGED = "secretary:hide-until-new";

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parse(raw: string | null): string[] | null {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function write(key: string, ids: readonly string[] | null): void {
  try {
    if (ids) window.localStorage.setItem(key, JSON.stringify(ids));
    else window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable: the choice just doesn't stick */
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * `ready` is false until the stored choice has been read (the server, and
 * the first client render, cannot know it), so a hidden area never flashes
 * in on load. `hide` snapshots the current ids; `show` forgets the choice.
 */
export function useHideUntilNew(key: string, current: readonly string[]) {
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => undefined
  );
  const ready = raw !== undefined;
  const snapshot = useMemo(() => (raw === undefined ? null : parse(raw)), [raw]);
  const hidden = stillHidden(current, snapshot);
  // Once something new has arrived the old snapshot means nothing: forget it,
  // so a later hide starts clean.
  useEffect(() => {
    if (ready && snapshot && !hidden) write(key, null);
  }, [ready, snapshot, hidden, key]);
  const hide = useCallback(() => write(key, [...current]), [key, current]);
  const show = useCallback(() => write(key, null), [key]);
  return { ready, hidden, hide, show };
}
