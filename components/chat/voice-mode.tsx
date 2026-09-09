"use client";

// Full-screen live voice mode (W3): orb driven by real audio levels, model
// dropdown, mute / transcript / end controls, card toasts, W7 error states.
//
// IMPORTANT (iOS): never attach a Web Audio AnalyserNode to the mic stream
// while the WebRTC call is live — on iOS Safari that re-routes the audio
// session and can silence the outbound track (dictation is unaffected because
// it has no WebRTC). Levels come from RTCPeerConnection.getStats() instead.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlignLeft,
  ArrowRight,
  Bookmark,
  Calendar,
  Check,
  ChevronDown,
  FolderPlus,
  Hourglass,
  Maximize2,
  Mic,
  MicOff,
  Paintbrush,
  Pencil,
  PhoneOff,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import {
  playRemoteStream,
  stopRemoteAudio,
  unlockRemoteAudio,
} from "@/lib/realtime/remote-audio";
import { requestCanvasRefresh } from "@/lib/canvas/refresh";
import { useVoiceSession, type TranscriptLine } from "./use-voice-session";
import { Button } from "@/components/ui";

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

export function VoiceMode({
  session,
  onClose,
  defaultVoice = "marin",
  defaultEffort = "auto",
  startMinimized = false,
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
  /** Live transcript stream — lets the chat thread render voice lines as
   *  messages while the call is running (one conversation, not two worlds). */
  onTranscript?: (lines: TranscriptLine[]) => void;
}) {
  const router = useRouter();

  useEffect(() => {
    onTranscript?.(session.transcript);
  }, [session.transcript, onTranscript]);
  const [showTranscript, setShowTranscript] = useState(false);
  // Live transcript follows the conversation — but only when already pinned
  // near the bottom, so scrolling up to reread isn't fought.
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [session.transcript]);
  // Mobile lifeline: shrink the overlay to a floating pill — the page behind
  // becomes usable while the call (owned by the app shell) keeps running.
  const [minimized, setMinimized] = useState(startMinimized);

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

  // Poll WebRTC stats for levels; run the dead-mic watchdog off the same data.
  // The mic warning only arms when the browser actually reports an outbound
  // audio level — no false alarms where stats are unsupported.
  const [levels, setLevels] = useState({ mic: 0, remote: 0 });
  const [micSilent, setMicSilent] = useState(false);
  const watchRef = useRef({ muted: false, transcriptLen: 0, speaking: false });
  useEffect(() => {
    watchRef.current = {
      muted: session.muted,
      transcriptLen: session.transcript.length,
      speaking: session.assistantSpeaking,
    };
  }, [session.muted, session.transcript.length, session.assistantSpeaking]);
  useEffect(() => {
    if (!connected) return;
    let silentSince: number | null = null;
    const iv = setInterval(async () => {
      const l = await session.getLevels();
      const w = watchRef.current;
      // if the browser doesn't report a remote level, breathe with speech events
      const remote =
        l.remote ?? (w.speaking ? 0.14 + 0.1 * Math.abs(Math.sin(Date.now() / 160)) : 0);
      setLevels((prev) => ({
        mic: prev.mic * 0.6 + (l.mic ?? 0) * 0.4,
        remote: prev.remote * 0.6 + remote * 0.4,
      }));
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
  const micLevel = levels.mic;
  const remoteLevel = levels.remote;

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
      session.start(model, voice, effort);
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

  const orbScale = 1 + Math.min(remoteLevel * 1.4, 0.35);
  const rippleScale = 1 + Math.min(micLevel * 2.2, 0.6);

  const statusHint =
    session.status === "requesting-mic"
      ? "Allow microphone access…"
      : session.status === "connecting"
        ? "Connecting…"
        : session.status === "reconnecting"
          ? switching
            ? "Switching model…"
            : "Reconnecting — hold on, your conversation is safe."
          : session.assistantSpeaking
            ? "Speaking…"
            : connected
              ? "Listening…"
              : "";

  const lastToast = session.toasts[session.toasts.length - 1];
  const dockBar = (
    <div className="rounded-2xl border border-accent/40 bg-surface shadow-sm">
        {debugOn && (
          <pre
            onClick={() => void navigator.clipboard?.writeText(debugJson).catch(() => {})}
            className="max-h-32 overflow-y-auto border-b border-warn/40 bg-black/70 px-2 py-1 text-[9px] leading-tight text-warn"
            title="Tap to copy"
          >
            {debugJson || "collecting…"}
          </pre>
        )}
        <div className="flex items-center gap-3 px-3 py-2.5">
          {session.status === "error" && session.error ? (
            <>
              <TriangleAlert size={18} strokeWidth={1.75} className="flex-none text-warn" />
              <p className="min-w-0 flex-1 truncate text-sm text-muted">{session.error.message}</p>
              {session.error.kind === "network" && (
                <button
                  onClick={() => {
                    unlockRemoteAudio();
                    session.start(model, voice);
                  }}
                  className="rounded-full bg-accent px-3 py-1.5 text-xs font-bold text-bg"
                >
                  Try again
                </button>
              )}
              <button
                onClick={() => onClose(null)}
                className="rounded-full border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink"
              >
                Close
              </button>
            </>
          ) : (
            <>
              <div className="relative h-12 w-12 flex-none">
                <div
                  className="absolute inset-0 rounded-full border-2 border-accent/30 transition-transform duration-75"
                  style={{ transform: `scale(${1 + Math.min(micLevel * 2.2, 0.35)})` }}
                />
                <div
                  className="absolute inset-1 rounded-full transition-transform duration-75"
                  style={{
                    transform: `scale(${1 + Math.min(remoteLevel * 1.4, 0.25)})`,
                    background:
                      "radial-gradient(circle at 35% 35%, #8fb0ff, #3d5bd9 60%, #22307a)",
                    boxShadow: `0 0 ${10 + remoteLevel * 40}px rgba(122,162,255,${0.3 + remoteLevel * 0.4})`,
                    animation:
                      connected && !session.assistantSpeaking
                        ? "breathe 3s ease-in-out infinite"
                        : undefined,
                  }}
                />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{statusHint || "On a call"}</p>
                {lastToast ? (
                  <p className="flex items-center gap-1.5 truncate text-xs text-faint">
                    <ToastIcon glyph={lastToast.icon} />
                    <span className="truncate">{lastToast.text}</span>
                  </p>
                ) : micSilent ? (
                  <p className="truncate text-xs text-warn">
                    Can&apos;t hear you — try ending and restarting the call.
                  </p>
                ) : (
                  <p className="truncate text-xs text-faint">
                    Watch tasks land on the dashboard as you talk →
                  </p>
                )}
              </div>
              <select
                value={voice}
                onChange={(e) => pickVoice(e.target.value)}
                title="Voice"
                aria-label="Voice"
                className="w-20 flex-none rounded-full border border-edge bg-card px-2 py-1.5 text-xs text-muted outline-none focus:border-accent"
              >
                {VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
                {elAvailable && <option value="elevenlabs">sassy (EL)</option>}
              </select>
              <button
                onClick={() => setMinimized(false)}
                title="Back to full screen"
                aria-label="Back to full screen"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-edge bg-card text-ink hover:border-faint"
              >
                <Maximize2 size={15} strokeWidth={1.75} />
              </button>
              <button
                onClick={session.toggleMute}
                title={session.muted ? "Unmute" : "Mute"}
                aria-label={session.muted ? "Unmute" : "Mute"}
                className={`flex h-9 w-9 flex-none items-center justify-center rounded-full border transition-colors ${
                  session.muted
                    ? "border-warn bg-warn/20 text-warn"
                    : "border-edge bg-card text-ink hover:border-faint"
                }`}
              >
                {session.muted ? (
                  <MicOff size={15} strokeWidth={1.75} />
                ) : (
                  <Mic size={15} strokeWidth={1.75} />
                )}
              </button>
              <button
                onClick={endCall}
                title="End call"
                aria-label="End call"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-danger/50 bg-danger/15 text-danger transition-colors hover:bg-danger/25"
              >
                <PhoneOff size={15} strokeWidth={1.75} />
              </button>
            </>
          )}
        </div>
      </div>
  );

  // Minimized: floating pill above EVERY page — the session lives in the app
  // shell (VoiceCallProvider), so browsing tabs never hangs up.
  if (minimized)
    return <div className="fixed inset-x-2 bottom-3 z-50 mx-auto max-w-md">{dockBar}</div>;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg">
      {/* min-w-0 + shrinking selects: this row must NEVER exceed the viewport —
          overflow here widens the mobile layout viewport and pushes the call
          controls off-screen (the 3:24 iPhone screenshot). */}
      <div className="flex items-center justify-between gap-2 p-4">
        <span className="flex-none text-sm font-bold text-accent">Secretary</span>
        <div className="flex min-w-0 items-center gap-2">
          <select
            value={voice}
            onChange={(e) => pickVoice(e.target.value)}
            title="Voice"
            className="min-w-0 max-w-[6.5rem] shrink rounded-full border border-edge bg-card px-3 py-1.5 text-xs text-muted outline-none focus:border-accent"
          >
            {VOICES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
            {elAvailable && <option value="elevenlabs">sassy (ElevenLabs beta)</option>}
          </select>
          <select
            value={effort}
            onChange={(e) => pickEffort(e.target.value)}
            title="Thinking depth — deeper pauses longer before speaking"
            aria-label="Thinking depth"
            className="min-w-0 max-w-[7rem] shrink rounded-full border border-edge bg-card px-3 py-1.5 text-xs text-muted outline-none focus:border-accent"
          >
            {VOICE_EFFORTS.map((ef) => (
              <option key={ef.id} value={ef.id}>
                {ef.label}
              </option>
            ))}
          </select>
          <select
            value={model}
            onChange={(e) => pickModel(e.target.value)}
            className="min-w-0 max-w-[9rem] shrink rounded-full border border-edge bg-card px-3 py-1.5 text-xs text-muted outline-none focus:border-accent"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setMinimized(true)}
            title="Minimize call"
            aria-label="Minimize call"
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-edge bg-card text-muted transition-colors hover:text-ink"
          >
            <ChevronDown size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Error states (W7) */}
      {session.status === "error" && session.error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-2 text-muted">
            {session.error.kind === "mic-denied" ? (
              <Mic size={28} strokeWidth={1.75} />
            ) : session.error.kind === "quota" ? (
              <Hourglass size={28} strokeWidth={1.75} />
            ) : session.error.kind === "disabled" ? (
              <Wrench size={28} strokeWidth={1.75} />
            ) : (
              <TriangleAlert size={28} strokeWidth={1.75} className="text-warn" />
            )}
          </span>
          <h2 className="text-lg font-bold">
            {session.error.kind === "mic-denied"
              ? "Mic access needed"
              : session.error.kind === "quota"
                ? "Voice limit reached"
                : session.error.kind === "disabled"
                  ? "Voice is taking a break"
                  : "Call dropped"}
          </h2>
          <p className="max-w-sm text-sm text-muted">{session.error.message}</p>
          <div className="flex gap-2">
            {session.error.kind === "network" && (
              <Button
                onClick={() => {
                  unlockRemoteAudio();
                  session.start(model, voice);
                }}
              >
                Try again
              </Button>
            )}
            <Button variant="secondary" onClick={() => onClose(null)}>
              Continue in text
            </Button>
          </div>
        </div>
      ) : (
        <div className="relative flex flex-1 flex-col items-center justify-center gap-6">
          {/* Orb: ripple ring = your voice; core = assistant */}
          <div className="relative flex items-center justify-center">
            <div
              className="absolute h-44 w-44 rounded-full border-2 border-accent/30 transition-transform duration-75"
              style={{ transform: `scale(${rippleScale})` }}
            />
            <div
              className="h-36 w-36 rounded-full transition-transform duration-75"
              style={{
                transform: `scale(${orbScale})`,
                background:
                  "radial-gradient(circle at 35% 35%, #8fb0ff, #3d5bd9 60%, #22307a)",
                boxShadow: `0 0 ${40 + remoteLevel * 120}px rgba(122,162,255,${0.35 + remoteLevel * 0.4})`,
                animation: connected && !session.assistantSpeaking ? "breathe 3s ease-in-out infinite" : undefined,
              }}
            />
          </div>
          <p className="text-sm text-muted">{statusHint}</p>
          {micSilent && (
            <p className="max-w-xs rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-center text-xs text-warn">
              I can&apos;t hear anything from your mic. Try speaking louder — or end the call and
              start it again; iPhones sometimes hand over a dead microphone.
            </p>
          )}

          {/* Card toasts */}
          <div className="pointer-events-none absolute right-4 top-4 flex w-64 flex-col gap-2">
            {session.toasts.map((t) => (
              <div
                key={t.key}
                className="animate-toast-in flex items-start gap-1.5 rounded-lg border border-edge bg-card px-3 py-2 text-xs shadow-lg"
              >
                <span className="translate-y-[1px] flex-none">
                  <ToastIcon glyph={t.icon} />
                </span>
                {t.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {debugOn && (
        <pre
          onClick={() => void navigator.clipboard?.writeText(debugJson).catch(() => {})}
          className="max-h-48 overflow-y-auto border-t border-warn/40 bg-black/70 px-2 py-1 text-[9px] leading-tight text-warn"
          title="Tap to copy"
        >
          {debugJson || "collecting…"}
        </pre>
      )}

      {/* Transcript panel */}
      {showTranscript && (
        <div
          ref={transcriptRef}
          className="max-h-56 overflow-y-auto border-t border-edge bg-surface px-4 py-3 text-sm"
        >
          {session.transcript.length === 0 && (
            <p className="text-xs text-faint">Transcript will appear here.</p>
          )}
          {session.transcript.map((line, i) => (
            <p key={i} className={`mb-1.5 ${line.role === "user" ? "text-ink" : "text-muted"}`}>
              <span className="mr-2 text-[10px] uppercase text-faint">
                {line.role === "user" ? "You" : "Sec"}
              </span>
              {line.text}
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center justify-center gap-6 p-6">
        <button
          onClick={session.toggleMute}
          title={session.muted ? "Unmute" : "Mute"}
          aria-label={session.muted ? "Unmute" : "Mute"}
          className={`flex h-12 w-12 items-center justify-center rounded-full border transition-colors ${
            session.muted
              ? "border-warn bg-warn/20 text-warn"
              : "border-edge bg-card text-ink hover:border-faint"
          }`}
        >
          {session.muted ? <MicOff size={18} strokeWidth={1.75} /> : <Mic size={18} strokeWidth={1.75} />}
        </button>
        <button
          onClick={() => setShowTranscript((s) => !s)}
          title="Live transcript"
          aria-label="Live transcript"
          className={`flex h-12 w-12 items-center justify-center rounded-full border transition-colors ${
            showTranscript
              ? "border-accent bg-accent/20 text-accent"
              : "border-edge bg-card text-ink hover:border-faint"
          }`}
        >
          <AlignLeft size={18} strokeWidth={1.75} />
        </button>
        <button
          onClick={() => {
            // Canvas tab + pill: same destination as auto-open, by hand.
            setMinimized(true);
            router.push("/canvas");
          }}
          title="Open the canvas (call keeps going)"
          aria-label="Open the canvas"
          className="flex h-12 w-12 items-center justify-center rounded-full border border-edge bg-card text-ink transition-colors hover:border-faint"
        >
          <Paintbrush size={18} strokeWidth={1.75} />
        </button>
        <button
          onClick={endCall}
          title="End call"
          aria-label="End call"
          className="flex h-12 w-12 items-center justify-center rounded-full border border-danger/50 bg-danger/15 text-danger transition-colors hover:bg-danger/25"
        >
          <PhoneOff size={18} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}
