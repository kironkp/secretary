// The one <audio> element that plays the assistant's voice. iOS Safari only
// lets an element start audible playback from a user gesture — so the Talk
// button "unlocks" this element synchronously in its click handler (playing a
// beat of silence), and the live call later swaps in the real remote stream on
// an element that's already allowed to play.

// A few samples of silence — a minimal valid mono 16-bit WAV.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQQAAAAAAA==";

let el: HTMLAudioElement | null = null;

export function getRemoteAudioElement(): HTMLAudioElement | null {
  if (typeof document === "undefined") return null;
  if (!el) {
    el = document.createElement("audio");
    el.autoplay = true;
    el.setAttribute("playsinline", "");
    el.style.display = "none";
    document.body.appendChild(el);
  }
  return el;
}

/** MUST be called synchronously from a user gesture (the Talk button tap). */
export function unlockRemoteAudio() {
  const a = getRemoteAudioElement();
  if (!a || a.srcObject) return;
  a.src = SILENT_WAV;
  a.muted = false;
  a.volume = 1;
  void a.play().catch(() => {
    /* even a rejected gesture-play records user activation on the element */
  });
}

/** Attach the live call's remote stream (idempotent) and keep it playing. */
export function playRemoteStream(stream: MediaStream) {
  const a = getRemoteAudioElement();
  if (!a) return;
  if (a.srcObject !== stream) {
    a.removeAttribute("src");
    a.srcObject = stream;
  }
  if (a.paused) void a.play().catch(() => {});
}

export function stopRemoteAudio() {
  const a = getRemoteAudioElement();
  if (!a) return;
  a.pause();
  a.srcObject = null;
  a.removeAttribute("src");
}

/** For the diagnostics beacon: is the voice actually playing? */
export function remoteAudioState() {
  const a = el;
  if (!a) return { exists: false as const };
  return {
    exists: true as const,
    paused: a.paused,
    muted: a.muted,
    volume: a.volume,
    readyState: a.readyState,
    hasStream: Boolean(a.srcObject),
  };
}
