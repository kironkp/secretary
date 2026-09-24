"use client";

// The chat thread, dock-shaped (SPEC §7.7): the composer is the always-visible
// bar; the conversation lives in a panel that rises above it. Three states —
// bar (composer only), peek (the exchange since the dock last opened), full
// (whole history + briefing). The caret expands and minimizes.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUp,
  Calendar,
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
import { useChatModel } from "./model-chip";
import { CALL_GLOW, CALL_GLOW_SMALL } from "./call-look";
import { MessageActions } from "./message-actions";
import { useVoiceCall } from "./voice-call-provider";

export type DockState = "closed" | "bar" | "full";

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

// The card's motion is the app's (nav-tabs.tsx): 340ms on the leading curve.
const MOVE_MS = 340;
const MOVE_EASE = "cubic-bezier(0.22, 0.9, 0.32, 1)";

const REDUCED = "(prefers-reduced-motion: reduce)";
/** prefers-reduced-motion, live. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCED);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false
  );
}
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
  const localKey = useRef(0);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  // Attachment slots held, tracked synchronously — see addFiles.
  const slotsTaken = useRef(0);
  const dockState: DockState = dock?.state ?? "full";

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
    // A send from the pill grows it into the conversation, the way Gemini's
    // does: the answer arrives where the user can read it.
    if (dock && dock.state !== "full") dock.setState("full");
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

  // --- the card's geometry (SPEC §7.7): shell-owned, never a model call ---
  // One card is both the pill and the conversation: the conversation area
  // above the composer is 0 tall in the bar and fullH in full, and while a
  // finger is on the handle it is exactly where the finger puts it. The
  // conversation fades as it shrinks; past halfway it has faded out.
  const [fullH, setFullH] = useState(560);
  useEffect(() => {
    const measure = () => setFullH(Math.round(Math.min(window.innerHeight * 0.66, 680)));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const [dragH, setDragH] = useState<number | null>(null);
  const drag = useRef<{ y0: number; h0: number; lastY: number; lastT: number; v: number; moved: boolean } | null>(
    null
  );
  const targetH = dockState === "full" ? fullH : 0;
  const panelH = dragH ?? targetH;
  const progress = fullH ? Math.min(1, Math.max(0, panelH / fullH)) : 0;
  const contentOpacity = Math.min(1, Math.max(0, (progress - 0.35) / 0.5));
  const reduceMotion = useReducedMotion();
  const settle = reduceMotion ? "none" : `height ${MOVE_MS}ms ${MOVE_EASE}`;

  const onHandleDown = (e: React.PointerEvent) => {
    if (!dock) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y0: e.clientY, h0: targetH, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y0;
    if (Math.abs(dy) > 4) d.moved = true;
    const dt = Math.max(1, e.timeStamp - d.lastT);
    d.v = (e.clientY - d.lastY) / dt; // px/ms, + is downward
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    if (d.moved) setDragH(Math.min(fullH, Math.max(0, d.h0 - dy)));
  };
  const onHandleUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !dock) return;
    if (!d.moved) {
      // A tap on the handle toggles, the way a tap on a sheet's grabber does.
      dock.setState(dockState === "full" ? "bar" : "full");
    } else {
      const h = dragH ?? d.h0;
      // A flick decides by direction; otherwise the nearer end wins.
      const open = d.v > 0.5 ? false : d.v < -0.5 ? true : h > fullH / 2;
      dock.setState(open ? "full" : "bar");
    }
    setDragH(null);
  };
  // A swipe up on the pill itself (not just the grabber). With a
  // conversation to show, it grows the pill back into it, following the
  // finger; with none yet, it raises the keyboard (Gemini does both).
  // touch-none on the pill is what makes this reach us at all: without it
  // iOS takes a vertical swipe as a page scroll and cancels the pointer.
  const hasConversation = msgs.some((m) => m.role !== "tool");
  const swipe = useRef<{ y0: number; id: number } | null>(null);
  const onPillDown = (e: React.PointerEvent) => {
    if (dockState !== "bar" || drag.current) return;
    swipe.current = { y0: e.clientY, id: e.pointerId };
  };
  const onPillMove = (e: React.PointerEvent) => {
    const sw = swipe.current;
    if (!sw || drag.current || !hasConversation) {
      if (drag.current) onHandleMove(e);
      return;
    }
    // Past a small upward threshold, the swipe becomes a drag of the card.
    if (sw.y0 - e.clientY > 10) {
      e.currentTarget.setPointerCapture(sw.id);
      drag.current = { y0: sw.y0, h0: 0, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: true };
      onHandleMove(e);
    }
  };
  const onPillUp = (e: React.PointerEvent) => {
    const sw = swipe.current;
    swipe.current = null;
    if (drag.current) {
      onHandleUp();
      return;
    }
    if (sw && !hasConversation && sw.y0 - e.clientY > 24) inputRef.current?.focus();
  };

  const canSend = !!input.trim() || pending.some((a) => a.id);

  return (
    <>
      {dock &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            aria-hidden
            onClick={() => dock.setState("bar")}
            className={`fixed inset-0 z-20 bg-black ${progress > 0.02 ? "" : "pointer-events-none"}`}
            style={{
              opacity: 0.35 * progress,
              transition: dragH === null && !reduceMotion ? `opacity ${MOVE_MS}ms ${MOVE_EASE}` : "none",
            }}
          />,
          document.body
        )}
      <div
        data-theme="dark"
        data-testid="chat-card"
        data-dock={dockState}
        className={`animate-slide-up relative mb-2 flex flex-col overflow-hidden rounded-[26px] bg-black font-sans text-ink ${
          dock ? "" : "min-h-0 flex-1"
        }`}
        style={{
          boxShadow: `${progress > 0.5 ? CALL_GLOW : CALL_GLOW_SMALL}, 0 18px 50px rgba(0,0,0,0.35)`,
          transition: reduceMotion ? undefined : `box-shadow ${MOVE_MS}ms ${MOVE_EASE}`,
        }}
      >
        {/* The grabber: drag it and the card follows the finger. */}
        <div
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          role="button"
          tabIndex={0}
          aria-label={dockState === "full" ? "Drag down to shrink the conversation" : "Drag up to show the conversation"}
          onKeyDown={(e) => {
            if (dock && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              dock.setState(dockState === "full" ? "bar" : "full");
            }
          }}
          className="-mb-1 flex h-7 flex-none cursor-grab touch-none items-center justify-center active:cursor-grabbing"
        >
          <span className="h-[5px] w-10 rounded-full bg-faint/60" />
        </div>

        <div
          aria-hidden={dock ? progress < 0.05 : undefined}
          className="flex min-h-0 flex-col overflow-hidden"
          style={dock ? { height: panelH, transition: dragH === null ? settle : "none" } : { flex: 1 }}
        >
          <div className="flex min-h-0 flex-1 flex-col" style={{ opacity: dock ? contentOpacity : 1 }}>
            {/* The header drags too, and its x closes the chat. */}
            <div
              onPointerDown={onHandleDown}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
              className="flex flex-none touch-none items-center justify-between px-4 pb-1"
            >
              <span className="text-[15px] font-semibold">{secretaryName}</span>
              {dock && (
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => dock.setState("closed")}
                  title="Close"
                  aria-label="Close chat"
                  className="flex h-9 w-9 items-center justify-center rounded-full text-faint transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <X size={18} strokeWidth={2} />
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 [-webkit-overflow-scrolling:touch]">
              <div className="mx-auto w-full max-w-2xl space-y-4 px-4">
          {hasBriefing && (
            <div className="rounded-2xl bg-surface-2/70 p-5">
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
            <div className="flex flex-col items-center gap-3 pt-16 text-center">
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
              <div key={m.id} className={m.role === "user" ? "flex flex-col items-end" : ""}>
              <div
                id={`m-${m.id}`}
                className={`rounded-[18px] text-[16px] leading-[1.45] transition-shadow ${
                  m.role === "user"
                    ? `max-w-[85%] bg-surface-2 px-4 py-2.5 text-ink ${m.failed ? "opacity-70" : ""}`
                    : "max-w-[94%]"
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
              {m.role === "assistant" && m.content.trim() && (
                <MessageActions id={m.id} text={m.content} voice={defaultVoice} className="-ml-2 mt-0.5" />
              )}
              {m.failed && (
                <button
                  onClick={() => void deliver(m.id)}
                  disabled={sending}
                  className="mt-1 flex items-center gap-1 text-xs font-semibold text-danger disabled:opacity-50"
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
                  className={`rounded-[18px] text-[16px] leading-[1.45] ${
                    l.role === "user" ? "ml-auto max-w-[85%] bg-surface-2 px-4 py-2.5 text-ink" : "max-w-[94%]"
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
            <div className="text-[16px] text-faint">
              <span className="animate-pulse">…</span>
            </div>
          )}
          <div ref={bottomRef} />
              </div>
            </div>
          </div>
        </div>

        {/* The composer: the same row in the pill and under the conversation.
            + (Photos · Camera · Files · Model), the field, dictation, the
            voice call — or send once there is something to send — and, in
            the pill, x to put the chat away. */}
        <div
          className={`flex-none px-2 pb-2 pt-1 ${dockState === "bar" ? "touch-none" : ""}`}
          onPointerDown={onPillDown}
          onPointerMove={onPillMove}
          onPointerUp={onPillUp}
          onPointerCancel={onPillUp}
        >
          {error && <p className="px-2 pb-1.5 text-xs text-danger">{error}</p>}
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
          ) : (
            <>
              {pending.length > 0 && (
                <div className="flex flex-wrap gap-2 px-1 pb-2 pt-1">
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
              <div className="flex items-end gap-1" data-testid="ask-bar">
                <AttachSheet
                  open={attachOpen}
                  onClose={closeAttach}
                  onFiles={(files) => void addFiles(files)}
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
                  className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-ink transition-colors hover:bg-surface-2 disabled:opacity-40"
                >
                  <Plus size={22} strokeWidth={1.9} />
                </button>
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
                      void send();
                    }
                  }}
                  onPaste={onPaste}
                  placeholder="Ask your secretary"
                  aria-label="Ask your secretary"
                  // The field is its own scroll container, so the pill's
                  // touch-none does not reach through it: in the pill it needs
                  // its own, or a swipe that starts on it is a cancelled scroll.
                  className={`max-h-[140px] min-h-11 min-w-0 flex-1 resize-none bg-transparent px-1 py-[11px] text-[17px] leading-[1.3] text-ink outline-none placeholder:text-faint ${
                    dockState === "bar" ? "touch-none" : ""
                  }`}
                />
                {canSend ? (
                  <button
                    onClick={() => void send()}
                    disabled={sending || pending.some((a) => !a.id && !a.error)}
                    title="Send"
                    aria-label="Send message"
                    className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    <ArrowUp size={20} strokeWidth={2.25} />
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => setMode("dictation")}
                      title="Dictate a message"
                      aria-label="Dictate a message"
                      className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-ink transition-colors hover:bg-surface-2"
                    >
                      <Mic size={20} strokeWidth={1.9} />
                    </button>
                    <button
                      onClick={() => {
                        // must run synchronously inside the tap: iOS only allows
                        // audio playback that a user gesture unlocked
                        unlockRemoteAudio();
                        // global call, PILL-FIRST (user ask, Aug 26)
                        call.begin({ voice: defaultVoice, effort: defaultVoiceEffort, minimized: true });
                      }}
                      disabled={call.active}
                      title="Start a live voice conversation"
                      aria-label="Start a live voice conversation"
                      className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-accent text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      <WaveformGlyph size={20} />
                    </button>
                  </>
                )}
                {dock && dockState === "bar" && (
                  <button
                    onClick={() => dock.setState("closed")}
                    title="Close"
                    aria-label="Close chat"
                    className="flex h-11 w-9 flex-none items-center justify-center rounded-full text-faint transition-colors hover:text-ink"
                  >
                    <X size={20} strokeWidth={2} />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
