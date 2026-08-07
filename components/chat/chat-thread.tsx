"use client";

// The chat home (W1): briefing card, message thread, input bar with mic
// (dictation) + waveform glyph (voice mode). One thread, both modes.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BriefingCard } from "@/lib/secretary/briefing";
import { unlockRemoteAudio } from "@/lib/realtime/remote-audio";
import { DictationBar } from "./dictation-bar";
import { VoiceMode } from "./voice-mode";

type Message = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  mode: "voice" | "text";
};

export function ChatThread({
  initialConversationId,
  initialMessages,
  briefing,
  anchorMessageId,
}: {
  initialConversationId: string | null;
  initialMessages: Message[];
  briefing: BriefingCard;
  anchorMessageId?: string;
}) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [msgs, setMsgs] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"idle" | "dictation" | "voice">("idle");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const localKey = useRef(0);

  useEffect(() => {
    if (anchorMessageId) {
      const el = document.getElementById(`m-${anchorMessageId}`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.classList.add("anchor-highlight");
        return;
      }
    }
    bottomRef.current?.scrollIntoView();
  }, [anchorMessageId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setError("");
    setSending(true);
    const tempId = `local-${++localKey.current}`;
    setMsgs((m) => [...m, { id: tempId, role: "user", content: text, mode: "text" }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, conversationId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Message failed — try again.");
        return;
      }
      setConversationId(body.conversationId);
      setMsgs((m) => [
        ...m.map((msg) => (msg.id === tempId ? { ...msg, id: body.userMessageId } : msg)),
        { ...body.assistantMessage, mode: "text" as const },
      ]);
      router.refresh(); // today strip + dashboard counts
    } catch {
      setError("Message failed — check your connection.");
    } finally {
      setSending(false);
    }
  };

  const closeVoice = useCallback(
    async (voiceConversationId: string | null) => {
      setMode("idle");
      if (voiceConversationId) {
        setConversationId(voiceConversationId);
        const res = await fetch(`/api/conversations/${voiceConversationId}/messages`);
        if (res.ok) {
          const body = await res.json();
          setMsgs(body.messages);
        }
        router.refresh();
      }
    },
    [router]
  );

  const hasBriefing = briefing.hasContent;

  return (
    <div className="flex h-[calc(100dvh-150px)] flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto pb-4">
        {hasBriefing && (
          <div className="rounded-xl border border-edge bg-surface p-4 text-sm">
            <p className="mb-2 text-xs font-bold text-muted">☀️ {briefing.dateLabel}</p>
            {briefing.overdue.map((i) => (
              <p key={i.id} className="mb-1">
                <span className="mr-1.5 text-danger">⚠</span>
                {i.title} <span className="text-xs text-faint">— {i.detail}</span>
              </p>
            ))}
            {briefing.dueToday.map((i) => (
              <p key={i.id} className="mb-1">
                <span className="mr-1.5 text-warn">•</span>
                {i.title} <span className="text-xs text-faint">— {i.detail}</span>
              </p>
            ))}
            {briefing.events.map((i) => (
              <p key={i.id} className="mb-1">
                <span className="mr-1.5">📅</span>
                {i.title} <span className="text-xs text-faint">— {i.detail}</span>
              </p>
            ))}
            {briefing.procrastinated.length > 0 && (
              <p className="mt-2 text-xs text-warn">
                😬 {briefing.procrastinated.map((i) => `${i.title} (${i.detail})`).join(" · ")}
              </p>
            )}
            {briefing.suggestions.length > 0 && (
              <p className="mt-1 text-xs text-ok">
                ✨ {briefing.suggestions.length} suggestion
                {briefing.suggestions.length > 1 ? "s" : ""} waiting on the dashboard
              </p>
            )}
          </div>
        )}

        {msgs.length === 0 && !hasBriefing && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-3xl">👋</p>
            <p className="text-sm text-muted">
              Say hello — out loud or in writing. Mention anything you need to do
              and it&apos;s handled.
            </p>
          </div>
        )}

        {msgs
          .filter((m) => m.role !== "tool")
          .map((m) => (
            <div
              key={m.id}
              id={`m-${m.id}`}
              className={`max-w-[80%] rounded-xl border px-4 py-2.5 text-sm leading-relaxed transition-shadow ${
                m.role === "user"
                  ? "ml-auto border-accent/30 bg-bubble"
                  : "border-edge bg-surface"
              }`}
            >
              {m.mode === "voice" && (
                <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-faint">
                  🎙 voice
                </span>
              )}
              <span className="whitespace-pre-wrap">{m.content}</span>
            </div>
          ))}
        {sending && (
          <div className="max-w-[80%] rounded-xl border border-edge bg-surface px-4 py-2.5 text-sm text-faint">
            <span className="animate-pulse">…</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mb-2 text-xs text-danger">{error}</p>}

      {mode === "dictation" ? (
        <DictationBar
          onCancel={() => setMode("idle")}
          onText={(text) => {
            setInput((prev) => (prev ? `${prev} ${text}` : text));
            setMode("idle");
          }}
          onError={(message) => {
            setError(message);
            setMode("idle");
          }}
        />
      ) : (
        <div className="flex items-end gap-2 rounded-2xl border border-edge bg-surface-2 px-3 py-2 focus-within:border-accent">
          <textarea
            ref={inputRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 140) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Message your secretary…"
            className="max-h-[140px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint"
          />
          {input.trim() ? (
            <button
              onClick={send}
              disabled={sending}
              title="Send"
              aria-label="Send message"
              className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-lg font-bold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              ↑
            </button>
          ) : (
            <>
              <button
                onClick={() => setMode("dictation")}
                title="Dictate a message"
                aria-label="Dictate a message"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-lg text-muted hover:bg-card hover:text-ink"
              >
                🎙
              </button>
              <button
                onClick={() => {
                  // must run synchronously inside the tap: iOS only allows
                  // audio playback that a user gesture unlocked
                  unlockRemoteAudio();
                  setMode("voice");
                }}
                title="Start a live voice conversation"
                aria-label="Start a live voice conversation"
                className="flex h-9 flex-none items-center gap-1.5 rounded-full bg-accent px-3.5 text-sm font-bold text-bg transition-opacity hover:opacity-90"
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <rect x="2" y="7" width="2.5" height="6" rx="1.25" />
                  <rect x="6.5" y="4" width="2.5" height="12" rx="1.25" />
                  <rect x="11" y="6" width="2.5" height="8" rx="1.25" />
                  <rect x="15.5" y="8" width="2.5" height="4" rx="1.25" />
                </svg>
                Talk
              </button>
            </>
          )}
        </div>
      )}

      {mode === "voice" && <VoiceMode onClose={closeVoice} />}
    </div>
  );
}
