"use client";

// Split-workspace state, shared between the header toggle and the chat page
// (and consumed by ChatThread to decide docked vs full-screen voice).
import { createContext, useContext } from "react";

export const SplitContext = createContext<{ dockVoice: boolean }>({ dockVoice: false });
export const useSplit = () => useContext(SplitContext);

export const SPLIT_EVENT = "secretary:split-toggle";
const KEY = "chat-split";

/** Split is the default on large screens; "off" is the stored opt-out. */
export function readSplitPref(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeSplitPref(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent(SPLIT_EVENT, { detail: on }));
}
