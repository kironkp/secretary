"use client";

// The chat thread, dock-shaped (SPEC §7.7): the composer is the always-visible
// bar; the conversation lives in a panel that rises above it. Three states —
// bar (composer only), peek (the exchange since the dock last opened), full
// (whole history + briefing). The caret expands and minimizes.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUp,
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Flame,
  Mic,
  Paperclip,
  Plus,
  Sparkles,
  Sun,
  TriangleAlert,
  X,
} from "lucide-react";
import type { BriefingCard } from "@/lib/secretary/briefing";
import { INLINE_MIME } from "@/lib/attachments";
import { requestCanvasRefresh } from "@/lib/canvas/refresh";
import { unlockRemoteAudio } from "@/lib/realtime/remote-audio";
import { AttachSheet } from "./attach-sheet";
import { DictationBar } from "./dictation-bar";
import { ModelChip, useChatModel } from "./model-chip";
import { useVoiceCall } from "./voice-call-provider";

export type DockState = "bar" | "peek" | "full";

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
  size: number;
  previewUrl: string | null; // object URL for images
  id: string | null; // server id once uploaded
  error: string | null;
};

const MAX_ATTACHMENTS = 4;
const IMAGE_MAX_EDGE = 1600;

/** Raster types Safari can decode into a canvas — the only files normalizeImage
 *  may touch. HEIC/HEIF included: with no `accept` attribute iOS stops
 *  transcoding for us, so a Files-app pick can now be a real .heic and Safari
 *  decodes it natively. SVG is excluded on purpose: it's markup, and it travels
 *  to the server as opaque bytes. */
const RASTER_MIME = /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i;
const RASTER_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i;

function isRasterImage(f: File): boolean {
  if (f.type === "image/svg+xml") return false;
  // iOS hands back an empty type for some Files-app picks — fall back to name.
  return f.type ? RASTER_MIME.test(f.type) : RASTER_EXT.test(f.name);
}

// Only consulted when the browser gives us no type at all.
const EXT_MIME: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
};

function mimeOf(f: File): string {
  if (f.type) return f.type;
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A glyph that tells you what the file is before you read its name. */
function TypeIcon({ mime, name, size = 20 }: { mime: string; name: string; size?: number }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const is = (...x: string[]) => x.includes(ext);
  const cls = "text-muted";
  if (is("xlsx", "xls", "csv", "numbers") || mime.includes("spreadsheet"))
    return <FileSpreadsheet size={size} strokeWidth={1.75} className={cls} />;
  if (mime === "application/pdf" || is("pdf", "doc", "docx", "txt", "md", "rtf", "pages"))
    return <FileText size={size} strokeWidth={1.75} className={cls} />;
  if (is("zip", "rar", "7z", "tar", "gz"))
    return <FileArchive size={size} strokeWidth={1.75} className={cls} />;
  if (is("json", "js", "ts", "html", "xml", "yml", "yaml", "css", "py", "sh"))
    return <FileCode size={size} strokeWidth={1.75} className={cls} />;
  if (mime.startsWith("image/")) return <FileImage size={size} strokeWidth={1.75} className={cls} />;
  if (mime.startsWith("video/")) return <FileVideo size={size} strokeWidth={1.75} className={cls} />;
  if (mime.startsWith("audio/")) return <FileAudio size={size} strokeWidth={1.75} className={cls} />;
  return <FileIcon size={size} strokeWidth={1.75} className={cls} />;
}

/** Downscale + JPEG-encode a picked image (handles HEIC on iOS — Safari
 *  decodes it natively, and the canvas re-encodes to a mime the model takes).
 *  Returns null when the bytes won't decode: the caller then uploads the
 *  ORIGINAL under its real type and name, because claiming image/jpeg for
 *  something the canvas never re-encoded is how a file gets corrupted. */
async function normalizeImage(file: File): Promise<Blob | null> {
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
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85)
    );
  } catch {
    return null;
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
  dock,
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
  /** Dock mode (SPEC §7.7): parent owns the bar/peek/full state; the thread
   *  renders as a panel above the composer and drives sends → peek. */
  dock?: { state: DockState; setState: (s: DockState) => void };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [conversationId, setConversationId] = useState(initialConversationId);
  // The model and effort, shared by the composer's chip and the Attach
  // sheet's Model row so a pick in either is what the other shows.
  const chatModel = useChatModel(initialChatModel, initialChatEffort);
  // The Attach sheet (the ask bar's plus). `?attach=open` opens it on load in
  // development only: the sheet is state inside the client, and a screenshot
  // harness cannot tap the plus. Harmless elsewhere: the param is ignored.
  const [attachOpen, setAttachOpen] = useState(
    () => process.env.NODE_ENV === "development" && params.get("attach") === "open"
  );
  const closeAttach = useCallback(() => setAttachOpen(false), []);
  const plusRef = useRef<HTMLButtonElement>(null);
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
  // Attachment slots held, tracked synchronously — see addFiles.
  const slotsTaken = useRef(0);
  const dockState: DockState = dock?.state ?? "full";
  // Peek window: index of the first message shown in peek — set at the send
  // that opens it, so peek is "what happened since I opened the dock".
  const peekFrom = useRef(0);

  // Auto-open Canvas (SPEC §7.6): navigate to the Canvas TAB — the real page,
  // nav intact. The dock collapses all the way to the bar: the paint IS the
  // answer, so nothing may sit on top of it.
  const showCanvas = () => {
    // The push below is a no-op when the Canvas tab is already open — which is
    // precisely when the user is watching — so nudge the view to reload now.
    requestCanvasRefresh();
    dock?.setState("bar");
    router.push("/canvas");
  };

  // Pick/paste/drop → normalize photos (≤1600px JPEG) → upload right away; the
  // send only passes ids. Any file type is accepted; what the model can do with
  // it is decided server-side. Failed uploads show inline, never block the text.
  const addFiles = async (files: FileList | File[] | null) => {
    if (!files) return;
    const incoming = Array.from(files as ArrayLike<File>);
    if (incoming.length === 0) return;

    // Reserve slots synchronously against a ref. `pending` is a render-closure
    // value, so two calls in the same tick (picker + paste, or paste + drop)
    // would each read the same stale length and both admit a full batch.
    const room = Math.max(0, MAX_ATTACHMENTS - slotsTaken.current);
    if (room === 0) {
      setError(`Up to ${MAX_ATTACHMENTS} attachments.`);
      return;
    }
    const admitted = incoming.slice(0, room);
    slotsTaken.current += admitted.length;
    if (incoming.length > admitted.length) {
      setError(`Attached the first ${room} — ${MAX_ATTACHMENTS} files max.`);
    }

    // Concurrent: each chip owns its state by key, and four uploads shouldn't
    // queue behind each other on a phone connection.
    await Promise.all(
      admitted.map(async (file) => {
        const key = ++localKey.current;
        const raster = isRasterImage(file);
        const originalName = file.name || (raster ? "photo" : "file");
        const entry: PendingAttachment = {
          key,
          name: originalName,
          mime: mimeOf(file),
          size: file.size,
          previewUrl: null,
          id: null,
          error: null,
        };
        setPending((p) => [...p, entry]);
        try {
          // Only claim image/jpeg when the canvas actually re-encoded — a HEIC
          // that fails to decode uploads as itself rather than as a lie.
          const encoded = raster ? await normalizeImage(file) : null;
          const blob: Blob = encoded ?? file;
          const name = encoded ? originalName.replace(/\.\w+$/, "") + ".jpg" : originalName;
          const mime = encoded ? "image/jpeg" : entry.mime;
          if (raster) {
            const previewUrl = URL.createObjectURL(blob);
            setPending((p) =>
              p.map((a) =>
                a.key === key ? { ...a, previewUrl, name, mime, size: blob.size } : a
              )
            );
          }
          const form = new FormData();
          form.append("file", new File([blob], name, { type: mime }));
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
      })
    );
  };

  const removePending = (key: number) => {
    setPending((p) => {
      const gone = p.find((a) => a.key === key);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      if (gone) slotsTaken.current = Math.max(0, slotsTaken.current - 1);
      return p.filter((a) => a.key !== key);
    });
  };

  // Paste-to-attach. The clipboard must be read SYNCHRONOUSLY — DataTransfer is
  // neutered the moment this handler returns — so collect Files first, upload
  // after. A text or rich-text paste carries no File and falls straight through
  // to the browser's own insert (and its undo).
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = e.clipboardData;
    if (!dt) return;
    let picked: File[] = Array.from(dt.files ?? []);
    if (picked.length === 0 && dt.items) {
      picked = Array.from(dt.items)
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
    }
    if (picked.length === 0) {
      // iOS can announce "Files" on the pasteboard while handing over a file
      // promise WebKit won't materialize. Say so rather than dropping it
      // silently — but never preventDefault: there may be real text too.
      if (Array.from(dt.types ?? []).includes("Files")) {
        setError("Couldn't read that file from the clipboard — use the paperclip.");
      }
      return;
    }
    // A file paste is an attach, not an insert: stop the default so a filename
    // never lands in the textarea.
    e.preventDefault();
    setError("");
    void addFiles(picked);
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

  // Opening the panel (bar → peek/full) must land at the newest message —
  // instant, because the panel itself is already animating its height.
  useEffect(() => {
    if (dockState !== "bar") bottomRef.current?.scrollIntoView();
  }, [dockState]);

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
      const uiActions = (body.uiActions ?? []) as { type: string }[];
      if (uiActions.some((a) => a.type === "show_canvas")) showCanvas();
      router.refresh(); // today strip + dashboard counts
    } catch {
      setMsgs((m) =>
        m.map((msg) => (msg.id === tempId ? { ...msg, failed: "Not delivered" } : msg))
      );
    } finally {
      setSending(false);
    }
  };

  // override: text to send in place of the input (dictation's Send button).
  const send = async (override?: string) => {
    const text = (override ?? input).trim();
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
    slotsTaken.current = 0;
    // Sending from the closed bar opens the peek window at THIS message: the
    // answer pops up above the composer without dragging in the whole thread.
    if (dock && dock.state === "bar") {
      peekFrom.current = msgs.length;
      dock.setState("peek");
    }
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
  // Peek is deliberately ONE message — the latest thing said, by either of us,
  // and nothing else. It is a glance, not a transcript: no header, no briefing,
  // no scrollback. Anything more and it competes with the canvas it floats
  // over. Tap it to open the full conversation.
  const shownMsgs = dockState === "peek" ? msgs.slice(-1) : msgs;
  const showExtras = dockState !== "peek"; // briefing + empty state

  // The conversation panel: a card that rises above the composer. Height (not
  // scale) animates between the three states so the composer never moves.
  const panelClass = dock
    ? `flex min-h-0 flex-none flex-col overflow-hidden rounded-2xl border bg-surface transition-all duration-300 ease-out motion-reduce:transition-none ${
        dockState === "bar"
          ? "pointer-events-none h-0 border-transparent opacity-0"
          : dockState === "peek"
            ? // Sized to its one message rather than a fixed slab, so a short
              // reply is a small card instead of a mostly-empty panel.
              "mb-2 max-h-[min(32dvh,18rem)] border-edge opacity-100 shadow-2xl"
            : "mb-2 h-[min(78dvh,46rem)] border-edge opacity-100 shadow-2xl"
      }`
    : "flex min-h-0 flex-1 flex-col";

  return (
    <div className="flex h-full min-h-0 flex-col justify-end">
      <div className={panelClass} aria-hidden={dock ? dockState === "bar" : undefined}>
        {/* No header in peek: it is one message, and a title bar over a single
            line is more chrome than content. Full keeps it. */}
        {dock && dockState === "full" && (
          <div className="flex flex-none items-center justify-between border-b border-edge bg-card px-4 py-2">
            <span className="text-sm font-bold">{secretaryName}</span>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => dock.setState("bar")}
                title="Minimize"
                aria-label="Minimize chat"
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <ChevronDown size={16} strokeWidth={2} />
              </button>
            </div>
          </div>
        )}
      <div
        onClick={dock && dockState === "peek" ? () => dock.setState("full") : undefined}
        className={`min-h-0 flex-1 overflow-y-auto [-webkit-overflow-scrolling:touch] ${
          dock && dockState === "peek" ? "cursor-pointer py-3" : "py-5"
        }`}
      >
        <div className="mx-auto w-full max-w-2xl space-y-4 px-4">
          {showExtras && hasBriefing && (
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

          {showExtras && msgs.length === 0 && !hasBriefing && (
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

          {shownMsgs
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
                    {/* Keyed on the SAME inline set the serving route uses:
                        anything else comes back as octet-stream and would
                        render as a broken <img>. */}
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
                      ) : INLINE_MIME.has(a.mime) ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          key={a.id}
                          src={`/api/attachments/${a.id}`}
                          alt={a.name}
                          className="max-h-48 max-w-full rounded-lg border border-edge object-cover"
                        />
                      ) : (
                        <a
                          key={a.id}
                          href={`/api/attachments/${a.id}?download=1`}
                          className="flex items-center gap-1.5 rounded-lg border border-edge bg-card px-2.5 py-1.5 text-xs text-muted hover:text-ink"
                        >
                          <TypeIcon mime={a.mime} name={a.name} size={13} />
                          <span className="max-w-[10rem] truncate">{a.name}</span>
                        </a>
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
      </div>

      <div className={`flex-none ${dock ? "" : "pb-[max(env(safe-area-inset-bottom),1rem)] pt-1"}`}>
        <div className="mx-auto max-w-2xl px-1">
          {error && <p className="mb-2 text-xs text-danger">{error}</p>}

          {mode === "dictation" ? (
            <DictationBar
              onCancel={() => setMode("idle")}
              onText={(text, andSend) => {
                const full = input ? `${input} ${text}` : text;
                setMode("idle");
                if (andSend) void send(full);
                else setInput(full);
              }}
              onError={(message) => {
                setError(message);
                setMode("idle");
              }}
            />
          ) : dock && dockState === "bar" ? (
            // The ask bar from the "Secretary on iPhone" mockup: a plus, the
            // field, the mic. The plus opens the mockup's Attach sheet
            // (attach-sheet.tsx): Photo Library, Take Photo, Choose File, the
            // Model row, Cancel. A chosen file opens the full composer so it
            // can be seen and sent. The field opens the full composer with
            // the cursor in it; the model chip lives there. The mic is Talk.
            <div className="flex items-center gap-2.5 py-2.5" data-testid="ask-bar">
              <AttachSheet
                open={attachOpen}
                onClose={closeAttach}
                onFiles={(files) => {
                  void addFiles(files);
                  dock.setState("full");
                }}
                selection={chatModel}
                restoreFocusTo={plusRef}
              />
              <button
                ref={plusRef}
                type="button"
                onClick={() => setAttachOpen(true)}
                disabled={pending.length >= MAX_ATTACHMENTS}
                aria-haspopup="dialog"
                aria-expanded={attachOpen}
                title="Add a photo or file"
                aria-label="Add a photo or file"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-surface-2 text-ink disabled:opacity-40"
              >
                <Plus size={18} strokeWidth={2} />
              </button>
              <button
                type="button"
                onClick={() => {
                  dock.setState("full");
                  setTimeout(() => inputRef.current?.focus(), 60);
                }}
                className="flex h-11 min-w-0 flex-1 items-center rounded-full bg-surface-2 px-4 text-left text-[17px] text-faint"
              >
                Ask your secretary
              </button>
              <button
                type="button"
                onClick={() => {
                  unlockRemoteAudio();
                  call.begin({
                    voice: defaultVoice,
                    effort: defaultVoiceEffort,
                    minimized: true,
                  });
                }}
                disabled={call.active}
                title="Start a live voice conversation"
                aria-label="Start a live voice conversation"
                className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent text-white disabled:opacity-50"
              >
                <Mic size={22} strokeWidth={2} />
              </button>
            </div>
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
                        <span className="flex h-12 w-12 flex-none items-center justify-center rounded bg-surface-2">
                          <TypeIcon mime={a.mime} name={a.name} />
                        </span>
                      )}
                      <span className="flex min-w-0 flex-col">
                        {/* Truncate the stem, keep the extension — on a
                            "Weekly Status Report.xlsx" the suffix is the part
                            that tells you which file this is. */}
                        <span className="flex min-w-0 max-w-[9rem]">
                          <span className="truncate">{a.name.replace(/\.\w+$/, "")}</span>
                          <span className="flex-none">{(a.name.match(/\.\w+$/) ?? [""])[0]}</span>
                        </span>
                        <span className="text-[10px] text-faint">
                          {a.error ? a.error : a.id ? formatBytes(a.size) : "uploading…"}
                        </span>
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
                onPaste={onPaste}
                placeholder="Message your secretary…"
                className="max-h-[140px] w-full resize-none bg-transparent px-1.5 py-1.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint"
              />
              {/* Controls row (Claude-app style): attach + model chip left,
                  voice/send right — the chip never fights the textarea for width. */}
              <div className="flex items-center gap-1.5 pt-1">
              <input
                ref={fileRef}
                type="file"
                // No `accept`: iOS maps each accept entry to a UTI and greys out
                // everything unmapped — that's why .xlsx was unselectable. "*/*"
                // isn't mappable and behaves inconsistently across iOS versions;
                // omitting the attribute is what presents the picker as
                // public.item. Take Photo / Photo Library survive — accept
                // narrowed that sheet, it didn't create it.
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
                title="Attach a file"
                aria-label="Attach a file"
                className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40"
              >
                <Paperclip size={18} strokeWidth={1.75} />
              </button>
              <ModelChip selection={chatModel} />
              <div className="min-w-0 flex-1" />
              {dock && (
                <button
                  onClick={() => dock.setState(dockState === "bar" ? "full" : "bar")}
                  title={dockState === "bar" ? "Show conversation" : "Minimize chat"}
                  aria-label={dockState === "bar" ? "Show conversation" : "Minimize chat"}
                  className="flex h-9 w-9 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  {dockState === "bar" ? (
                    <ChevronUp size={18} strokeWidth={2} />
                  ) : (
                    <ChevronDown size={18} strokeWidth={2} />
                  )}
                </button>
              )}
              {input.trim() || pending.some((a) => a.id) ? (
                <button
                  onClick={() => send()}
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
