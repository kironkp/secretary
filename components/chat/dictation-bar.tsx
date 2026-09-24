"use client";

// Dictation (W2): a live waveform that scrolls in from the right edge like a
// ticker tape, one bar per slice of real mic level (AnalyserNode RMS). Silence
// reads as a dotted line. X discards · Stop transcribes into the input ·
// Send transcribes and sends in one tap.
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Square, X } from "lucide-react";

// One bar per SAMPLE_MS; bars glide left continuously between samples.
const SAMPLE_MS = 70;
const BAR_W = 2.5;
const BAR_GAP = 3;

export function DictationBar({
  onCancel,
  onText,
  onError,
}: {
  onCancel: () => void;
  // andSend: the Send button — the caller sends the text straight away.
  onText: (text: string, andSend: boolean) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<"stop" | "send" | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cleanupRef = useRef<() => void>(() => {});
  const frozenRef = useRef(false);
  // The parent's handler, read at call time: a new function each parent
  // render must not restart the recording (the effect runs once).
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    let raf = 0;
    let ctx: AudioContext | null = null;
    let cancelled = false;

    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        onErrorRef.current("I can't hear you yet — your browser blocked the microphone.");
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      recorder.start(250);

      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const wave = new Float32Array(analyser.fftSize);

      const color =
        getComputedStyle(document.documentElement).getPropertyValue("--ink").trim() || "#888";
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      // Newest level last; the tape is drawn right-aligned so new bars enter
      // at the right edge and travel left.
      const levels: number[] = [];
      let peak = 0;
      let lastSample = performance.now();

      const draw = (now: number) => {
        const canvas = canvasRef.current;
        if (canvas && !frozenRef.current) {
          analyser.getFloatTimeDomainData(wave);
          let sum = 0;
          for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
          peak = Math.max(peak, Math.sqrt(sum / wave.length));

          if (now - lastSample >= SAMPLE_MS) {
            // sqrt lifts quiet speech so normal talking fills the height.
            levels.push(Math.min(1, Math.sqrt(peak * 6)));
            peak = 0;
            lastSample = now;
          }

          const dpr = window.devicePixelRatio || 1;
          const cssW = canvas.clientWidth;
          const cssH = canvas.clientHeight;
          if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
          }
          const g = canvas.getContext("2d")!;
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.clearRect(0, 0, cssW, cssH);
          g.fillStyle = color;

          const step = BAR_W + BAR_GAP;
          const capacity = Math.ceil(cssW / step) + 2;
          if (levels.length > capacity) levels.splice(0, levels.length - capacity);
          // The newest bar slides in from just past the right edge.
          const glide = reduceMotion ? step : Math.min(1, (now - lastSample) / SAMPLE_MS) * step;

          // Slots with no sample yet are faint dots, so the tape reads as
          // already running before you speak.
          for (let fromRight = 0; fromRight < capacity; fromRight++) {
            const x = cssW - BAR_W - fromRight * step + step - glide;
            if (x < -BAR_W || x > cssW) continue;
            const idx = levels.length - 1 - fromRight;
            const v = idx >= 0 ? levels[idx] : 0;
            const h = Math.max(BAR_W, v * cssH);
            // Fade bars as they leave on the left.
            g.globalAlpha = (idx >= 0 ? 1 : 0.35) * Math.min(1, x / 32 + 0.1);
            g.beginPath();
            g.roundRect(x, (cssH - h) / 2, BAR_W, h, BAR_W / 2);
            g.fill();
          }
          g.globalAlpha = 1;
        }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
    })();

    cleanupRef.current = () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    return () => cleanupRef.current();
  }, []);

  const stopRecorder = () =>
    new Promise<Blob>((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        resolve(new Blob(chunksRef.current));
        return;
      }
      recorder.onstop = () =>
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
      recorder.stop();
    });

  const finish = async (andSend: boolean) => {
    if (busy) return;
    setBusy(andSend ? "send" : "stop");
    frozenRef.current = true; // the tape holds still while it transcribes
    const blob = await stopRecorder();
    cleanupRef.current();
    const form = new FormData();
    const ext = blob.type.includes("mp4") ? "m4a" : "webm";
    form.append("audio", new File([blob], `dictation.${ext}`, { type: blob.type }));
    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) {
        onError(body.error ?? "Transcription failed. Try again.");
        return;
      }
      onText(body.text ?? "", andSend);
    } catch {
      onError("Transcription failed. Try again.");
    }
  };

  const cancel = () => {
    cleanupRef.current();
    onCancel();
  };

  return (
    <div className="flex items-center gap-2 rounded-2xl border border-edge bg-surface px-2 py-2 shadow-sm">
      <button
        onClick={cancel}
        disabled={busy !== null}
        title="Discard recording"
        aria-label="Discard recording"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
      >
        <X size={18} strokeWidth={2} />
      </button>
      <canvas
        ref={canvasRef}
        aria-hidden
        className={`h-8 min-w-0 flex-1 transition-opacity duration-300 ${busy ? "opacity-40" : ""}`}
      />
      <button
        onClick={() => finish(false)}
        disabled={busy !== null}
        title="Stop and transcribe"
        aria-label="Stop and transcribe into the message box"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-surface-2 text-ink transition-colors hover:bg-edge disabled:opacity-60"
      >
        {busy === "stop" ? (
          <Loader2 size={16} strokeWidth={2} className="animate-spin" />
        ) : (
          <Square size={13} strokeWidth={0} fill="currentColor" />
        )}
      </button>
      <button
        onClick={() => finish(true)}
        disabled={busy !== null}
        title="Send"
        aria-label="Transcribe and send"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy === "send" ? (
          <Loader2 size={16} strokeWidth={2} className="animate-spin" />
        ) : (
          <ArrowUp size={17} strokeWidth={2.25} />
        )}
      </button>
    </div>
  );
}
