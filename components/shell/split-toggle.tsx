"use client";

// Header toggle for the chat split workspace — only shown on /chat, lg+.
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { PanelRight } from "lucide-react";
import { readSplitPref, writeSplitPref } from "@/components/chat/split-context";

export function SplitToggle() {
  const pathname = usePathname();
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setOn(readSplitPref()), 0);
    return () => clearTimeout(t);
  }, []);

  if (!pathname.startsWith("/chat")) return null;
  return (
    <button
      onClick={() => {
        const next = !on;
        setOn(next);
        writeSplitPref(next);
      }}
      title={on ? "Hide the dashboard pane" : "Show the dashboard pane"}
      aria-label={on ? "Hide the dashboard pane" : "Show the dashboard pane"}
      className={`hidden h-8 w-8 flex-none items-center justify-center rounded-full transition-colors lg:flex ${
        on ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface-2 hover:text-ink"
      }`}
    >
      <PanelRight size={16} strokeWidth={1.75} />
    </button>
  );
}
