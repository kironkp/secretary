"use client";

// The chat home (W1): briefing card, message thread, input bar with dictation
// mic + Talk button. One thread, both modes. Centered reading column; only the
// thread scrolls, the input stays pinned to the bottom.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  Calendar,
  Clock,
  Flame,
  Mic,
  Sparkles,
  Sun,
  TriangleAlert,
} from "lucide-react";
import type { BriefingCard } from "@/lib/secretary/briefing";
import { unlockRemoteAudio } from "@/lib/realtime/remote-audio";
import { DictationBar } from "./dictation-bar";
import { useSplit } from "./split-context";
import type { TranscriptLine } from "./use-voice-session";
import { VoiceMode } from "./voice-mode";

type Message = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  mode: "voice" | "text";
};

/** The Talk button's waveform mark (kept from the old design — it works). */
function WaveformGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <rect x="2" y="7" width="2.5" height="6" rx="1.25" />
      <rect x="6.5" y="4" width="2.5" height="12" rx="1.25" />
      <rect x="11" y="6" width="2.5" height="8" rx="1.25" />
      <rect x="15.5" y="8" width="2.5" height="4" rx="1.25" />
    </svg>
  );
}

function BriefingRow({
  icon,
  tone,
  title,
  detail,
}: {
  icon: React.ReactNode;
  tone: string;
  title: string;
  detail: string;
}) {
  return (
    <p className="flex items-baseline gap-2.5 py-0.5 text-sm">
      <span className={`flex-none translate-y-[2px] ${tone}`}>{icon}</span>
      <span>{title}</span>
      <span className="text-xs text-faint">{detail}</span>
    </p>
  );
}

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
  const { dockVoice } = useSplit();
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [msgs, setMsgs] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"idle" | "dictation" | "voice">("idle");
  // Live voice transcript, streamed into the thread as it happens — the call
  // and the chat are one conversation, not two worlds.
  const [liveLines, setLiveLines] = useState<TranscriptLine[]>([]);
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
  }, [msgs.length, liveLines.length]);

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
      setLiveLines([]); // persisted voice messages replace the live stream
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
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto py-6">
        <div className="mx-auto max-w-2xl space-y-4 px-1">
          {hasBriefing && (
            <div className="rounded-2xl border border-edge bg-surface p-5">
              <p className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted">
                <Sun size={14} strokeWidth={2} className="text-warn" />
                {briefing.dateLabel}
              </p>
              {briefing.overdue.map((i) => (
                <BriefingRow
                  key={i.id}
                  icon={<TriangleAlert size={14} strokeWidth={2} />}
                  tone="text-danger"
                  title={i.title}
                  detail={i.detail}
                />
              ))}
              {briefing.dueToday.map((i) => (
                <BriefingRow
                  key={i.id}
                  icon={<Clock size={14} strokeWidth={2} />}
                  tone="text-warn"
                  title={i.title}
                  detail={i.detail}
                />
              ))}
              {briefing.events.map((i) => (
                <BriefingRow
                  key={i.id}
                  icon={<Calendar size={14} strokeWidth={1.75} />}
                  tone="text-accent"
                  title={i.title}
                  detail={i.detail}
                />
              ))}
              {briefing.procrastinated.length > 0 && (
                <p className="mt-2 flex items-baseline gap-2 border-t border-edge/60 pt-2.5 text-xs text-warn">
                  <Flame size={12} strokeWidth={2} className="flex-none translate-y-[1.5px]" />
                  {briefing.procrastinated.map((i) => `${i.title} (${i.detail})`).join(" · ")}
                </p>
              )}
              {briefing.suggestions.length > 0 && (
                <p className="mt-1.5 flex items-center gap-2 text-xs text-ok">
                  <Sparkles size={12} strokeWidth={2} className="flex-none" />
                  {briefing.suggestions.length} suggestion
                  {briefing.suggestions.length > 1 ? "s" : ""} waiting on the dashboard
                </p>
              )}
            </div>
          )}

          {msgs.length === 0 && !hasBriefing && (
            <div className="flex flex-col items-center gap-3 pt-24 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent">
                <WaveformGlyph size={24} />
              </span>
              <p className="text-base font-semibold">Talk to your secretary</p>
              <p className="max-w-xs text-sm text-muted">
                Out loud or in writing — mention anything you need to do and it&apos;s handled.
              </p>
            </div>
          )}

          {msgs
            .filter((m) => m.role !== "tool")
            .map((m) => (
              <div
                key={m.id}
                id={`m-${m.id}`}
                className={`max-w-[85%] rounded-[14px] px-4 py-2.5 text-[15px] leading-relaxed transition-shadow ${
                  m.role === "user"
                    ? "ml-auto bg-bubble text-ink"
                    : "border border-edge bg-surface"
                }`}
              >
                {m.mode === "voice" && (
                  <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-faint">
                    <Mic size={10} strokeWidth={2} /> voice
                  </span>
                )}
                <span className="whitespace-pre-wrap">{m.content}</span>
              </div>
            ))}
          {mode === "voice" &&
            liveLines
              .filter((l) => l.text.trim())
              .map((l, i) => (
                <div
                  key={`live-${i}`}
                  className={`max-w-[85%] rounded-[14px] px-4 py-2.5 text-[15px] leading-relaxed ${
                    l.role === "user"
                      ? "ml-auto bg-bubble text-ink"
                      : "border border-edge bg-surface"
                  } ${l.final ? "" : "opacity-80"}`}
                >
                  <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-faint">
                    <Mic size={10} strokeWidth={2} className={l.final ? "" : "animate-pulse"} />
                    voice
                  </span>
                  <span className="whitespace-pre-wrap">
                    {l.text}
                    {!l.final && <span className="animate-pulse">…</span>}
                  </span>
                </div>
              ))}
          {sending && (
            <div className="max-w-[85%] rounded-[14px] border border-edge bg-surface px-4 py-2.5 text-sm text-faint">
              <span className="animate-pulse">…</span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="flex-none pb-[max(env(safe-area-inset-bottom),1rem)] pt-1">
        <div className="mx-auto max-w-2xl px-1">
          {error && <p className="mb-2 text-xs text-danger">{error}</p>}

          {mode === "voice" ? (
            <VoiceMode docked={dockVoice} onClose={closeVoice} onTranscript={setLiveLines} />
          ) : mode === "dictation" ? (
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
            <div className="flex items-end gap-1.5 rounded-2xl border border-edge bg-surface px-2.5 py-2 shadow-sm transition-shadow focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
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
                className="max-h-[140px] min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint"
              />
              {input.trim() ? (
                <button
                  onClick={send}
                  disabled={sending}
                  title="Send"
                  aria-label="Send message"
                  className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  <ArrowUp size={17} strokeWidth={2.25} />
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setMode("dictation")}
                    title="Dictate a message"
                    aria-label="Dictate a message"
                    className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    <Mic size={18} strokeWidth={1.75} />
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
                    <WaveformGlyph />
                    Talk
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
