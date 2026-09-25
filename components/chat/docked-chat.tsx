"use client";

// The chat dock (SPEC §7.7), after Gemini in Chrome: chat is not a tab, it
// rides above every page. Closed, it is one round launcher at the bottom
// right; tapped, a floating pill (+, the field, dictation, the call, x); a
// send, or a drag up on its handle, grows the pill into the conversation.
// The tab bar stays underneath throughout. Thread data is fetched once on
// mount (after paint — navigation never waits on it); the ?c= deep link from
// push receipts opens the dock fully on that conversation. While a voice call
// is live, its controls take the composer's place in the same card.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
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

/** The morph's length and curve: the app's 340ms leading curve (nav-tabs.tsx). */
const MORPH_MS = 340;
const MORPH_EASE = "cubic-bezier(0.22, 0.9, 0.32, 1)";
/** The card's fade-in over the landed shape. */
const FADE_MS = 140;

type Box = { left: number; top: number; width: number; height: number };
type Morph = { dir: "open" | "close"; from: Box; to: Box | null; run: boolean; landed?: boolean };

const REDUCED = "(prefers-reduced-motion: reduce)";
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCED);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false
  );
}

function LauncherIcon() {
  return (
    <svg viewBox="0 0 24 24" width={26} height={26} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
    </svg>
  );
}

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

  // A live call is drawn inside the card (call-slot.ts), so the card is up
  // for as long as the call is: closed reads as the pill until it ends.
  const callHere = call.active && !call.hosted;
  const shown: DockState = callHere && state === "closed" ? "bar" : state;

  // --- the morph (Kiron, 2026-09-25): the launcher grows into the pill and
  // shrinks back into it, one black shape, the icon fading as it goes. A
  // proxy shape animates between the two measured rects (the classic shared-
  // element move) while the real card waits invisible underneath, then the
  // card fades in over it; closing runs it backwards. Geometry is the
  // shell's, and nothing re-mounts.
  const reduce = useReducedMotion();
  const launcherRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [morph, setMorph] = useState<Morph | null>(null);

  const rectOf = (el: Element | null | undefined): Box | null => {
    const r = el?.getBoundingClientRect();
    return r && r.width ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  };

  const open = () => {
    const from = rectOf(launcherRef.current);
    setState("bar");
    if (from && !reduce) setMorph({ dir: "open", from, to: null, run: false });
  };
  // Every close goes through here — the pill's x, the card's x — so each one
  // shrinks back into the launcher.
  const setDock = (next: DockState) => {
    if (next === "closed" && state !== "closed" && !callHere && !reduce) {
      const from = rectOf(cardRef.current?.querySelector('[data-testid="chat-card"]'));
      const to = rectOf(launcherRef.current);
      if (from && to) setMorph({ dir: "close", from, to, run: false });
    }
    setState(next);
  };

  // Opening: the card is laid out (invisible) by now, so measure where the
  // shape is going, then start it on the next frame.
  useLayoutEffect(() => {
    if (!morph || morph.run) return;
    if (morph.dir === "open" && !morph.to) {
      const to = rectOf(cardRef.current?.querySelector('[data-testid="chat-card"]'));
      if (!to) return setMorph(null);
      setMorph({ ...morph, to });
      return;
    }
    const raf = requestAnimationFrame(() => setMorph((m) => (m ? { ...m, run: true } : m)));
    return () => cancelAnimationFrame(raf);
  }, [morph]);
  // The shape is done when its move ends (transitionend on the shape), with
  // a timer behind it in case that event never comes.
  useEffect(() => {
    if (!morph?.run) return;
    const t = setTimeout(() => setMorph(null), MORPH_MS * 4);
    return () => clearTimeout(t);
  }, [morph?.run]);

  const morphing = morph !== null;
  const box = morph ? (morph.run ? morph.to : morph.from) : null;

  return (
    // The wrapper lets taps through; only the card, the launcher and the tab
    // bar take them, so the strip beside the launcher never blocks the page.
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30"
    >
      <DockHeight />
      <div className="mx-auto w-full max-w-2xl px-3">
        {bootstrap ? (
          <div
            ref={cardRef}
            className={shown === "closed" ? "hidden" : "pointer-events-auto"}
            // Under the moving shape while it opens; faded in once it lands.
            style={{
              opacity: morph?.dir === "open" && !morph.landed ? 0 : 1,
            }}
          >
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
              dock={{ state: shown, setState: setDock }}
            />
          </div>
        ) : shown !== "closed" ? (
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
      {box && (
        // The moving shape: the launcher's black and glow, from one rect to
        // the other; the icon fades as it grows, and returns as it shrinks.
        <div
          aria-hidden
          data-theme="dark"
          data-testid="chat-morph"
          onTransitionEnd={(e) => {
            if (e.target !== e.currentTarget) return;
            // Opening lands on the pill: the pill is shown under the shape at
            // once and the shape fades off it, so the contents come up out of
            // the same black instead of the black blinking away. Closing lands
            // on the launcher, which is the same shape: swap in place.
            if (e.propertyName === "width") {
              if (morph?.dir === "open" && !morph.landed) setMorph({ ...morph, landed: true });
              else if (morph?.dir === "close") setMorph(null);
            } else if (e.propertyName === "opacity" && morph?.landed) {
              setMorph(null);
            }
          }}
          className="pointer-events-none fixed z-40 grid place-items-center overflow-hidden bg-black text-ink"
          style={{
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            borderRadius: Math.min(28, box.height / 2),
            boxShadow: `${CALL_GLOW_SMALL}, 0 8px 24px rgba(0,0,0,0.3)`,
            opacity: morph?.landed ? 0 : 1,
            transition: morph?.landed
              ? `opacity ${FADE_MS}ms ease-out`
              : morph?.run
              ? `left ${MORPH_MS}ms ${MORPH_EASE}, top ${MORPH_MS}ms ${MORPH_EASE}, width ${MORPH_MS}ms ${MORPH_EASE}, height ${MORPH_MS}ms ${MORPH_EASE}, border-radius ${MORPH_MS}ms ${MORPH_EASE}`
              : "none",
          }}
        >
          <span
            style={{
              opacity: (morph?.dir === "open") === Boolean(morph?.run) ? 0 : 1,
              transition: `opacity ${MORPH_MS * 0.6}ms ease-out`,
            }}
          >
            <LauncherIcon />
          </span>
        </div>
      )}
      <div className="pointer-events-auto relative border-t border-sep bg-bar backdrop-blur-xl">
        {/* The launcher sits above the tab bar at the right, out of the flow,
            so it can be measured at any time; hidden while the chat is up and
            while the shape is flying back into it. */}
        <button
          ref={launcherRef}
          type="button"
          data-theme="dark"
          data-testid="chat-launcher"
          onClick={open}
          title="Ask your secretary"
          aria-label="Ask your secretary"
          aria-hidden={shown !== "closed" || undefined}
          tabIndex={shown === "closed" ? 0 : -1}
          className={`absolute bottom-[calc(100%+0.5rem)] right-4 grid h-14 w-14 place-items-center rounded-full bg-black text-ink transition-transform active:scale-95 ${
            shown === "closed" && !morphing ? "pointer-events-auto" : "pointer-events-none"
          }`}
          style={{
            boxShadow: `${CALL_GLOW_SMALL}, 0 8px 24px rgba(0,0,0,0.3)`,
            opacity: shown === "closed" && !morphing ? 1 : 0,
          }}
        >
          <LauncherIcon />
        </button>
        <TabBar />
      </div>
    </div>
  );
}
