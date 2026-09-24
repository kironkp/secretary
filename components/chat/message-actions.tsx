"use client";

// Copy and speak, under every reply (SPEC §7.7). Speak reads the reply aloud
// in the user's voice through /api/speak; tapping it again stops. One reply
// plays at a time, app-wide.
//
// iOS lets an <audio> element play audibly only from a gesture, and the audio
// arrives after a fetch, when the gesture is spent. So the tap plays a beat of
// silence on the shared element first (that unlocks it), and the real audio is
// swapped in when it lands — the same trick the call uses (remote-audio.ts).
import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Copy, Loader2, Square, Volume2 } from "lucide-react";

const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQQAAAAAAA==";

// --- the one player -------------------------------------------------------
type PlayerState = { key: string | null; loading: boolean };
let state: PlayerState = { key: null, loading: false };
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let aborter: AbortController | null = null;

function set(next: PlayerState) {
  state = next;
  listeners.forEach((l) => l());
}

function element(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.setAttribute("playsinline", "");
    audio.onended = () => set({ key: null, loading: false });
  }
  return audio;
}

export function stopSpeaking() {
  aborter?.abort();
  aborter = null;
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  set({ key: null, loading: false });
}

/** MUST be called from the tap itself (see the note at the top). */
function speak(key: string, text: string, voice: string | undefined, onError: (m: string) => void) {
  stopSpeaking();
  const a = element();
  a.src = SILENT_WAV;
  void a.play().catch(() => {});
  set({ key, loading: true });
  const controller = new AbortController();
  aborter = controller;
  void (async () => {
    try {
      const res = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.slice(0, 4000), voice }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "Could not read that aloud.");
      const blob = await res.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      a.src = objectUrl;
      await a.play();
      set({ key, loading: false });
    } catch (e) {
      if (controller.signal.aborted) return;
      set({ key: null, loading: false });
      onError(e instanceof Error ? e.message : "Could not read that aloud.");
    }
  })();
}

function usePlayer(): PlayerState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state
  );
}

// --- the row ---------------------------------------------------------------
const BUTTON =
  "flex h-8 w-8 items-center justify-center rounded-full text-faint transition-colors hover:bg-surface-2 hover:text-ink active:opacity-60";

export function MessageActions({
  id,
  text,
  voice,
  className = "",
}: {
  /** Unique per reply, so the right row shows "playing". */
  id: string;
  text: string;
  voice?: string;
  className?: string;
}) {
  const player = usePlayer();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const playing = player.key === id;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className={`flex items-center gap-0.5 ${className}`}>
      <button
        type="button"
        title="Copy"
        aria-label="Copy this reply"
        className={BUTTON}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => setError("Couldn't copy."));
        }}
      >
        {copied ? <Check size={15} strokeWidth={2.25} /> : <Copy size={15} strokeWidth={1.9} />}
      </button>
      <button
        type="button"
        title={playing ? "Stop" : "Read aloud"}
        aria-label={playing ? "Stop reading aloud" : "Read this reply aloud"}
        aria-pressed={playing}
        className={`${BUTTON} ${playing ? "text-accent" : ""}`}
        onClick={() => {
          setError("");
          if (playing) stopSpeaking();
          else speak(id, text, voice, setError);
        }}
      >
        {playing && player.loading ? (
          <Loader2 size={15} strokeWidth={2} className="animate-spin" />
        ) : playing ? (
          <Square size={12} strokeWidth={0} fill="currentColor" />
        ) : (
          <Volume2 size={16} strokeWidth={1.9} />
        )}
      </button>
      {error && <span className="pl-1 text-[12px] text-danger">{error}</span>}
    </div>
  );
}
