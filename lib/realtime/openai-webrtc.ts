// OpenAI Realtime over WebRTC, direct from the browser (no audio proxying).
// Flow: POST /api/realtime/token (auth-gated, rate-limited, briefing baked into
// the session server-side) → ephemeral client secret → SDP exchange with
// api.openai.com → audio tracks + "oai-events" data channel.
import { ElevenLabsMouth } from "./el-mouth";
import { EL_MOUTH_VOICE } from "@/lib/elevenlabs";
import { playRemoteStream, remoteAudioState } from "./remote-audio";
import type {
  ToolToast,
  VoiceEvents,
  VoiceErrorKind,
  VoiceProvider,
  VoiceStatus,
} from "./types";

const OPENAI_CALLS_URL = "https://api.openai.com/v1/realtime/calls";
const MAX_RECONNECTS = 5;

/** Direction attribute of the first audio m-line section of an SDP. */
function sdpAudioDirection(sdp: string): string | null {
  const audioSection = sdp.split(/^m=/m).find((s) => s.startsWith("audio"));
  if (!audioSection) return null;
  const m = audioSection.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/m);
  return m?.[1] ?? null;
}

type TokenResponse = {
  clientSecret: string;
  conversationId: string;
  usageId: string;
  model: string;
};

export class OpenAIRealtimeVoice implements VoiceProvider {
  status: VoiceStatus = "idle";
  model: string | null = null;
  /** Chosen output voice; undefined = server default (REALTIME_VOICE).
   *  The sentinel "elevenlabs" switches the session to text output spoken by
   *  the ElevenLabs mouth. */
  voice: string | undefined;
  private mouth: ElevenLabsMouth | null = null;

  private get elMouthMode(): boolean {
    return this.voice === EL_MOUTH_VOICE;
  }
  conversationId: string | null = null;
  micStream: MediaStream | null = null;
  remoteStream: MediaStream | null = null;

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private usageId: string | null = null;
  private muted = false;
  private startedAt = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private reconnects = 0;
  private intentionalClose = false;
  private assistantResponding = false;
  private recoveringMic = false;
  private eventsReceived = 0;
  private debugTimers: ReturnType<typeof setTimeout>[] = [];

  // --- diagnostics (kept permanently: this app is debugged from a phone) ---
  private eventLog: { t: number; type: string }[] = [];
  private ontrackAt: number | null = null;
  private ontrackStreams = 0;
  private trackMutedAtOntrack: boolean | null = null;
  private trackUnmutedAt: number | null = null;
  private sdp: { offerAudioDir: string | null; answerAudioDir: string | null; answerHasAudio: boolean } | null = null;
  private lastErrorEvent: unknown = null;
  private lastResponseDone: unknown = null;
  private audioTokensTotal = 0;

  /** Everything the debug overlay / beacon wants, in one object. */
  debugInfo() {
    return {
      status: this.status,
      connectionState: this.pc?.connectionState ?? "none",
      dcState: this.dc?.readyState ?? "none",
      eventsReceived: this.eventsReceived,
      ontrackAt: this.ontrackAt,
      ontrackStreams: this.ontrackStreams,
      trackMutedAtOntrack: this.trackMutedAtOntrack,
      trackUnmutedAt: this.trackUnmutedAt,
      sdp: this.sdp,
      audioTokensTotal: this.audioTokensTotal,
      lastErrorEvent: this.lastErrorEvent,
      lastResponseDone: this.lastResponseDone,
      lastEventTypes: this.eventLog.slice(-15).map((e) => e.type),
      audioEl: remoteAudioState(),
    };
  }

  // Refresh/close mid-call would orphan the session (blocking the concurrency
  // limit) — sendBeacon survives page teardown where fetch doesn't.
  private pagehide = () => {
    if (!this.usageId) return;
    const seconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    navigator.sendBeacon(
      "/api/realtime/end",
      new Blob(
        [
          JSON.stringify({
            usageId: this.usageId,
            conversationId: this.conversationId,
            seconds,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
          }),
        ],
        { type: "application/json" }
      )
    );
  };
  private listeners = new Map<keyof VoiceEvents, Set<(...args: never[]) => void>>();

  on<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (...args: never[]) => void);
    return () => set.delete(handler as (...args: never[]) => void);
  }

  private emit<K extends keyof VoiceEvents>(event: K, ...args: Parameters<VoiceEvents[K]>) {
    this.listeners.get(event)?.forEach((h) => (h as (...a: unknown[]) => void)(...args));
  }

  private setStatus(status: VoiceStatus, detail?: { kind?: VoiceErrorKind; message?: string }) {
    this.status = status;
    this.emit("status", status, detail);
  }

  async connect({ model, voice }: { model: string; voice?: string }): Promise<void> {
    this.intentionalClose = false;
    this.model = model;
    if (voice) this.voice = voice;
    if (this.elMouthMode && !this.mouth) {
      this.mouth = new ElevenLabsMouth();
      this.mouth.onSpeakingChange = (speaking) => this.emit("assistantSpeaking", speaking);
    } else if (!this.elMouthMode && this.mouth) {
      this.mouth.dispose();
      this.mouth = null;
    }

    if (!this.micStream) {
      this.setStatus("requesting-mic");
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        this.setStatus("error", {
          kind: "mic-denied",
          message: "Your browser blocked the microphone.",
        });
        throw new Error("mic-denied");
      }
    }

    this.setStatus(this.reconnects > 0 ? "reconnecting" : "connecting");

    const tokenRes = await fetch("/api/realtime/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        voice: this.voice,
        conversationId: this.conversationId,
        reconnect: this.reconnects > 0 || Boolean(this.conversationId),
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.json().catch(() => ({}));
      const kind: VoiceErrorKind =
        tokenRes.status === 503 ? "disabled" : tokenRes.status === 429 ? "quota" : "unknown";
      this.setStatus("error", { kind, message: body.error ?? "Couldn't start the call." });
      throw new Error(body.error ?? "token-failed");
    }
    const token: TokenResponse = await tokenRes.json();
    this.conversationId = token.conversationId;
    this.usageId = token.usageId;

    const pc = new RTCPeerConnection();
    this.pc = pc;
    for (const track of this.micStream.getTracks()) {
      track.enabled = !this.muted;
      pc.addTrack(track, this.micStream);
    }
    pc.ontrack = (e) => {
      this.ontrackAt = Date.now();
      this.ontrackStreams = e.streams.length;
      this.trackMutedAtOntrack = e.track.muted;
      // a remote track that never unmutes = RTP never arrived — key signature
      e.track.onunmute = () => {
        this.trackUnmutedAt = Date.now();
      };
      this.remoteStream = e.streams[0] ?? new MediaStream([e.track]);
      // Attach directly here (the documented pattern) — the UI poll is only a
      // backup. Waiting for React state to observe "connected" before ever
      // touching the element is how the stream ended up never attached.
      playRemoteStream(this.remoteStream);
    };
    pc.onconnectionstatechange = () => {
      if (
        (pc.connectionState === "failed" || pc.connectionState === "disconnected") &&
        !this.intentionalClose
      ) {
        this.tryReconnect();
      }
    };

    const dc = pc.createDataChannel("oai-events");
    this.dc = dc;
    dc.onmessage = (e) => this.handleEvent(JSON.parse(e.data));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch(OPENAI_CALLS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.clientSecret}`,
        "Content-Type": "application/sdp",
      },
      body: offer.sdp,
    });
    if (!sdpRes.ok) {
      this.setStatus("error", { kind: "network", message: "Call setup failed." });
      throw new Error(`sdp-exchange-failed: ${sdpRes.status}`);
    }
    const answerSdp = await sdpRes.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    this.sdp = {
      offerAudioDir: sdpAudioDirection(offer.sdp ?? ""),
      answerAudioDir: sdpAudioDirection(answerSdp),
      answerHasAudio: /^m=audio /m.test(answerSdp),
    };

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.setStatus("error", {
          kind: "network",
          message: "Connected, but the audio channel never opened. Try again.",
        });
        reject(new Error("connect-timeout"));
      }, 15000);
      dc.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
    });

    if (!this.startedAt) this.startedAt = Date.now();
    this.reconnects = 0;
    this.setStatus("connected");
    this.emit("modelChanged", model);
    this.watchMicTrack();
    this.scheduleDebugBeacons();
    window.addEventListener("pagehide", this.pagehide);
  }

  /**
   * Audio levels straight from WebRTC stats — no Web Audio involved. On iOS
   * Safari, attaching an AudioContext to the mic stream mid-call can re-route
   * the audio session and silence the outbound track, so the UI must never do
   * that; it polls this instead. Values are null when the browser doesn't
   * report them.
   */
  async getAudioLevels(): Promise<{
    mic: number | null;
    remote: number | null;
    micBytesSent: number;
    remoteBytesReceived: number;
  }> {
    const out = { mic: null as number | null, remote: null as number | null, micBytesSent: 0, remoteBytesReceived: 0 };
    if (this.mouth) out.remote = this.mouth.level();
    if (!this.pc) return out;
    const stats = await this.pc.getStats().catch(() => null);
    if (!stats) return out;
    stats.forEach((s) => {
      const r = s as Record<string, unknown>;
      if (r.type === "media-source" && r.kind === "audio" && typeof r.audioLevel === "number") {
        out.mic = r.audioLevel;
      }
      if (r.type === "outbound-rtp" && r.kind === "audio" && typeof r.bytesSent === "number") {
        out.micBytesSent = r.bytesSent;
      }
      if (r.type === "inbound-rtp" && r.kind === "audio") {
        if (typeof r.bytesReceived === "number") out.remoteBytesReceived = r.bytesReceived;
        if (typeof r.audioLevel === "number" && !this.mouth) out.remote = r.audioLevel;
      }
    });
    return out;
  }

  // Three snapshots early in every call, logged server-side — enough to tell
  // "audio bytes aren't leaving the phone" from "OpenAI hears silence" from
  // "events aren't arriving" without needing the phone's console.
  private scheduleDebugBeacons() {
    for (const ms of [3000, 9000, 20000]) {
      this.debugTimers.push(setTimeout(() => void this.sendDebugSnapshot(ms), ms));
    }
  }

  private async sendDebugSnapshot(atMs: number) {
    try {
      const levels = await this.getAudioLevels();
      const track = this.micStream?.getAudioTracks()[0];
      await fetch("/api/realtime/debug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          atMs,
          conversationId: this.conversationId,
          ...levels,
          ...this.debugInfo(),
          micTrack: track
            ? {
                muted: track.muted,
                readyState: track.readyState,
                enabled: track.enabled,
                label: track.label,
              }
            : null,
        }),
      });
    } catch {
      /* diagnostics only */
    }
  }

  // iOS Safari sometimes hands back a dead/silent mic track (especially on the
  // second getUserMedia of a page's life, or after backgrounding). The track
  // reports muted/ended — detect that and transparently swap in a fresh one.
  private watchMicTrack() {
    const track = this.micStream?.getAudioTracks()[0];
    if (!track) return;
    const recover = () => void this.recoverMic();
    track.onmute = recover;
    track.onended = recover;
    // a track that is already dead on arrival never fires onmute — check once
    setTimeout(() => {
      if (track.muted || track.readyState === "ended") void this.recoverMic();
    }, 2000);
  }

  private async recoverMic() {
    if (this.recoveringMic || this.intentionalClose || this.status !== "connected") return;
    const stale = this.micStream?.getAudioTracks()[0];
    if (!stale) return;
    // brief transient mutes happen on route changes (speaker↔headphones) — re-check
    await new Promise((r) => setTimeout(r, 800));
    if (!stale.muted && stale.readyState !== "ended") return;
    this.recoveringMic = true;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: true });
      const freshTrack = fresh.getAudioTracks()[0];
      freshTrack.enabled = !this.muted;
      const sender = this.pc?.getSenders().find((s) => s.track?.kind === "audio");
      if (sender) await sender.replaceTrack(freshTrack);
      this.micStream?.getTracks().forEach((t) => t.stop());
      this.micStream = fresh;
      this.watchMicTrack();
    } catch {
      /* mic re-acquire failed — the silent-mic hint in the UI covers this */
    } finally {
      this.recoveringMic = false;
    }
  }

  private async tryReconnect() {
    if (this.reconnects >= MAX_RECONNECTS) {
      this.setStatus("error", {
        kind: "network",
        message: "Lost the connection and couldn't get it back.",
      });
      return;
    }
    this.reconnects += 1;
    this.setStatus("reconnecting");
    this.teardownPeer();
    await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** this.reconnects, 8000)));
    try {
      await this.connect({ model: this.model!, voice: this.voice });
    } catch {
      if (!this.intentionalClose) this.tryReconnect();
    }
  }

  async switchModel(model: string): Promise<void> {
    if (model === this.model) return;
    await this.reconnectWith({ model });
  }

  async switchVoice(voice: string): Promise<void> {
    if (voice === this.voice) return;
    await this.reconnectWith({ voice });
  }

  /** Re-mint the session with changed options; the call resumes, no greeting. */
  private async reconnectWith(opts: { model?: string; voice?: string }): Promise<void> {
    this.setStatus("reconnecting");
    this.teardownPeer();
    this.reconnects = 1; // marks the next connect as a resume, not a fresh greeting
    await this.connect({ model: opts.model ?? this.model!, voice: opts.voice ?? this.voice });
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.micStream?.getTracks().forEach((t) => (t.enabled = !muted));
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.mouth?.dispose();
    this.mouth = null;
    window.removeEventListener("pagehide", this.pagehide);
    this.teardownPeer();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    if (this.usageId) {
      const seconds = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
      await fetch("/api/realtime/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usageId: this.usageId,
          conversationId: this.conversationId,
          seconds,
          inputTokens: this.inputTokens,
          outputTokens: this.outputTokens,
        }),
      }).catch(() => {});
    }
    this.setStatus("ended");
  }

  private teardownPeer() {
    this.debugTimers.forEach(clearTimeout);
    this.debugTimers = [];
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
  }

  private send(event: Record<string, unknown>) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(event));
  }

  private persistedIds = new Set<string>();

  private persistOnce(key: string, role: "user" | "assistant", content: string) {
    if (!this.conversationId || !content.trim()) return;
    if (this.persistedIds.has(key)) return; // duplicate event name for the same item
    this.persistedIds.add(key);
    fetch(`/api/conversations/${this.conversationId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, content, mode: "voice" }),
    }).catch(() => {});
  }

  private async handleToolCall(callId: string, name: string, argsJson: string) {
    let args: unknown = {};
    try {
      args = JSON.parse(argsJson || "{}");
    } catch {
      /* leave empty */
    }
    const res = await fetch("/api/secretary/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args, conversationId: this.conversationId }),
    });
    const body = res.ok ? await res.json() : { result: { error: "Tool call failed" } };
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(body.result ?? {}),
      },
    });
    this.send({ type: "response.create" });
    this.emit("toolResult", name, body.toast as ToolToast | undefined);
  }

  private handleEvent(event: { type: string } & Record<string, unknown>) {
    this.eventsReceived += 1;
    const t = event.type;
    this.eventLog.push({ t: Date.now(), type: t });
    if (this.eventLog.length > 200) this.eventLog.splice(0, this.eventLog.length - 200);

    if (t === "error") {
      // Never kill a live call over a server-side event error, but never
      // drop it silently either.
      this.lastErrorEvent = event;
      console.warn("[realtime] error event:", JSON.stringify(event).slice(0, 500));
      return;
    }
    if (t === "input_audio_buffer.speech_started") {
      // Barge-in: semantic_vad interrupts the response server-side
      // (interrupt_response defaults true) — a manual response.cancel here
      // races with it. Just update the UI (and silence the EL mouth).
      this.mouth?.interrupt();
      this.emit("assistantSpeaking", false);
      return;
    }
    if (t === "response.created") {
      this.assistantResponding = true;
      this.emit("assistantSpeaking", true);
      return;
    }
    if (t === "response.done") {
      this.assistantResponding = false;
      this.emit("assistantSpeaking", false);
      const response = event.response as {
        status?: string;
        status_details?: unknown;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          output_token_details?: { audio_tokens?: number };
        };
      };
      this.lastResponseDone = {
        status: response?.status,
        status_details: response?.status_details,
        audio_tokens: response?.usage?.output_token_details?.audio_tokens,
      };
      this.audioTokensTotal += response?.usage?.output_token_details?.audio_tokens ?? 0;
      if (response?.status && response.status !== "completed") {
        console.warn("[realtime] response ended:", JSON.stringify(this.lastResponseDone));
      }
      if (response?.usage) {
        this.inputTokens += response.usage.input_tokens ?? 0;
        this.outputTokens += response.usage.output_tokens ?? 0;
      }
      return;
    }
    // User speech transcription (GA + beta event names). Lines are keyed by
    // the server's item id so interleaved streams (barge-in) can't fragment.
    if (t === "conversation.item.input_audio_transcription.delta") {
      this.emit("userTranscript", String(event.item_id ?? "user-live"), String(event.delta ?? ""), false);
      return;
    }
    if (t === "conversation.item.input_audio_transcription.completed") {
      const id = String(event.item_id ?? "user-live");
      const text = String(event.transcript ?? "");
      this.emit("userTranscript", id, text, true);
      this.persistOnce(`user:${id}`, "user", text);
      return;
    }
    // Assistant audio transcript (GA name response.output_audio_transcript.*, beta response.audio_transcript.*)
    if (t.endsWith("audio_transcript.delta")) {
      const id = String(event.item_id ?? event.response_id ?? "assistant-live");
      this.emit("assistantTranscript", id, String(event.delta ?? ""), false);
      return;
    }
    if (t.endsWith("audio_transcript.done")) {
      const id = String(event.item_id ?? event.response_id ?? "assistant-live");
      const text = String(event.transcript ?? "");
      this.emit("assistantTranscript", id, text, true);
      // GA + beta names can BOTH fire for the same item — persist exactly once.
      this.persistOnce(`assistant:${id}`, "assistant", text);
      return;
    }
    // EL mouth mode: the session emits TEXT; the mouth speaks it.
    if (t === "response.output_text.delta" && this.mouth) {
      const id = String(event.item_id ?? event.response_id ?? "assistant-live");
      const delta = String(event.delta ?? "");
      this.mouth.pushDelta(delta);
      this.emit("assistantTranscript", id, delta, false);
      return;
    }
    if (t === "response.output_text.done" && this.mouth) {
      const id = String(event.item_id ?? event.response_id ?? "assistant-live");
      const text = String(event.text ?? "");
      this.mouth.flushFinal();
      this.emit("assistantTranscript", id, text, true);
      this.persistOnce(`assistant:${id}`, "assistant", text);
      return;
    }
    if (t === "response.function_call_arguments.done") {
      this.handleToolCall(
        String(event.call_id),
        String(event.name),
        String(event.arguments ?? "{}")
      );
      return;
    }
  }
}
