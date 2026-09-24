"use client";

// The orb at the bottom of the Interview tab (the user's words: "a little orb
// at the bottom that you can tap and then it becomes OpenAI real time
// interviewing you, and then it should pause in between questions because
// it's thinking and parsing data").
//
// It is not a second voice system. A tap begins the app's one call
// (VoiceCallProvider) in the "interview" flavor: the same session, persona,
// briefing and tools; the token route adds the interview block
// (lib/secretary/interview-voice.ts) and answer_question hands back the next
// question. An answer lands through the same path as a tapped pill, and the
// call announces it as "secretary:data-changed", which the Interview view
// already refetches on, so the card moves on as the voice does: one state.
//
// While it is on this page the orb IS the call's UI (it claims the call; the
// floating pill draws nothing). Leave the page mid-call and the call carries
// on in the ordinary pill. A call that is not an interview is left to its own
// UI, and the orb steps aside.
//
// States: idle, a calm accent orb with a mic; live, it breathes with the
// louder of the two voices (WebRTC stats, never Web Audio on the mic: see
// components/chat/voice-mode.tsx); thinking, while a tool call is in flight,
// a slow ring turns round it and the breathing settles. Reduced motion: no
// scaling and no turning; the level shows as the halo's strength instead.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { unlockRemoteAudio } from "@/lib/realtime/remote-audio";
import { useVoiceCall } from "@/components/chat/voice-call-provider";

/** How often the level is read while live. The transform eases between reads. */
const LEVEL_MS = 90;
/** The orb, and the room kept for it at the end of the page. */
const ORB_PX = 56;

const REDUCED = "(prefers-reduced-motion: reduce)";
function subscribeReduced(onChange: () => void) {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCED).matches,
    () => false
  );
}

function MicGlyph() {
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
      <rect x="8.5" y="3" width="7" height="12" rx="3.5" />
      <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21" />
    </svg>
  );
}

/** The preferred voice and thinking depth, the same everywhere (Settings, the call's menu). */
type VoicePrefs = { voice?: string; voiceEffort?: string };

export function InterviewOrb() {
  const call = useVoiceCall();
  const { session } = call;
  const mine = call.active && call.flavor === "interview";
  const reduced = useReducedMotion();

  // Fetched once, so the tap itself starts the call inside the gesture
  // (iOS unlocks audio only there). Until it lands the call uses the defaults.
  const [prefs, setPrefs] = useState<VoicePrefs>({});
  useEffect(() => {
    let live = true;
    fetch("/api/persona", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<VoicePrefs>) : {}))
      .then((p) => live && setPrefs(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // The orb is the call's UI while it is on screen.
  const { hostCall } = call;
  useEffect(() => (mine ? hostCall() : undefined), [mine, hostCall]);

  // The louder of the two voices, 0..1, read from WebRTC stats.
  const connected = mine && session.status === "connected";
  const [level, setLevel] = useState(0);
  // getLevels is a fresh function on every render of the session; the poll
  // reads the latest through a ref instead of restarting on each one.
  const levels = useRef(session.getLevels);
  useEffect(() => {
    levels.current = session.getLevels;
  });
  useEffect(() => {
    if (!connected) return;
    let stop = false;
    const iv = setInterval(async () => {
      const l = await levels.current();
      if (stop) return;
      const raw = Math.max(l.mic ?? 0, l.remote ?? 0);
      // Speech sits around 0.02–0.3; the square root lifts the quiet end so
      // an ordinary voice visibly moves the orb.
      setLevel(Math.min(1, Math.sqrt(raw) * 1.5));
    }, LEVEL_MS);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [connected]);

  // Another kind of call is live: its pill is the UI, and one call at a time.
  if (call.active && !mine) return null;

  const thinking = connected && session.thinking;
  const error = mine && session.status === "error" ? session.error : null;
  const pending =
    mine && (session.status === "requesting-mic" || session.status === "connecting" || session.status === "reconnecting");

  const caption = !mine
    ? "Answer out loud"
    : error
      ? error.message
      : session.status === "requesting-mic"
        ? "Allow the microphone"
        : session.status === "connecting"
          ? "Connecting…"
          : session.status === "reconnecting"
            ? "Reconnecting…"
            : thinking
              ? "Thinking…"
              : session.assistantSpeaking
                ? "Speaking · tap to end"
                : "Listening · tap to end";

  const onTap = () => {
    if (mine) {
      void call.end();
      return;
    }
    unlockRemoteAudio();
    call.begin({
      flavor: "interview",
      minimized: true,
      voice: prefs.voice,
      effort: prefs.voiceEffort,
    });
  };

  const state: OrbState = !mine
    ? "idle"
    : error
      ? "error"
      : pending || !connected
        ? "connecting"
        : thinking
          ? "thinking"
          : "live";
  return <OrbView state={state} level={level} caption={caption} reduced={reduced} onTap={onTap} />;
}

export type OrbState = "idle" | "connecting" | "live" | "thinking" | "error";

/**
 * The orb as drawn, from its state alone: the call wiring is above, so the
 * states can be looked at without a call.
 */
export function OrbView({
  state,
  level,
  caption,
  reduced,
  onTap,
}: {
  state: OrbState;
  /** The louder voice, 0..1; read only while live. */
  level: number;
  caption: string;
  reduced: boolean;
  onTap: () => void;
}) {
  const mine = state !== "idle";
  const thinking = state === "thinking";
  const pending = state === "connecting";
  const error = state === "error";
  const connected = state === "live" || thinking;
  // Breathing: the body scales with the level; thinking settles it to a
  // slow constant. The halo carries the level on its own under reduced motion.
  const live = state === "live";
  const scale = reduced || !live ? 1 : 1 + 0.2 * level;
  const halo = connected ? (thinking ? 0.35 : 0.25 + 0.6 * level) : mine ? 0.3 : 0.22;

  return (
    <>
      {/* The room the orb needs at the end of the page, so scrolled to the
          bottom nothing sits under it: the last line and the pills clear it. */}
      <div aria-hidden style={{ height: ORB_PX + 36 }} />
      <div
        data-interview-orb
        data-state={state}
        className="pointer-events-none fixed inset-x-0 z-40 flex flex-col items-center gap-1.5"
        style={{ bottom: "calc(var(--dock-h, 6rem) + 10px)" }}
      >
        <style>{ORB_KEYFRAMES}</style>
        <button
          type="button"
          onClick={onTap}
          aria-label={mine ? "End the spoken interview" : "Answer these questions out loud"}
          aria-pressed={mine}
          className="pointer-events-auto relative grid place-items-center rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          style={{ width: ORB_PX, height: ORB_PX }}
        >
          {/* The halo: the accent's glow, stronger with the voice. */}
          <span
            aria-hidden
            className="absolute inset-[-10px] rounded-full"
            style={{
              background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 55%, transparent) 0%, transparent 70%)",
              opacity: halo,
              transition: "opacity 180ms linear",
            }}
          />
          {/* Thinking: a thin arc turning slowly round the orb. */}
          {thinking && (
            <span
              aria-hidden
              className="absolute inset-[-5px] rounded-full"
              style={{
                background: "conic-gradient(from 0deg, transparent 0 62%, var(--accent) 88%, transparent 100%)",
                WebkitMask: "radial-gradient(circle, transparent 0 calc(50% - 2px), #000 calc(50% - 2px))",
                mask: "radial-gradient(circle, transparent 0 calc(50% - 2px), #000 calc(50% - 2px))",
                animation: reduced ? undefined : "orb-turn 1.6s linear infinite",
              }}
            />
          )}
          {/* The body. */}
          <span
            aria-hidden
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "radial-gradient(circle at 34% 28%, color-mix(in srgb, var(--accent) 55%, white) 0%, var(--accent) 52%, color-mix(in srgb, var(--accent) 72%, black) 100%)",
              boxShadow: "0 6px 18px color-mix(in srgb, var(--accent) 38%, transparent)",
              transform: `scale(${scale.toFixed(3)})`,
              transition: "transform 120ms linear",
              animation:
                reduced || !(pending || thinking)
                  ? undefined
                  : `orb-breathe ${thinking ? "2.4s" : "1.2s"} cubic-bezier(0.45, 0, 0.55, 1) infinite alternate`,
            }}
          />
          <span className="relative">
            {mine && !error && !pending ? (
              // Live: the glyph gives way to a small square, the way to stop.
              <span aria-hidden className="block h-3.5 w-3.5 rounded-[3px] bg-white/90" />
            ) : (
              <MicGlyph />
            )}
          </span>
        </button>
        <p
          aria-live="polite"
          className={`max-w-[18rem] px-3 text-center text-[12px] font-medium leading-[1.3] wrap-anywhere ${
            error ? "text-warn" : "text-faint"
          }`}
        >
          {caption}
        </p>
      </div>
    </>
  );
}

const ORB_KEYFRAMES =
  "@keyframes orb-turn{to{transform:rotate(1turn)}}" +
  "@keyframes orb-breathe{from{opacity:.82}to{opacity:1}}";
