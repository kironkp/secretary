"use client";

// The live voice call: the "Talk" frame of the "Secretary on iPhone" mockup.
// A black surface with the tint's inset glow; bottom-aligned, the user's last
// words (right, grey), the secretary's last reply (large, white), a six-bar
// waveform that bobs while she speaks and holds still while she listens, and
// two round controls: Mute and End. The call is dark
// in both themes. Voice, thinking depth and model keep their dropdowns behind
// the "⋯" at the top right. The minimized pill rides above every page.
//
// IMPORTANT (iOS): never attach a Web Audio AnalyserNode to the mic stream
// while the WebRTC call is live — on iOS Safari that re-routes the audio
// session and can silence the outbound track (dictation is unaffected because
// it has no WebRTC). Levels come from RTCPeerConnection.getStats() instead.
import { CALL_GLOW } from "./call-look";
import { MessageActions } from "./message-actions";
import { LiveMicButton } from "./live-mic-button";
import { useCallSlot } from "./call-slot";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Bookmark,
  Calendar,
  Check,
  ChevronDown,
  Ellipsis,
  FolderPlus,
  Hourglass,
  Mic,
  Pencil,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import {
  playRemoteStream,
  stopRemoteAudio,
  unlockRemoteAudio,
} from "@/lib/realtime/remote-audio";
import { requestCanvasRefresh } from "@/lib/canvas/refresh";
import type { VoiceFlavor } from "@/lib/realtime/types";
import { useVoiceSession, type TranscriptLine } from "./use-voice-session";

// Tool toasts arrive from the server with a legacy glyph string — map it to
// the icon set here so no emoji reaches the chrome.
function ToastIcon({ glyph }: { glyph: string }) {
  const cls = "text-ok";
  const size = 13;
  switch (glyph) {
    case "✓":
      return <Check size={size} strokeWidth={2.5} className={cls} />;
    case "→":
      return <ArrowRight size={size} strokeWidth={2} className="text-warn" />;
    case "✎":
      return <Pencil size={size} strokeWidth={2} className="text-accent" />;
    case "▣":
      return <FolderPlus size={size} strokeWidth={2} className="text-accent" />;
    case "📅":
      return <Calendar size={size} strokeWidth={2} className="text-accent" />;
    case "◆":
      return <Bookmark size={size} strokeWidth={2} className="text-grape" />;
    default:
      return <Check size={size} strokeWidth={2.5} className={cls} />;
  }
}

// The mockup's control glyphs, drawn as it drew them (24px, 1.8 stroke) so the
// buttons read the same on the phone as on the design page.
function XGlyph({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M5 5l14 14M19 5L5 19" />
    </svg>
  );
}

// The mockup's waveform: six 5px bars in the tint at fixed heights. While the
// secretary speaks each bar bobs between 55% and full height, 1.1s alternate,
// staggered 0.12s; while she listens it holds still. The keyframes live here
// with the only element that uses them. Reduced motion: app/globals.css
// collapses every animation to one frame, and with no fill mode the bars
// settle at their full heights, so the mark is still there, just still.
const WAVE_HEIGHTS = [10, 22, 16, 26, 14, 20];

function Waveform({ active, className = "" }: { active: boolean; className?: string }) {
  return (
    <div className={`flex h-7 items-center gap-[5px] ${className}`} aria-hidden>
      <style>{"@keyframes talk-bob{from{transform:scaleY(.55)}to{transform:scaleY(1)}}"}</style>
      {WAVE_HEIGHTS.map((h, i) => (
        <i
          key={i}
          className="block w-[5px] rounded-[3px] bg-accent"
          style={{
            height: h,
            animation: active
              ? `talk-bob 1.1s ease-in-out ${(i * 0.12).toFixed(2)}s infinite alternate`
              : undefined,
          }}
        />
      ))}
    </div>
  );
}

const VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
];

const MODELS = [
  { id: "gpt-realtime-2.1", label: "GPT Realtime (best)" },
  { id: "gpt-realtime-2.1-mini", label: "GPT Realtime Mini (faster/cheaper)" },
];

const VOICE_EFFORTS = [
  { id: "auto", label: "auto" },
  { id: "low", label: "quick" },
  { id: "medium", label: "thoughtful" },
  { id: "high", label: "deep (slower)" },
];

// The mockup's inset glow: the tint at 38%, 90px deep, on the black surface.
const GLOW = CALL_GLOW;

// The reply's type, the mockup's .her: 24px semibold, 1.27 leading, tight
// tracking, balanced wrap, at most 94% wide.
const REPLY_TYPE = "max-w-[94%] text-balance text-[24px] font-semibold leading-[1.27] tracking-[-0.01em]";
// A row of the "⋯" card: the 17px label, then the select on its own line,
// 44px tall and the card's full width, so no option label is ever cut.
const SELECT_ROW = "flex flex-col gap-0.5 px-4 pb-2.5 pt-2 text-[17px]";
const SELECT = "min-h-11 w-full min-w-0 bg-transparent text-[17px] text-accent outline-none";
// The user's words: 17px in the secondary grey, right-aligned, under 78% wide.
const YOU_TYPE = "max-w-[78%] self-end text-right text-[17px] text-faint";

export function VoiceMode({
  session,
  onClose,
  defaultVoice = "marin",
  defaultEffort = "auto",
  startMinimized = false,
  flavor,
  hidden = false,
  onTranscript,
}: {
  /** The globally-owned session (VoiceCallProvider) — the call survives
   *  navigation because nothing on a page owns it. */
  session: ReturnType<typeof useVoiceSession>;
  onClose: (conversationId: string | null) => void;
  /** Persona-preferred voice (server-persisted); in-call picks update it. */
  defaultVoice?: string;
  /** Realtime thinking depth ("auto" = API default); in-call picks persist. */
  defaultEffort?: string;
  /** Start as the floating pill (split workspace / floating chat) instead of
   *  taking the whole screen. */
  startMinimized?: boolean;
  /** What the call is for ("interview": the orb on the Interview tab). */
  flavor?: VoiceFlavor;
  /** Another surface is the call's UI right now (the interview orb): this
   *  keeps running the call (audio, watchdogs, refreshes) and draws nothing. */
  hidden?: boolean;
  /** Live transcript stream — lets the chat thread render voice lines as
   *  messages while the call is running (one conversation, not two worlds). */
  onTranscript?: (lines: TranscriptLine[]) => void;
}) {
  const router = useRouter();

  useEffect(() => {
    onTranscript?.(session.transcript);
  }, [session.transcript, onTranscript]);
  // Mobile lifeline: shrink the overlay to a floating pill — the page behind
  // becomes usable while the call (owned by the app shell) keeps running.
  const [minimized, setMinimized] = useState(startMinimized);
  const slot = useCallSlot();
  // The "⋯" menu: voice, thinking depth, model, and the canvas.
  const [menuOpen, setMenuOpen] = useState(false);

  // Auto-open (SPEC §7.6): a paint during the call goes to the Canvas TAB —
  // the call shrinks to its pill and the app navigates. There is no in-call
  // canvas view: one canvas, one place, nav always reachable.
  useEffect(() => {
    if (session.canvasSeq === 0) return;
    const t = setTimeout(() => {
      setMinimized(true);
      // No-op if the Canvas tab is already open, so ask the view to reload too.
      requestCanvasRefresh();
      router.push("/canvas");
    }, 0);
    return () => clearTimeout(t);
  }, [session.canvasSeq, router]);
  const [model, setModel] = useState(
    () => (typeof window !== "undefined" && localStorage.getItem("voice-model")) || MODELS[0].id
  );
  const [voice, setVoice] = useState(defaultVoice);
  const [effort, setEffort] = useState(defaultEffort);
  const [elAvailable, setElAvailable] = useState(false);

  // The ElevenLabs mouth option appears only when the server has keys.
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/elevenlabs/tts");
        if (res.ok) setElAvailable(Boolean(((await res.json()) as { configured: boolean }).configured));
      } catch {
        /* option stays hidden */
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  const [switching, setSwitching] = useState(false);
  const startedRef = useRef(false);

  const connected = session.status === "connected";

  // Poll WebRTC stats for the dead-mic watchdog. The mic warning only arms
  // when the browser actually reports an outbound audio level — no false
  // alarms where stats are unsupported. (The waveform follows speech events,
  // not levels, so the mockup's bars keep their shape.)
  const [micSilent, setMicSilent] = useState(false);
  const watchRef = useRef({ muted: false, transcriptLen: 0 });
  useEffect(() => {
    watchRef.current = {
      muted: session.muted,
      transcriptLen: session.transcript.length,
    };
  }, [session.muted, session.transcript.length]);
  useEffect(() => {
    if (!connected) return;
    let silentSince: number | null = null;
    const iv = setInterval(async () => {
      const l = await session.getLevels();
      const w = watchRef.current;
      if (l.mic === null || w.muted || w.transcriptLen > 0) {
        silentSince = null;
        setMicSilent(false);
        return;
      }
      if (l.mic > 0.01) {
        silentSince = null;
        setMicSilent(false);
        return;
      }
      if (silentSince === null) silentSince = Date.now();
      setMicSilent(Date.now() - silentSince > 8000);
    }, 150);
    return () => clearInterval(iv);
  }, [connected, session]);

  // Debug overlay (?voicedebug=1) — the iPhone has no console. Ugly on purpose.
  const [debugOn, setDebugOn] = useState(false);
  const [debugJson, setDebugJson] = useState("");
  useEffect(() => {
    const t = setTimeout(
      () => setDebugOn(new URLSearchParams(window.location.search).has("voicedebug")),
      0
    );
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!debugOn) return;
    const iv = setInterval(async () => {
      const info = session.getDebugInfo();
      const l = await session.getLevels();
      setDebugJson(JSON.stringify({ ...info, levels: l }, null, 1));
    }, 1000);
    return () => clearInterval(iv);
  }, [debugOn, session]);

  useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      session.start(model, voice, effort, flavor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach remote audio to the gesture-unlocked singleton element; retries
  // play() every tick in case a transient rejection paused it.
  useEffect(() => {
    if (!connected) return;
    const iv = setInterval(() => {
      const stream = session.getRemoteStream();
      if (stream) playRemoteStream(stream);
    }, 300);
    return () => clearInterval(iv);
  }, [connected, session]);

  // Stop the voice when leaving voice mode.
  useEffect(() => stopRemoteAudio, []);

  // D-5, the magic moment: each tool-call toast means the secretary just
  // logged something — refresh server data so the dashboard pane updates live
  // while the call continues. Debounced ~600ms so a burst of tool calls
  // coalesces into one refresh. (UI-layer subscription only.)
  const toastCount = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (session.toasts.length > toastCount.current) {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 600);
    }
    toastCount.current = session.toasts.length;
  }, [session.toasts.length, router]);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    []
  );

  // Safety net: while the call is live, re-sync the dashboard every 15s in
  // case a tool result slipped past the toast path.
  useEffect(() => {
    if (session.status !== "connected") return;
    const iv = setInterval(() => router.refresh(), 15000);
    return () => clearInterval(iv);
  }, [session.status, router]);

  const pickModel = async (m: string) => {
    setModel(m);
    localStorage.setItem("voice-model", m);
    if (connected) {
      setSwitching(true);
      await session.switchModel(m);
      setSwitching(false);
    }
  };

  const pickVoice = async (v: string) => {
    setVoice(v);
    // server-persisted: the same voice everywhere — every window, every device
    void fetch("/api/persona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: v }),
    }).catch(() => {});
    if (connected) {
      setSwitching(true);
      await session.switchVoice(v);
      setSwitching(false);
    }
  };

  const pickEffort = async (e: string) => {
    setEffort(e);
    void fetch("/api/persona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceEffort: e }),
    }).catch(() => {});
    if (connected) {
      setSwitching(true);
      await session.switchEffort(e);
      setSwitching(false);
    }
  };

  const endCall = async () => {
    const conversationId = await session.end();
    onClose(conversationId);
  };

  const retry = () => {
    unlockRemoteAudio();
    session.start(model, voice, effort, flavor);
  };

  // Before the call is up, the reply's slot carries the state in grey. Once
  // connected the slot is the reply itself, or nothing until there is one.
  const pendingHint =
    session.status === "requesting-mic"
      ? "Allow microphone access…"
      : session.status === "connecting"
        ? "Connecting…"
        : session.status === "reconnecting"
          ? switching
            ? "Switching model…"
            : "Reconnecting — hold on, your conversation is safe."
          : "";
  // The pill's one line: the state, or what the call is doing right now.
  const statusHint =
    pendingHint ||
    (session.assistantSpeaking ? "Speaking…" : connected ? "Listening…" : "");

  // The latest exchange: what you last said, and her last reply.
  const lastUser = [...session.transcript].reverse().find((l) => l.role === "user");
  const lastReply = [...session.transcript].reverse().find((l) => l.role === "assistant");

  const lastToast = session.toasts[session.toasts.length - 1];
  const pillButton =
    "flex h-11 w-11 flex-none items-center justify-center rounded-full transition-colors";
  // The call's row: status, full screen, mute, end. Drawn inside the chat
  // card when there is one (call-slot.ts), else in its own floating pill.
  const callRow = (
    <>
      {debugOn && (
        <pre
          onClick={() => void navigator.clipboard?.writeText(debugJson).catch(() => {})}
          className="max-h-32 overflow-y-auto border-b border-warn/40 bg-black/70 px-2 py-1 text-[9px] leading-tight text-warn"
          title="Tap to copy"
        >
          {debugJson || "collecting…"}
        </pre>
      )}
      <div className="flex items-center gap-2 px-3 py-2">
        {session.status === "error" && session.error ? (
          <>
            <TriangleAlert size={18} strokeWidth={1.75} className="flex-none text-warn" />
            <p className="min-w-0 flex-1 text-[15px] leading-[1.33] text-muted">
              {session.error.message}
            </p>
            {session.error.kind === "network" && (
              <button
                onClick={retry}
                className="min-h-11 flex-none rounded-full bg-accent px-4 text-[15px] font-semibold text-white"
              >
                Try again
              </button>
            )}
            <button
              onClick={() => onClose(null)}
              className="min-h-11 flex-none rounded-full bg-surface-2 px-4 text-[15px] font-semibold text-ink"
            >
              Close
            </button>
          </>
        ) : (
          <>
            <Waveform active={session.assistantSpeaking} className="flex-none" />
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold leading-[1.33]">
                {statusHint || "On a call"}
              </p>
              {lastToast ? (
                <p className="flex items-start gap-1.5 text-[13px] leading-[1.3] text-faint">
                  <span className="mt-[2px] flex-none">
                    <ToastIcon glyph={lastToast.icon} />
                  </span>
                  <span>{lastToast.text}</span>
                </p>
              ) : micSilent ? (
                <p className="text-[13px] leading-[1.3] text-warn">
                  Can&apos;t hear you — try ending and restarting the call.
                </p>
              ) : null}
            </div>
            <LiveMicButton
              muted={session.muted}
              onToggle={session.toggleMute}
              getLevels={session.getLevels}
              size={44}
            />
            <button
              onClick={endCall}
              title="End call"
              aria-label="End call"
              className={`${pillButton} bg-danger text-white`}
            >
              <XGlyph size={20} />
            </button>
          </>
        )}
      </div>
    </>
  );
  const dockBar = <div className="rounded-2xl border border-sep bg-surface shadow-sm">{callRow}</div>;

  // Minimized: floating pill above EVERY page — the session lives in the app
  // shell (VoiceCallProvider), so browsing tabs never hangs up.
  if (hidden) return null;
  // With a chat card on the page the call ALWAYS lives in it: no expand
  // button, no Minimize — a swipe up on the card is how it opens (Kiron,
  // 2026-09-25). The full-screen view below is only for a page with no dock.
  if (minimized || slot)
    return slot ? (
      createPortal(<div data-testid="call-row">{callRow}</div>, slot)
    ) : (
      <div className="fixed inset-x-2 bottom-3 z-50 mx-auto max-w-md">{dockBar}</div>
    );

  // A control: the 58px circle with its 12px label; the whole column is the
  // target, so the label taps too.
  const control =
    "flex flex-col items-center gap-1.5 text-[12px] text-faint";
  const circle = "grid h-[58px] w-[58px] place-items-center rounded-full transition-colors";

  return (
    // data-theme="dark" re-tokens this subtree: the call is the dark palette
    // in both themes, so bg-surface-2, text-faint, bg-danger and bg-accent
    // here are the dark iOS values whatever the page behind is. font-sans is
    // the system face the mockup is set in.
    <div
      data-theme="dark"
      className="fixed inset-0 z-50 flex flex-col bg-black font-sans text-ink"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ boxShadow: GLOW }} />

      {/* The top: minimize at the left, "⋯" at the right, both 44px, both
          quiet. The mockup's frame has nothing else up here. */}
      <div
        className="relative flex items-center justify-between px-2"
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        {/* A labelled button, not a bare caret: "it's really hard to find that
            little tiny caret" (Kiron, 2026-09-24). */}
        <button
          onClick={() => setMinimized(true)}
          title="Minimize call"
          aria-label="Minimize call"
          className="ml-1 mt-1 flex min-h-11 items-center gap-1.5 rounded-full bg-surface-2 pl-3 pr-4 text-[15px] font-semibold text-ink transition-opacity active:opacity-70"
        >
          <ChevronDown size={20} strokeWidth={2} />
          Minimize
        </button>
        <button
          onClick={() => setMenuOpen((o) => !o)}
          title="Voice, thinking depth and model"
          aria-label="Voice, thinking depth and model"
          aria-expanded={menuOpen}
          className={`flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
            menuOpen ? "bg-surface-2 text-ink" : "text-faint hover:text-ink"
          }`}
        >
          <Ellipsis size={24} strokeWidth={1.8} />
        </button>
      </div>

      {menuOpen && (
        <>
          <div aria-hidden className="absolute inset-0 z-10" onClick={() => setMenuOpen(false)} />
          <div
            role="group"
            aria-label="Call settings"
            className="ios-group absolute right-3 z-20 w-72 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-2xl bg-surface shadow-lg"
            style={{ top: "calc(env(safe-area-inset-top, 0px) + 3.25rem)" }}
          >
            {/* Each row stacks its label over a full-width select: a native
                select never wraps its chosen option, so beside the label at
                17px "GPT Realtime Mini (faster/cheaper)" would be cut. */}
            <label className={SELECT_ROW}>
              Voice
              <select
                value={voice}
                onChange={(e) => pickVoice(e.target.value)}
                className={SELECT}
              >
                {VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
                {elAvailable && <option value="elevenlabs">sassy (ElevenLabs beta)</option>}
              </select>
            </label>
            <label className={SELECT_ROW} title="Thinking depth — deeper pauses longer before speaking">
              Thinking
              <select
                value={effort}
                onChange={(e) => pickEffort(e.target.value)}
                aria-label="Thinking depth"
                className={SELECT}
              >
                {VOICE_EFFORTS.map((ef) => (
                  <option key={ef.id} value={ef.id}>
                    {ef.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={SELECT_ROW}>
              Model
              <select
                value={model}
                onChange={(e) => pickModel(e.target.value)}
                className={SELECT}
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => {
                // Canvas tab + pill: same destination as auto-open, by hand.
                setMenuOpen(false);
                setMinimized(true);
                router.push("/canvas");
              }}
              className="flex min-h-11 w-full items-center px-4 text-left text-[17px] text-accent"
            >
              Open the canvas
            </button>
          </div>
        </>
      )}

      {/* Card toasts: what she just logged, top of the screen, out of the way */}
      <div
        className="pointer-events-none absolute inset-x-6 z-[5] flex flex-col gap-2"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 3.5rem)" }}
      >
        {session.toasts.map((t) => (
          <div
            key={t.key}
            className="animate-toast-in flex items-start gap-1.5 rounded-xl bg-surface px-3 py-2 text-[13px] leading-[1.3] shadow-lg"
          >
            <span className="mt-[1px] flex-none">
              <ToastIcon glyph={t.icon} />
            </span>
            {t.text}
          </div>
        ))}
      </div>

      {/* Error states (W7) */}
      {session.status === "error" && session.error ? (
        <div className="relative flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <span className={`${circle} bg-surface-2 text-ink`}>
            {session.error.kind === "mic-denied" ? (
              <Mic size={26} strokeWidth={1.8} />
            ) : session.error.kind === "quota" ? (
              <Hourglass size={26} strokeWidth={1.8} />
            ) : session.error.kind === "disabled" ? (
              <Wrench size={26} strokeWidth={1.8} />
            ) : (
              <TriangleAlert size={26} strokeWidth={1.8} className="text-warn" />
            )}
          </span>
          <h2 className="text-balance text-[22px] font-bold leading-[1.25] tracking-[-0.005em]">
            {session.error.kind === "mic-denied"
              ? "Mic access needed"
              : session.error.kind === "quota"
                ? "Voice limit reached"
                : session.error.kind === "disabled"
                  ? "Voice is taking a break"
                  : "Call dropped"}
          </h2>
          <p className="max-w-sm text-[17px] leading-[1.4] text-faint">{session.error.message}</p>
          <div className="flex gap-2 pt-1">
            {session.error.kind === "network" && (
              <button
                onClick={retry}
                className="min-h-11 rounded-full bg-accent px-5 text-[16px] font-semibold text-white"
              >
                Try again
              </button>
            )}
            <button
              onClick={() => onClose(null)}
              className="min-h-11 rounded-full bg-surface-2 px-5 text-[16px] font-semibold text-ink"
            >
              Continue in text
            </button>
          </div>
        </div>
      ) : (
        // The talk screen: everything sits at the bottom, 24px in from the
        // sides, 22px apart, the way the mockup draws it.
        <div
          className="relative flex min-h-0 flex-1 flex-col justify-end gap-[22px] px-6"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 24px)" }}
        >
          <>
            {lastUser && <p className={YOU_TYPE}>{lastUser.text}</p>}
            {pendingHint ? (
              <p className={`${REPLY_TYPE} text-faint`} aria-live="polite">
                {pendingHint}
              </p>
            ) : lastReply ? (
              <div className="flex flex-col gap-1">
                <p className={REPLY_TYPE}>{lastReply.text}</p>
                {/* "Say it again" and copy, the same row every reply carries. */}
                <MessageActions id={`call-${lastReply.id}`} text={lastReply.text} voice={voice} className="-ml-2" />
              </div>
            ) : null}
          </>
          {micSilent && (
            <p className="text-[13px] leading-[1.4] text-warn">
              I can&apos;t hear anything from your mic. Try speaking louder, or end the call and
              start it again; iPhones sometimes hand over a dead microphone.
            </p>
          )}

          <Waveform active={session.assistantSpeaking} className="mx-auto" />

          <div className="flex justify-center gap-11 pt-1.5">
            <LiveMicButton
              muted={session.muted}
              onToggle={session.toggleMute}
              getLevels={session.getLevels}
              size={66}
              withLabel
            />
            <button onClick={endCall} title="End call" aria-label="End call" className={control}>
              <span className={`${circle} bg-danger text-white`}>
                <XGlyph />
              </span>
              End
            </button>
          </div>
        </div>
      )}

      {debugOn && (
        <pre
          onClick={() => void navigator.clipboard?.writeText(debugJson).catch(() => {})}
          className="relative max-h-48 overflow-y-auto border-t border-warn/40 bg-black/70 px-2 py-1 text-[9px] leading-tight text-warn"
          title="Tap to copy"
        >
          {debugJson || "collecting…"}
        </pre>
      )}
    </div>
  );
}
