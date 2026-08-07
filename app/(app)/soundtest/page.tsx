"use client";

// Audio diagnostics page: three buttons, three playback paths. If #1 works and
// #2 doesn't, the browser blocks non-gesture playback (the autoplay policy the
// voice feature has to work around). No auth, no external assets — the fart is
// synthesized right here and played from a data: URI.
import { useRef, useState } from "react";

function makeFartBytes(): ArrayBuffer {
  const rate = 8000;
  const dur = 1.1;
  const n = Math.floor(rate * dur);
  const samples = new Float32Array(n);
  let brown = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t * 50) * Math.pow(1 - t / dur, 1.3);
    const f = 100 - 60 * (t / dur); // pitch sags as it runs out of steam
    const flutter = 0.5 + 0.5 * Math.sin(2 * Math.PI * (14 + 9 * Math.sin(t * 2.7)) * t);
    const white = Math.random() * 2 - 1;
    brown = (brown + 0.02 * white) / 1.02;
    const tone = Math.sin(2 * Math.PI * f * t + 2.8 * Math.sin(2 * Math.PI * 33 * t));
    samples[i] = env * flutter * (0.6 * tone + 3.2 * brown);
  }
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  }
  return buf;
}

function toDataUri(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(bin);
}

type Result = { label: string; ok: boolean; detail: string };

export default function SoundTestPage() {
  const [results, setResults] = useState<Result[]>([]);
  const [waiting, setWaiting] = useState(false);
  const bytesRef = useRef<ArrayBuffer | null>(null);
  const wavRef = useRef<string | null>(null);
  const getBytes = () => (bytesRef.current ??= makeFartBytes());
  const getWav = () => (wavRef.current ??= toDataUri(getBytes()));

  const report = (label: string, ok: boolean, detail: string) =>
    setResults((r) => [{ label, ok, detail }, ...r].slice(0, 8));

  // Path 1: <audio> element, play() inside the tap — the voice feature's path
  // after the gesture-unlock fix. If this fails, sound on this site is broken.
  const playDirect = () => {
    const a = new Audio(getWav());
    a.play()
      .then(() => report("1 · Direct play", true, "Playing — you should hear it 💨"))
      .catch((e: Error) => report("1 · Direct play", false, `${e.name}: ${e.message}`));
  };

  // Path 2: same element, but play() fires 3s later from a timer — NO user
  // gesture in the call stack. This reproduces the original voice-mode bug;
  // Safari is expected to block this unless the site has autoplay permission.
  const playDelayed = () => {
    setWaiting(true);
    report("2 · Delayed play", true, "Waiting 3 seconds, then trying without a gesture…");
    setTimeout(() => {
      const a = new Audio(getWav());
      a.play()
        .then(() => report("2 · Delayed play", true, "Allowed — autoplay is permitted here"))
        .catch((e: Error) =>
          report(
            "2 · Delayed play",
            false,
            `Blocked (${e.name}) — this is the exact failure voice mode used to hit`
          )
        )
        .finally(() => setWaiting(false));
    }, 3000);
  };

  // Path 3: Web Audio API — the other audio machinery the app uses (dictation
  // waveform). Decodes the WAV bytes directly (no fetch — CSP blocks data: fetches).
  const playWebAudio = async () => {
    try {
      const ctx = new AudioContext();
      await ctx.resume();
      const decoded = await ctx.decodeAudioData(getBytes().slice(0));
      const src = ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(ctx.destination);
      src.onended = () => void ctx.close();
      src.start();
      report("3 · Web Audio", true, `Playing (context: ${ctx.state}) 💨`);
    } catch (e) {
      report("3 · Web Audio", false, e instanceof Error ? `${e.name}: ${e.message}` : "failed");
    }
  };

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 py-6">
      <h1 className="text-xl font-bold">💨 Sound test</h1>
      <p className="text-sm text-muted">
        Three ways of making noise, three verdicts. Turn your volume up. If #1 is silent, sound on
        this site doesn&apos;t work at all; if #1 plays but #2 is blocked, that&apos;s the autoplay
        policy the voice feature works around.
      </p>

      <button
        onClick={playDirect}
        className="rounded-xl bg-accent px-4 py-3.5 text-sm font-bold text-bg transition-opacity hover:opacity-90"
      >
        1 · Play fart now (tap-triggered, like voice mode)
      </button>
      <button
        onClick={playDelayed}
        disabled={waiting}
        className="rounded-xl border border-edge bg-surface px-4 py-3.5 text-sm font-bold text-ink transition-colors hover:border-faint disabled:opacity-50"
      >
        2 · Play fart in 3 seconds (no gesture — autoplay test)
      </button>
      <button
        onClick={playWebAudio}
        className="rounded-xl border border-edge bg-surface px-4 py-3.5 text-sm font-bold text-ink transition-colors hover:border-faint"
      >
        3 · Play fart via Web Audio API
      </button>

      {results.length > 0 && (
        <div className="mt-2 space-y-2">
          {results.map((r, i) => (
            <p
              key={`${r.label}-${i}`}
              className={`rounded-lg border px-3 py-2 text-xs ${
                r.ok ? "border-ok/40 bg-ok/10 text-ok" : "border-danger/40 bg-danger/10 text-danger"
              }`}
            >
              <span className="font-bold">{r.label}:</span> {r.detail}
            </p>
          ))}
        </div>
      )}
    </main>
  );
}
