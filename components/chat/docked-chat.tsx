"use client";

// The chat dock (SPEC §7.7), after Gemini in Chrome: chat is not a tab, it
// rides above every page. Closed, it is one round launcher at the bottom
// right; tapped, a floating pill (+, the field, dictation, the call, x); a
// send, or a drag up on its handle, grows the pill into the conversation.
// The tab bar stays underneath throughout. Thread data is fetched once on
// mount (after paint — navigation never waits on it); the ?c= deep link from
// push receipts opens the dock fully on that conversation. While a voice call
// is live the dock slides away — the call pill owns the bottom.
import { useEffect, useState } from "react";
import { DockHeight } from "./dock-height";
import { TabBar } from "@/components/shell/tab-bar";
import { useSearchParams } from "next/navigation";
import type { BriefingCard } from "@/lib/secretary/briefing";
import { ChatThread, type DockState } from "./chat-thread";
import { useVoiceCall } from "./voice-call-provider";
import { CALL_GLOW_SMALL } from "./call-look";

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
  const [state, setState] = useState<DockState>(deepC ? "full" : "closed");
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
    // The wrapper lets taps through; only the card, the launcher and the tab
    // bar take them, so the strip beside the launcher never blocks the page.
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-30 transition-all duration-300 ease-out motion-reduce:transition-none ${
        call.active ? "translate-y-full opacity-0" : ""
      }`}
    >
      <DockHeight />
      <div className="mx-auto w-full max-w-2xl px-3">
        {bootstrap ? (
          <div className={state === "closed" ? "hidden" : "pointer-events-auto"}>
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
          </div>
        ) : state !== "closed" ? (
          // Placeholder pill: same silhouette, no interaction — swapped for
          // the real one as soon as the thread arrives (one fast fetch).
          <div
            data-theme="dark"
            className="pointer-events-auto mb-2 rounded-[26px] bg-black px-5 py-4 text-ink"
            style={{ boxShadow: CALL_GLOW_SMALL }}
          >
            {failed ? (
              <button
                onClick={() => {
                  setFailed(false);
                  setRetrySeq((s) => s + 1);
                }}
                className="text-[15px] text-accent"
              >
                Chat couldn&rsquo;t load — tap to retry
              </button>
            ) : (
              <p className="animate-pulse text-[17px] text-faint">Ask your secretary</p>
            )}
          </div>
        ) : null}
      </div>
      {state === "closed" && (
        <div className="flex justify-end px-4 pb-2">
          <button
            type="button"
            data-theme="dark"
            data-testid="chat-launcher"
            onClick={() => setState("bar")}
            title="Ask your secretary"
            aria-label="Ask your secretary"
            className="animate-rise-in pointer-events-auto grid h-14 w-14 place-items-center rounded-full bg-black text-ink transition-transform active:scale-95"
            style={{ boxShadow: `${CALL_GLOW_SMALL}, 0 8px 24px rgba(0,0,0,0.3)` }}
          >
            <svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
            </svg>
          </button>
        </div>
      )}
      <div className="pointer-events-auto border-t border-sep bg-bar backdrop-blur-xl">
        <TabBar />
      </div>
    </div>
  );
}
