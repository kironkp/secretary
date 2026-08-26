"use client";

// The chat home (W1): briefing card, message thread, input bar with dictation
// mic + Talk button. One thread, both modes. Centered reading column; only the
// thread scrolls, the input stays pinned to the bottom.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUp,
  Calendar,
  Clock,
  FileText,
  Flame,
  Mic,
  Paperclip,
  Sparkles,
  Sun,
  TriangleAlert,
  X,
} from "lucide-react";
import type { BriefingCard } from "@/lib/secretary/briefing";
import { unlockRemoteAudio } from "@/lib/realtime/remote-audio";
import { DictationBar } from "./dictation-bar";
import { ModelChip } from "./model-chip";
import { useVoiceCall } from "./voice-call-provider";

type Attachment = { id: string; mime: string; name: string };

type Message = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  mode: "voice" | "text";
  attachments?: Attachment[] | null;
  /** Client-only: delivery failed; the reason shows under the bubble with a
   *  tap-to-retry (payload kept — nothing to retype, iMessage-style). */
  failed?: string;
};

type PendingAttachment = {
  key: number;
  name: string;
  mime: string;
  previewUrl: string | null; // object URL for images
  id: string | null; // server id once uploaded
  error: string | null;
};

const MAX_ATTACHMENTS = 4;
const IMAGE_MAX_EDGE = 1600;

/** Downscale + JPEG-encode a picked image (handles HEIC on iOS — Safari
 *  decodes it natively, and the canvas re-encodes to a mime the model takes). */
async function normalizeImage(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode failed"));
      el.src = url;
    });
    const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85)
    );
    if (!blob) throw new Error("encode failed");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

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
  secretaryName = "Secretary",
  defaultVoice = "marin",
  defaultVoiceEffort = "auto",
  initialChatModel = "gpt-5.5",
  initialChatEffort = "medium",
}: {
  initialConversationId: string | null;
  initialMessages: Message[];
  briefing: BriefingCard;
  anchorMessageId?: string;
  /** The name the user gave their secretary — labels the transcript. */
  secretaryName?: string;
  /** Persona-preferred call voice; switchable mid-call. */
  defaultVoice?: string;
  /** Persona-preferred realtime thinking depth ("auto" = API default). */
  defaultVoiceEffort?: string;
  /** Composer chip: persisted chat model + effort. */
  initialChatModel?: string;
  initialChatEffort?: string;
}) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [msgs, setMsgs] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"idle" | "dictation">("idle");
  // The call is GLOBAL (VoiceCallProvider in the app shell) — this thread just
  // reads its live transcript so voice lines render as messages while talking.
  const call = useVoiceCall();
  const liveLines = call.active ? call.session.transcript : [];
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const localKey = useRef(0);
  const [pending, setPending] = useState<PendingAttachment[]>([]);

  // Pick → normalize (images to ≤1600px JPEG) → upload right away; the send
  // only passes ids. Failed uploads show inline and never block the text.
  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files).slice(0, MAX_ATTACHMENTS - pending.length)) {
      const key = ++localKey.current;
      const isPdf = file.type === "application/pdf";
      const entry: PendingAttachment = {
        key,
        name: file.name || "photo",
        mime: isPdf ? "application/pdf" : "image/jpeg",
        previewUrl: null,
        id: null,
        error: null,
      };
      setPending((p) => [...p, entry]);
      try {
        const blob = isPdf ? file : await normalizeImage(file);
        if (!isPdf) {
          const previewUrl = URL.createObjectURL(blob);
          setPending((p) => p.map((a) => (a.key === key ? { ...a, previewUrl } : a)));
        }
        const form = new FormData();
        form.append(
          "file",
          new File([blob], isPdf ? entry.name : entry.name.replace(/\.\w+$/, "") + ".jpg", {
            type: entry.mime,
          })
        );
        const res = await fetch("/api/attachments", { method: "POST", body: form });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "upload failed");
        setPending((p) => p.map((a) => (a.key === key ? { ...a, id: body.id } : a)));
      } catch (e) {
        setPending((p) =>
          p.map((a) =>
            a.key === key
              ? { ...a, error: e instanceof Error ? e.message : "upload failed" }
              : a
          )
        );
      }
    }
  };

  const removePending = (key: number) => {
    setPending((p) => {
      const gone = p.find((a) => a.key === key);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return p.filter((a) => a.key !== key);
    });
  };

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

  // Payloads for undelivered messages, keyed by their local id — a failed
  // bubble can be re-sent verbatim (text + already-uploaded attachment ids).
  const retryPayloads = useRef(new Map<string, { text: string; attachmentIds: string[] }>());

  const deliver = async (tempId: string) => {
    const payload = retryPayloads.current.get(tempId);
    if (!payload || sending) return;
    setSending(true);
    setMsgs((m) => m.map((msg) => (msg.id === tempId ? { ...msg, failed: undefined } : msg)));
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: payload.text,
          conversationId,
          attachmentIds: payload.attachmentIds,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMsgs((m) =>
          m.map((msg) =>
            msg.id === tempId ? { ...msg, failed: body.error ?? "Message failed" } : msg
          )
        );
        return;
      }
      retryPayloads.current.delete(tempId);
      setConversationId(body.conversationId);
      setMsgs((m) => [
        ...m.map((msg) => (msg.id === tempId ? { ...msg, id: body.userMessageId } : msg)),
        { ...body.assistantMessage, mode: "text" as const },
      ]);
      router.refresh(); // today strip + dashboard counts
    } catch {
      setMsgs((m) =>
        m.map((msg) => (msg.id === tempId ? { ...msg, failed: "Not delivered" } : msg))
      );
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    const ready = pending.filter((a) => a.id);
    if ((!text && ready.length === 0) || sending) return;
    if (pending.some((a) => !a.id && !a.error)) return; // uploads still in flight
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setError("");
    const sentAttachments: Attachment[] = ready.map((a) => ({
      id: a.id!,
      mime: a.mime,
      name: a.name,
    }));
    // thumbnails render from the server from here on
    pending.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    setPending([]);
    const tempId = `local-${++localKey.current}`;
    retryPayloads.current.set(tempId, { text, attachmentIds: sentAttachments.map((a) => a.id) });
    setMsgs((m) => [
      ...m,
      {
        id: tempId,
        role: "user",
        content: text || (ready.length === 1 ? `(sent ${ready[0].name})` : `(sent ${ready.length} files)`),
        mode: "text",
        attachments: sentAttachments.length ? sentAttachments : null,
      },
    ]);
    await deliver(tempId);
  };

  // When a call ends (wherever the user was), swap the live stream for the
  // persisted voice messages.
  const endedSeq = useRef(0);
  useEffect(() => {
    if (!call.ended || call.ended.seq === endedSeq.current) return;
    endedSeq.current = call.ended.seq;
    const voiceConversationId = call.ended.conversationId;
    if (!voiceConversationId) return;
    setConversationId(voiceConversationId);
    void (async () => {
      const res = await fetch(`/api/conversations/${voiceConversationId}/messages`);
      if (res.ok) setMsgs(((await res.json()) as { messages: Message[] }).messages);
      router.refresh();
    })();
  }, [call.ended, router]);

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
              <div key={m.id}>
              <div
                id={`m-${m.id}`}
                className={`max-w-[85%] rounded-[14px] px-4 py-2.5 text-[15px] leading-relaxed transition-shadow ${
                  m.role === "user"
                    ? `ml-auto bg-bubble text-ink ${m.failed ? "opacity-70" : ""}`
                    : "border border-edge bg-surface"
                }`}
              >
                {m.mode === "voice" && (
                  <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-faint">
                    <Mic size={10} strokeWidth={2} /> {m.role === "user" ? "you" : secretaryName}
                  </span>
                )}
                {m.attachments && m.attachments.length > 0 && (
                  <span className="mb-1.5 flex flex-wrap gap-1.5">
                    {m.attachments.map((a) =>
                      a.mime === "application/pdf" ? (
                        <a
                          key={a.id}
                          href={`/api/attachments/${a.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1.5 rounded-lg border border-edge bg-card px-2.5 py-1.5 text-xs text-muted hover:text-ink"
                        >
                          <FileText size={13} strokeWidth={1.75} className="flex-none" />
                          <span className="max-w-[10rem] truncate">{a.name}</span>
                        </a>
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={a.id}
                          src={`/api/attachments/${a.id}`}
                          alt={a.name}
                          className="max-h-48 max-w-full rounded-lg border border-edge object-cover"
                        />
                      )
                    )}
                  </span>
                )}
                <span className="whitespace-pre-wrap">{m.content}</span>
              </div>
              {m.failed && (
                <button
                  onClick={() => void deliver(m.id)}
                  disabled={sending}
                  className="ml-auto mt-1 flex items-center gap-1 text-xs font-semibold text-danger disabled:opacity-50"
                >
                  <TriangleAlert size={11} strokeWidth={2.25} className="flex-none" />
                  {m.failed} — tap to retry
                </button>
              )}
              </div>
            ))}
          {call.active &&
            liveLines
              .filter((l) => l.text.trim())
              .map((l) => (
                <div
                  key={l.id}
                  className={`max-w-[85%] rounded-[14px] px-4 py-2.5 text-[15px] leading-relaxed ${
                    l.role === "user"
                      ? "ml-auto bg-bubble text-ink"
                      : "border border-edge bg-surface"
                  } ${l.final ? "" : "opacity-80"}`}
                >
                  <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-faint">
                    <Mic size={10} strokeWidth={2} className={l.final ? "" : "animate-pulse"} />
                    {l.role === "user" ? "you" : secretaryName}
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
            <div className="rounded-2xl border border-edge bg-surface px-2.5 py-2 shadow-sm transition-shadow focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
              {pending.length > 0 && (
                <div className="flex flex-wrap gap-2 px-1.5 pb-2 pt-1">
                  {pending.map((a) => (
                    <div
                      key={a.key}
                      className={`relative flex items-center gap-1.5 rounded-lg border px-1.5 py-1.5 text-xs ${
                        a.error ? "border-danger/50 bg-danger/10 text-danger" : "border-edge bg-card"
                      }`}
                    >
                      {a.previewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={a.previewUrl}
                          alt={a.name}
                          className="h-12 w-12 rounded object-cover"
                        />
                      ) : (
                        <FileText size={16} strokeWidth={1.75} className="mx-1 text-muted" />
                      )}
                      <span className="max-w-[8rem] truncate">
                        {a.error ?? a.name}
                        {!a.id && !a.error && <span className="animate-pulse"> ↑</span>}
                      </span>
                      <button
                        onClick={() => removePending(a.key)}
                        title="Remove"
                        aria-label={`Remove ${a.name}`}
                        className="flex h-5 w-5 flex-none items-center justify-center rounded-full text-muted hover:text-ink"
                      >
                        <X size={12} strokeWidth={2.5} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
                className="max-h-[140px] w-full resize-none bg-transparent px-1.5 py-1.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint"
              />
              {/* Controls row (Claude-app style): attach + model chip left,
                  voice/send right — the chip never fights the textarea for width. */}
              <div className="flex items-center gap-1.5 pt-1">
              <input
                ref={fileRef}
                type="file"
                // image/* makes iOS offer Take Photo / Photo Library natively
                accept="image/*,application/pdf"
                multiple
                className="hidden"
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={pending.length >= MAX_ATTACHMENTS}
                title="Attach a photo or file"
                aria-label="Attach a photo or file"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
              >
                <Paperclip size={18} strokeWidth={1.75} />
              </button>
              <ModelChip initialModel={initialChatModel} initialEffort={initialChatEffort} />
              <div className="min-w-0 flex-1" />
              {input.trim() || pending.some((a) => a.id) ? (
                <button
                  onClick={send}
                  disabled={sending || pending.some((a) => !a.id && !a.error)}
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
                      // global call, PILL-FIRST (user ask, Aug 26): Talk drops
                      // into the minimal bar so the screen stays usable — the
                      // full call view is opt-in via the expand button.
                      call.begin({
                        voice: defaultVoice,
                        effort: defaultVoiceEffort,
                        minimized: true,
                      });
                    }}
                    disabled={call.active}
                    title="Start a live voice conversation"
                    aria-label="Start a live voice conversation"
                    className="flex h-9 flex-none items-center gap-1.5 rounded-full bg-accent px-3.5 text-sm font-bold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    <WaveformGlyph />
                    Talk
                  </button>
                </>
              )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
