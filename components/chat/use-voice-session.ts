"use client";

// React binding over the UI-free voice provider.
import { useCallback, useEffect, useRef, useState } from "react";
import { OpenAIRealtimeVoice } from "@/lib/realtime/openai-webrtc";
import type { ToolToast, VoiceErrorKind, VoiceStatus } from "@/lib/realtime/types";

export type TranscriptLine = { id: string; role: "user" | "assistant"; text: string; final: boolean };
export type ActiveToast = ToolToast & { key: number };

export function useVoiceSession() {
  const providerRef = useRef<OpenAIRealtimeVoice | null>(null);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [error, setError] = useState<{ kind: VoiceErrorKind; message: string } | null>(null);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const [muted, setMuted] = useState(false);
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [model, setModel] = useState<string>("");
  const toastKey = useRef(0);

  // Lines are keyed by the server's item id: barge-in interleaves user and
  // assistant streams, and "append to the last line of my role" fragments
  // under that. A final event REPLACES its line's text (the authoritative
  // transcript), deltas append to it — same id, same line, always.
  const appendTranscript = useCallback(
    (role: "user" | "assistant") => (id: string, text: string, final: boolean) => {
      const key = `${role}:${id}`;
      setTranscript((prev) => {
        const idx = prev.findIndex((l) => l.id === key);
        if (idx === -1) {
          if (!text.trim() && !final) return prev;
          return [...prev, { id: key, role, text, final }];
        }
        const line = prev[idx];
        if (line.final) return prev; // duplicate final (GA + beta event names)
        const next = [...prev];
        next[idx] = final
          ? { ...line, text, final: true }
          : { ...line, text: line.text + text };
        return next;
      });
    },
    []
  );

  const start = useCallback(
    async (chosenModel: string, chosenVoice?: string) => {
      const provider = new OpenAIRealtimeVoice();
      providerRef.current = provider;
      setTranscript([]);
      setToasts([]);
      setError(null);
      provider.on("status", (s, detail) => {
        setStatus(s);
        if (s === "error" && detail?.kind) {
          setError({ kind: detail.kind, message: detail.message ?? "Something went wrong." });
        }
      });
      provider.on("userTranscript", appendTranscript("user"));
      provider.on("assistantTranscript", appendTranscript("assistant"));
      provider.on("assistantSpeaking", setAssistantSpeaking);
      provider.on("modelChanged", setModel);
      provider.on("toolResult", (_name, toast) => {
        if (!toast) return;
        const key = ++toastKey.current;
        setToasts((prev) => [...prev.slice(-3), { ...toast, key }]);
        setTimeout(() => setToasts((prev) => prev.filter((t) => t.key !== key)), 6000);
      });
      try {
        await provider.connect({ model: chosenModel, voice: chosenVoice });
      } catch {
        /* status/error events already emitted */
      }
    },
    [appendTranscript]
  );

  const end = useCallback(async () => {
    const conversationId = providerRef.current?.conversationId ?? null;
    await providerRef.current?.disconnect();
    providerRef.current = null;
    return conversationId;
  }, []);

  const switchModel = useCallback(async (m: string) => {
    await providerRef.current?.switchModel(m);
  }, []);

  const switchVoice = useCallback(async (v: string) => {
    await providerRef.current?.switchVoice(v);
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      providerRef.current?.setMuted(!m);
      return !m;
    });
  }, []);

  useEffect(() => {
    return () => {
      providerRef.current?.disconnect();
    };
  }, []);

  return {
    status,
    error,
    transcript,
    toasts,
    muted,
    assistantSpeaking,
    model,
    start,
    end,
    switchModel,
    switchVoice,
    toggleMute,
    getMicStream: () => providerRef.current?.micStream ?? null,
    getRemoteStream: () => providerRef.current?.remoteStream ?? null,
    // Stats-based levels — safe on iOS, where Web Audio on the mic stream
    // mid-call can silence the WebRTC sender.
    getLevels: () =>
      providerRef.current?.getAudioLevels() ??
      Promise.resolve({ mic: null, remote: null, micBytesSent: 0, remoteBytesReceived: 0 }),
    getDebugInfo: () => providerRef.current?.debugInfo() ?? null,
  };
}
