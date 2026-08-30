"use client";

// Split workspace (lg+): chat pane left with its own scroll, live dashboard
// right. Mobile/tablet keeps the plain chat page. The provider tells
// ChatThread when voice should dock into the pane instead of covering the
// screen. On large screens this surface also claims the auto-open Canvas
// event (SPEC §7.6): the chat column shrinks to a compact rail while a
// Canvas pane rises in beside it — both panes stay mounted, so the thread
// (and any typed draft) survives the trip.
import { useEffect, useState, type ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import { CanvasView } from "@/components/canvas/canvas-view";
import { SHOW_CANVAS_EVENT } from "./show-canvas-event";
import { SPLIT_EVENT, SplitContext, readSplitPref } from "./split-context";

export function ChatWorkspace({
  chat,
  dashboard,
}: {
  chat: ReactNode;
  dashboard: ReactNode;
}) {
  const [split, setSplit] = useState(false);
  const [isLg, setIsLg] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const applyMq = () => setIsLg(mq.matches);
    const t = setTimeout(() => {
      applyMq();
      setSplit(readSplitPref());
    }, 0);
    mq.addEventListener("change", applyMq);
    const onToggle = (e: Event) => setSplit(Boolean((e as CustomEvent).detail));
    window.addEventListener(SPLIT_EVENT, onToggle);
    return () => {
      clearTimeout(t);
      mq.removeEventListener("change", applyMq);
      window.removeEventListener(SPLIT_EVENT, onToggle);
    };
  }, []);

  // Auto-open Canvas (SPEC §7.6): on lg this pane claims the event so the
  // canvas arrives beside the chat instead of navigating away.
  useEffect(() => {
    if (!isLg) return;
    const onShow = (e: Event) => {
      e.preventDefault();
      setCanvasOpen(true);
    };
    window.addEventListener(SHOW_CANVAS_EVENT, onShow);
    return () => window.removeEventListener(SHOW_CANVAS_EVENT, onShow);
  }, [isLg]);

  const active = split && isLg;
  const paneCanvas = canvasOpen && isLg;

  return (
    <SplitContext.Provider value={{ dockVoice: active || paneCanvas }}>
      <div className="flex h-full">
        <div
          className={`h-full transition-[width] duration-300 ease-out motion-reduce:transition-none ${
            paneCanvas
              ? "flex w-72 flex-none flex-col border-r border-edge pr-5"
              : active
                ? "flex w-[30rem] flex-none flex-col border-r border-edge pr-5"
                : "w-full"
          }`}
        >
          {chat}
        </div>
        {/* Dashboard stays mounted (hidden) while the canvas is up so its
            state survives the round trip back to the split view. */}
        {active && (
          <div
            className={`min-h-0 min-w-0 flex-1 overflow-y-auto pl-5 ${paneCanvas ? "hidden" : ""}`}
          >
            {dashboard}
          </div>
        )}
        {paneCanvas && (
          <div className="min-h-0 min-w-0 flex-1 animate-rise-in overflow-y-auto pl-5 motion-reduce:animate-none">
            <div className="flex items-center justify-between py-2">
              <h2 className="text-lg font-bold">Canvas</h2>
              <button
                onClick={() => setCanvasOpen(false)}
                title="Back to full chat"
                aria-label="Back to full chat"
                className="flex items-center gap-1.5 rounded-full border border-edge bg-card px-3 py-1.5 text-xs text-muted transition-colors hover:text-ink"
              >
                <MessageSquare size={13} strokeWidth={2} className="flex-none" />
                Back to chat
              </button>
            </div>
            <CanvasView pollMs={3000} />
          </div>
        )}
      </div>
    </SplitContext.Provider>
  );
}
