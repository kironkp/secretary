"use client";

// Floating chat: the secretary from any page — most usefully the Canvas,
// where "make the album section bigger" should land while you watch. Same
// conversation and /api/chat contract as the Chat tab; hidden there since the
// full thread is the page. State survives collapse (the panel just hides).
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUp, MessageCircle, X } from "lucide-react";

type Message = { id: string; role: "user" | "assistant" | "tool"; content: string };

export function FloatingChat({
  initialConversationId,
  initialMessages,
}: {
  initialConversationId: string | null;
  initialMessages: Message[];
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Message[]>(initialMessages);
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const localKey = useRef(0);

  useEffect(() => {
    if (open) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [open, msgs.length]);

  if (pathname.startsWith("/chat")) return null;

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setText("");
    setError("");
    setSending(true);
    const tempId = `float-${++localKey.current}`;
    setMsgs((m) => [...m, { id: tempId, role: "user", content: message }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversationId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Message failed — try again.");
        return;
      }
      setConversationId(body.conversationId);
      setMsgs((m) => [
        ...m.map((msg) => (msg.id === tempId ? { ...msg, id: body.userMessageId } : msg)),
        { id: body.assistantMessage.id, role: "assistant", content: body.assistantMessage.content },
      ]);
      router.refresh(); // canvas/dashboard reflect whatever the tools changed
    } catch {
      setError("Message failed — check your connection.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="Chat with your secretary"
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white shadow-lg transition-transform hover:scale-105"
        >
          <MessageCircle size={20} aria-hidden />
        </button>
      )}
      <div
        className={`fixed bottom-5 right-5 z-40 flex w-[24rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-edge bg-surface shadow-2xl transition-all ${
          open ? "h-[32rem] max-h-[75vh] opacity-100" : "pointer-events-none h-0 opacity-0"
        }`}
      >
        <div className="flex flex-none items-center justify-between border-b border-edge bg-card px-4 py-2.5">
          <span className="text-sm font-bold">Secretary</span>
          <button onClick={() => setOpen(false)} className="text-muted hover:text-ink">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {msgs.filter((m) => m.role !== "tool").length === 0 && (
            <p className="pt-8 text-center text-xs text-muted">
              Ask anything — &ldquo;paint my week&rdquo;, &ldquo;make the album section
              bigger&rdquo;, &ldquo;what&rsquo;s due Friday?&rdquo;
            </p>
          )}
          {msgs
            .filter((m) => m.role !== "tool")
            .slice(-40)
            .map((m) => (
              <p
                key={m.id}
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "ml-auto rounded-br-md bg-accent text-white"
                    : "mr-auto rounded-bl-md border border-edge bg-card"
                }`}
              >
                {m.content}
              </p>
            ))}
          {sending && <p className="mr-auto animate-pulse text-xs text-muted">thinking…</p>}
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
        <div className="flex flex-none items-end gap-2 border-t border-edge bg-card p-2.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Message your secretary…"
            className="max-h-28 min-h-9 flex-1 resize-none rounded-xl border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <button
            onClick={() => void send()}
            disabled={sending || !text.trim()}
            className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-accent text-white disabled:opacity-40"
          >
            <ArrowUp size={16} aria-hidden />
          </button>
        </div>
      </div>
    </>
  );
}
