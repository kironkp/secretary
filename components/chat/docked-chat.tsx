"use client";

// The chat dock (SPEC §7.7): chat is not a tab — this rides fixed at the
// bottom of every page. Bar = composer only; a send pops the answer up in a
// peek panel; the caret expands to the full thread. Thread data is fetched
// once on mount (after paint — navigation never waits on it); the ?c= deep
// link from push receipts opens the dock fully on that conversation. While a
// voice call is live the dock slides away — the call pill owns the bottom.
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { BriefingCard } from "@/lib/secretary/briefing";
import { ChatThread, type DockState } from "./chat-thread";
import { useVoiceCall } from "./voice-call-provider";

type Bootstrap = {
  conversationId: string | null;
  messages: {
    id: string;
    role: "user" | "assistant" | "tool";
    content: string;
    mode: "voice" | "text";
    attachments?: { id: string; mime: string; name: string }[] | null;
  }[];
  briefing: BriefingCard;
  secretaryName: string;
  defaultVoice: string;
  voiceEffort: string;
  chatModel: string;
  chatEffort: string;
};

export function DockedChat() {
  const params = useSearchParams();
  const call = useVoiceCall();
  const deepC = params.get("c");
  const deepM = params.get("m") ?? undefined;
  const [state, setState] = useState<DockState>(deepC ? "full" : "bar");
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [failed, setFailed] = useState(false);
  const [retrySeq, setRetrySeq] = useState(0);

  // A ?c= arriving while the app is already open (tapping a push receipt in
  // the foreground) expands the dock — derived during render, not an effect.
  const [prevC, setPrevC] = useState(deepC);
  if (deepC !== prevC) {
    setPrevC(deepC);
    if (deepC) setState("full");
  }

  // One fetch per (mount, deep-linked conversation, retry).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/chat/bootstrap${deepC ? `?c=${encodeURIComponent(deepC)}` : ""}`
        );
        if (!res.ok) throw new Error();
        const body = (await res.json()) as Bootstrap;
        if (!cancelled) setBootstrap(body);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deepC, retrySeq]);

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-30 transition-all duration-300 ease-out motion-reduce:transition-none ${
        call.active ? "pointer-events-none translate-y-full opacity-0" : ""
      }`}
    >
      <div className="mx-auto w-full max-w-2xl px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        {bootstrap ? (
          <ChatThread
            key={bootstrap.conversationId ?? "fresh"}
            initialConversationId={bootstrap.conversationId}
            initialMessages={bootstrap.messages}
            briefing={bootstrap.briefing}
            anchorMessageId={deepM}
            secretaryName={bootstrap.secretaryName}
            defaultVoice={bootstrap.defaultVoice}
            defaultVoiceEffort={bootstrap.voiceEffort}
            initialChatModel={bootstrap.chatModel}
            initialChatEffort={bootstrap.chatEffort}
            dock={{ state, setState }}
          />
        ) : (
          // Placeholder bar: same silhouette, no interaction — swapped for the
          // real composer as soon as the thread arrives (one fast fetch).
          <div className="rounded-2xl border border-edge bg-surface px-4 py-3 shadow-sm">
            {failed ? (
              <button
                onClick={() => {
                  setFailed(false);
                  setRetrySeq((s) => s + 1);
                }}
                className="text-sm text-accent hover:underline"
              >
                Chat couldn&rsquo;t load — tap to retry
              </button>
            ) : (
              <p className="animate-pulse text-[15px] text-faint">Message your secretary…</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
