"use client";

// Dictation (W2): live waveform from real mic levels via AnalyserNode.
// X discards · Check sends to /api/transcribe and drops the text into the input.
import { useEffect, useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";

export function DictationBar({
  onCancel,
  onText,
  onError,
}: {
  onCancel: () => void;
  onText: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cleanupRef = useRef<() => void>(() => {});

  useEffect(() => {
    let raf = 0;
    let ctx: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        onError("I can't hear you yet — your browser blocked the microphone.");
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
      analyser.fftSize = 128;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const draw = () => {
        const canvas = canvasRef.current;
        if (canvas) {
          const g = canvas.getContext("2d")!;
          const { width, height } = canvas;
          g.clearRect(0, 0, width, height);
          analyser.getByteFrequencyData(data);
          const bars = 32;
          const step = Math.floor(data.length / bars);
          const barW = width / bars;
          g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--color-accent") || "#7aa2ff";
          for (let i = 0; i < bars; i++) {
            const v = data[i * step] / 255;
            const h = Math.max(3, v * height * 0.9);
            g.beginPath();
            g.roundRect(i * barW + barW * 0.25, (height - h) / 2, barW * 0.5, h, 2);
            g.fill();
          }
        }
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);
      timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    })();

    cleanupRef.current = () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
      ctx?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    return () => cleanupRef.current();
  }, [onError]);

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

  const accept = async () => {
    if (busy) return;
    setBusy(true);
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
      onText(body.text ?? "");
    } catch {
      onError("Transcription failed. Try again.");
    }
  };

  const cancel = () => {
    cleanupRef.current();
    onCancel();
  };

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-accent/40 bg-surface px-2.5 py-2 shadow-sm">
      <button
        onClick={cancel}
        title="Discard recording"
        aria-label="Discard recording"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-full border border-danger/40 bg-danger/10 text-danger transition-colors hover:bg-danger/20"
      >
        <X size={16} strokeWidth={2} />
      </button>
      <canvas ref={canvasRef} width={400} height={28} className="h-7 min-w-0 flex-1 animate-pulse-subtle" />
      <span className="flex-none text-xs tabular-nums text-faint">
        {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
      </span>
      <button
        onClick={accept}
        disabled={busy}
        title="Use this recording"
        aria-label="Use this recording"
        className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-ok text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy ? <Loader2 size={16} strokeWidth={2} className="animate-spin" /> : <Check size={16} strokeWidth={2.5} />}
      </button>
    </div>
  );
}
