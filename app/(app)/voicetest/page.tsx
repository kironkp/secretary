"use client";

// Minimal known-good OpenAI Realtime WebRTC baseline (Phase 2). Follows the
// documented sample as literally as possible: getUserMedia → RTCPeerConnection
// → addTrack → ontrack attaches e.streams[0] to a VISIBLE <audio controls>
// element → data channel → SDP POST → answer. No app plumbing, no hidden
// singleton element, no React state gates in the audio path.
//
// ?preview=talk (or ?preview=pill) renders the call screen itself with a stub
// session instead: a look at VoiceMode with no microphone, no token and no
// model call, for screenshots and for checking the Talk frame against the
// mockup. Nothing on it talks to OpenAI; picking a voice there still posts
// the persona preference, as the real screen does.
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { VoiceMode } from "@/components/chat/voice-mode";
import type { useVoiceSession } from "@/components/chat/use-voice-session";

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

// The mockup's Talk frame, word for word: what you said, and her reply.
const PREVIEW_LINES: ReturnType<typeof useVoiceSession>["transcript"] = [
  { id: "user:1", role: "user", text: "The beacon glue one.", final: true },
  {
    id: "assistant:1",
    role: "assistant",
    text: "Beacon glue, then. So tomorrow is the statement, reconciling 0394, and paying beacon glue. It doesn't have a CPO number yet. Is that still to do, or did it happen?",
    final: true,
  },
];

// &state=connecting shows the grey slot before the call is up; &state=error
// the dropped-call view with its two pills.
type PreviewState = "connected" | "connecting" | "error";

function TalkPreview({ minimized, state }: { minimized: boolean; state: PreviewState }) {
  // Mute is real state so the button's pressed look can be checked by hand.
  const [muted, setMuted] = useState(false);
  const session = useMemo<ReturnType<typeof useVoiceSession>>(
    () => ({
      status: state,
      error:
        state === "error"
          ? { kind: "network", message: "The connection dropped. Your conversation is saved." }
          : null,
      transcript: state === "connected" ? PREVIEW_LINES : [],
      toasts: [],
      canvasSeq: 0,
      muted,
      assistantSpeaking: state === "connected",
      model: "gpt-realtime-2.1",
      start: async () => {},
      end: async () => null,
      switchModel: async () => {},
      switchVoice: async () => {},
      switchEffort: async () => {},
      toggleMute: () => setMuted((m) => !m),
      getMicStream: () => null,
      getRemoteStream: () => null,
      getLevels: () =>
        Promise.resolve({ mic: null, remote: null, micBytesSent: 0, remoteBytesReceived: 0 }),
      getDebugInfo: () => null,
    }),
    [muted, state]
  );
  return <VoiceMode session={session} onClose={() => {}} startMinimized={minimized} />;
}

export default function VoiceTestPage() {
  return (
    <Suspense fallback={null}>
      <VoiceTestSwitch />
    </Suspense>
  );
}

function VoiceTestSwitch() {
  const params = useSearchParams();
  const preview = params.get("preview");
  const state = params.get("state");
  if (preview === "talk" || preview === "pill")
    return (
      <TalkPreview
        minimized={preview === "pill"}
        state={state === "connecting" || state === "error" ? state : "connected"}
      />
    );
  return <RealtimeBaseline />;
}

// short beep WAV for the same-element sanity check
function makeBeep(): string {
  const rate = 8000;
  const n = rate; // 1s
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
    const env = Math.min(1, i / 200) * Math.min(1, (n - i) / 200);
    v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * 440 * i) / rate) * env * 20000, true);
  }
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(bin);
}

function RealtimeBaseline() {
  const [log, setLog] = useState<string[]>([]);
  const [stats, setStats] = useState("no call");
  const [connected, setConnected] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const add = (line: string) => {
    setLog((l) => [...l.slice(-200), `${new Date().toISOString().slice(11, 23)} ${line}`]);
  };

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log.length]);

  // 1 Hz stats line while connected
  useEffect(() => {
    if (!connected) return;
    const iv = setInterval(async () => {
      const pc = pcRef.current;
      const a = audioRef.current;
      if (!pc || !a) return;
      let bytes = 0;
      let level: number | null = null;
      const s = await pc.getStats().catch(() => null);
      s?.forEach((r) => {
        const x = r as Record<string, unknown>;
        if (x.type === "inbound-rtp" && x.kind === "audio") {
          if (typeof x.bytesReceived === "number") bytes = x.bytesReceived;
          if (typeof x.audioLevel === "number") level = x.audioLevel;
        }
      });
      setStats(
        `pc=${pc.connectionState} dc=${dcRef.current?.readyState} | inbound bytes=${bytes} level=${
          level === null ? "n/a" : (level as number).toFixed(4)
        } | audioEl paused=${a.paused} readyState=${a.readyState} muted=${a.muted} vol=${a.volume}`
      );
    }, 1000);
    return () => clearInterval(iv);
  }, [connected]);

  const connect = async () => {
    try {
      add("getUserMedia…");
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      add(`mic ok: ${mic.getAudioTracks()[0]?.label}`);

      add("fetching test token…");
      const tokenRes = await fetch("/api/realtime/token-test", { method: "POST" });
      if (!tokenRes.ok) {
        add(`token FAILED: ${tokenRes.status} ${JSON.stringify(await tokenRes.json().catch(() => ({})))}`);
        return;
      }
      const { clientSecret, model } = await tokenRes.json();
      add(`token ok (${model})`);

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      for (const track of mic.getTracks()) pc.addTrack(track, mic);

      pc.ontrack = (e) => {
        add(`ontrack: streams=${e.streams.length} track.muted=${e.track.muted}`);
        e.track.onunmute = () => add("remote track UNMUTED (RTP flowing)");
        e.track.onmute = () => add("remote track muted");
        const a = audioRef.current!;
        a.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        a.play()
          .then(() => add("audio.play() OK"))
          .catch((err: Error) => add(`audio.play() REJECTED: ${err.name}: ${err.message}`));
      };
      pc.onconnectionstatechange = () => add(`pc: ${pc.connectionState}`);

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.onopen = () => add("dc open");
      dc.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type === "error" || ev.type === "response.done") {
            add(`${ev.type}: ${JSON.stringify(ev).slice(0, 400)}`);
          } else {
            add(ev.type);
          }
        } catch {
          add("unparseable dc message");
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      add("posting SDP…");
      const sdpRes = await fetch(CALLS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${clientSecret}`, "Content-Type": "application/sdp" },
        body: offer.sdp,
      });
      if (!sdpRes.ok) {
        add(`SDP FAILED: ${sdpRes.status} ${(await sdpRes.text()).slice(0, 200)}`);
        return;
      }
      const answer = await sdpRes.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      const dir = answer.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/m)?.[1];
      add(`answer set (audio dir: ${dir ?? "?"})`);
      setConnected(true);
    } catch (e) {
      add(`connect threw: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  };

  const disconnect = () => {
    dcRef.current?.close();
    pcRef.current?.close();
    pcRef.current = null;
    dcRef.current = null;
    if (audioRef.current) audioRef.current.srcObject = null;
    setConnected(false);
    setStats("no call");
    add("disconnected");
  };

  const sayHi = () => {
    if (dcRef.current?.readyState !== "open") return add("dc not open");
    dcRef.current.send(JSON.stringify({ type: "response.create" }));
    add("sent response.create");
  };

  const testTone = () => {
    const a = audioRef.current!;
    const hadStream = Boolean(a.srcObject);
    a.srcObject = null;
    a.src = makeBeep();
    a.play()
      .then(() => add(`beep playing through the same element${hadStream ? " (stream detached!)" : ""}`))
      .catch((err: Error) => add(`beep REJECTED: ${err.name}: ${err.message}`));
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-3 py-6">
      <h1 className="text-xl font-bold">🎙 Voice test — minimal Realtime baseline</h1>
      <p className="text-sm text-muted">
        Simplest possible session: no instructions, no tools, no transcription, default VAD. Tap
        Connect, then speak (or tap &quot;Say hi&quot; to force a response without VAD). You should
        hear the assistant out loud. The audio element below is visible on purpose — watch it.
      </p>

      <div className="flex flex-wrap gap-2">
        {!connected ? (
          <button onClick={connect} className="rounded-xl bg-accent px-4 py-3 text-sm font-bold text-bg">
            Connect
          </button>
        ) : (
          <button onClick={disconnect} className="rounded-xl border border-danger/50 bg-danger/10 px-4 py-3 text-sm font-bold text-danger">
            Disconnect
          </button>
        )}
        <button onClick={sayHi} className="rounded-xl border border-edge bg-surface px-4 py-3 text-sm font-bold">
          Say hi (response.create)
        </button>
        <button onClick={testTone} className="rounded-xl border border-edge bg-surface px-4 py-3 text-sm font-bold">
          Test tone (same element)
        </button>
      </div>

      {/* visible on purpose — we want to watch paused/readyState with our eyes */}
      <audio ref={audioRef} controls autoPlay playsInline className="w-full" />

      <p className="rounded-lg border border-edge bg-surface px-3 py-2 font-mono text-[11px] text-muted">
        {stats}
      </p>

      <div
        ref={logRef}
        className="h-64 overflow-y-auto rounded-lg border border-edge bg-black/40 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink"
      >
        {log.map((l, i) => (
          <div key={i}>{l}</div>
        ))}
        {log.length === 0 && <span className="text-faint">log will appear here</span>}
      </div>
    </main>
  );
}
