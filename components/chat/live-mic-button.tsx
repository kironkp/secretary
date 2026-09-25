"use client";

// The call's mute button, the same everywhere the call shows one (the
// full-screen call and its minimized pill). Kiron, 2026-09-24: live, it is
// blue and a size up and it jumps with your voice, the way Gemini's does;
// muted, it is grey, a little smaller, and still. So a glance says whether
// the call can hear you: if it moves when you talk, it can.
//
// The level is the MIC's (your voice, not hers), from WebRTC stats — never a
// Web Audio analyser on the mic, which on iOS can silence the call's sender
// (voice-mode.tsx says the same).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

type Levels = { mic: number | null; remote: number | null };

/** How often the mic level is read; the transform eases between reads. */
const LEVEL_MS = 70;

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

function MicIcon({ muted, size }: { muted: boolean; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="8.5" y="3" width="7" height="12" rx="3.5" />
      <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21" />
      {muted && <path d="M4 4l16 16" strokeWidth="2.1" />}
    </svg>
  );
}

export function LiveMicButton({
  muted,
  onToggle,
  getLevels,
  size,
  withLabel = false,
}: {
  muted: boolean;
  onToggle: () => void;
  getLevels: () => Promise<Levels>;
  /** Diameter in px when live; muted is a step smaller. */
  size: number;
  /** The call screen's caption under the circle ("Mute" / "Unmute"). */
  withLabel?: boolean;
}) {
  const reduce = useReducedMotion();
  const [level, setLevel] = useState(0);
  // getLevels is a fresh function each render of the session; read the
  // latest through a ref rather than restarting the poll.
  const read = useRef(getLevels);
  useEffect(() => {
    read.current = getLevels;
  });
  useEffect(() => {
    if (muted) return;
    let stop = false;
    const iv = setInterval(async () => {
      const l = await read.current().catch(() => null);
      if (stop || !l) return;
      // Speech sits around 0.02–0.3; the square root lifts the quiet end so
      // an ordinary voice visibly moves the button, and a floor keeps room
      // noise from making it twitch.
      const raw = Math.max(0, (l.mic ?? 0) - 0.004);
      setLevel(Math.min(1, Math.sqrt(raw) * 1.7));
    }, LEVEL_MS);
    return () => {
      stop = true;
      clearInterval(iv);
      setLevel(0);
    };
  }, [muted]);

  const live = !muted;
  const lvl = live ? level : 0;
  // Live: full size, plus a jump with the voice (up and a little larger).
  // Muted: a step down, and nothing moves.
  const scale = live ? (reduce ? 1 : 1 + lvl * 0.16) : 0.84;
  const lift = live && !reduce ? -lvl * size * 0.08 : 0;
  // Reduced motion keeps the signal without the movement: a halo that
  // brightens with the voice.
  const halo = live
    ? `0 0 0 ${Math.round(2 + lvl * (reduce ? 10 : 6))}px color-mix(in srgb, var(--accent) ${Math.round(
        22 + lvl * 40
      )}%, transparent)`
    : "none";

  const circle = (
    <span
      className={`grid place-items-center rounded-full ${live ? "bg-accent text-white" : "bg-surface-2 text-faint"}`}
      style={{
        width: size,
        height: size,
        transform: `translateY(${lift.toFixed(1)}px) scale(${scale.toFixed(3)})`,
        boxShadow: halo,
        transition: reduce
          ? "background-color 200ms ease, color 200ms ease"
          : `transform ${LEVEL_MS + 40}ms cubic-bezier(0.22, 0.9, 0.32, 1), box-shadow ${LEVEL_MS + 40}ms ease, background-color 200ms ease, color 200ms ease`,
      }}
    >
      <MicIcon muted={muted} size={Math.round(size * 0.42)} />
    </span>
  );

  return (
    <button
      type="button"
      onClick={onToggle}
      title={muted ? "Unmute" : "Mute"}
      aria-label={muted ? "Unmute" : "Mute"}
      aria-pressed={muted}
      data-testid="live-mic"
      data-live={live || undefined}
      className={withLabel ? "flex flex-col items-center gap-1.5 text-[12px] text-faint" : "flex-none"}
    >
      {circle}
      {withLabel && (muted ? "Muted" : "Live")}
    </button>
  );
}
