"use client";

// Floating chat: the REAL chat thread — briefing card, dictation mic, Talk
// button and all — docked in a corner panel so the secretary is reachable
// while viewing the Canvas or Dashboard. Hidden on /chat (the thread is the
// page there). Thread state is fetched once on first open and survives
// collapse; SplitContext docks voice INTO the panel instead of full-screen.
import { useState } from "react";
import { usePathname } from "next/navigation";
import { MessageCircle, X } from "lucide-react";
import type { BriefingCard } from "@/lib/secretary/briefing";
import { ChatThread } from "./chat-thread";
import { SplitContext } from "./split-context";

type Bootstrap = {
  conversationId: string | null;
  messages: { id: string; role: "user" | "assistant" | "tool"; content: string; mode: "voice" | "text" }[];
  briefing: BriefingCard;
  secretaryName: string;
  defaultVoice: string;
};

export function FloatingChat() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  if (pathname.startsWith("/chat")) return null;

  const openPanel = async () => {
    setOpen(true);
    if (bootstrap || loading) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch("/api/chat/bootstrap");
      if (!res.ok) throw new Error();
      setBootstrap((await res.json()) as Bootstrap);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {!open && (
        <button
          onClick={() => void openPanel()}
          title="Chat with your secretary"
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white shadow-lg transition-transform hover:scale-105"
        >
          <MessageCircle size={20} aria-hidden />
        </button>
      )}
      <div
        className={`fixed bottom-5 right-5 z-40 flex w-[28rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl ${
          open ? "h-[38rem] max-h-[80vh]" : "pointer-events-none h-0 opacity-0"
        }`}
      >
        <div className="flex flex-none items-center justify-between border-b border-edge bg-card px-4 py-2.5">
          <span className="text-sm font-bold">{bootstrap?.secretaryName ?? "Secretary"}</span>
          <button
            onClick={() => setOpen(false)}
            title="Minimize"
            className="text-muted hover:text-ink"
          >
            <X size={16} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 px-4">
          {bootstrap ? (
            // dockVoice: the Talk overlay docks into this pane, not the screen.
            <SplitContext.Provider value={{ dockVoice: true }}>
              <ChatThread
                initialConversationId={bootstrap.conversationId}
                initialMessages={bootstrap.messages}
                briefing={bootstrap.briefing}
                secretaryName={bootstrap.secretaryName}
                defaultVoice={bootstrap.defaultVoice}
              />
            </SplitContext.Provider>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              {error ? (
                <button onClick={() => void openPanel()} className="text-accent hover:underline">
                  Couldn&rsquo;t load — tap to retry
                </button>
              ) : (
                <span className="animate-pulse">Loading your thread…</span>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
