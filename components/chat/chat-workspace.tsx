"use client";

// Split workspace (lg+): chat pane left with its own scroll, live dashboard
// right. Mobile/tablet keeps the plain chat page. The provider tells
// ChatThread when voice should dock into the pane instead of covering the
// screen.
import { useEffect, useState, type ReactNode } from "react";
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

  const active = split && isLg;

  return (
    <SplitContext.Provider value={{ dockVoice: active }}>
      <div className="flex h-full">
        <div
          className={
            active
              ? "flex h-full w-[30rem] flex-none flex-col border-r border-edge pr-5"
              : "h-full w-full"
          }
        >
          {chat}
        </div>
        {active && (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pl-5">{dashboard}</div>
        )}
      </div>
    </SplitContext.Provider>
  );
}
