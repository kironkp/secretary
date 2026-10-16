"use client";

// The "nothing is write-only" dialog: any row anywhere can dispatch
// secretary:open-detail (via openDetail() in dashboard/shared) and this
// shows everything stored about the task or event. A task opens the task
// screen (task-screen.tsx, v1.10: the approved 1-task.html, with the rest
// under "More"); an event keeps this modal. Mounted once in the app shell;
// re-fetches on window focus so live updates don't show stale detail.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlarmClock, Calendar, MapPin, MessageSquare, X } from "lucide-react";
import { Row, fmtFull } from "./detail-parts";
import { TaskScreen, TaskScreenLoading, type TaskDetail } from "./task-screen";

type EventDetail = {
  kind: "event";
  event: {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string | null;
    location: string | null;
    notes: string | null;
    reminders: string[];
    source: string;
    createdAt: string;
    conversationId: string | null;
    messageId: string | null;
  };
};

type Detail = TaskDetail | EventDetail;

export function DetailDialog() {
  const [target, setTarget] = useState<{ kind: "task" | "event"; id: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(false);
  // Every open is a fresh task screen: its note draft, its picker and "More" start closed (docs/tasks/SPEC.md §2.4).
  const [opens, setOpens] = useState(0);

  const load = useCallback(async (kind: "task" | "event", id: string) => {
    try {
      const res = await fetch(kind === "task" ? `/api/tasks/${id}` : `/api/events/${id}`);
      if (!res.ok) {
        setError(true);
        setDetail(null);
        return;
      }
      const body = await res.json();
      setError(false);
      setDetail(kind === "task" ? { kind, ...body } : { kind, event: body.event });
    } catch {
      setError(true);
    }
  }, []);

  // The click that opened the dialog must not also close it. On touch a
  // browser sends its compatibility click after the pointer events, so an
  // opener that acts on pointerup puts the backdrop under that click (sec
  // rev, SEC-A009: open, then shut ~9 ms later). Openers act on click; this
  // is the backstop for any that don't.
  const openedAt = useRef(0);
  const backdropReady = useCallback(() => performance.now() - openedAt.current >= 400, []);
  const closeFromBackdrop = () => {
    if (!backdropReady()) return;
    setTarget(null);
  };

  useEffect(() => {
    const onOpen = (e: Event) => {
      const { kind, id } = (e as CustomEvent).detail as { kind: "task" | "event"; id: string };
      openedAt.current = performance.now();
      setTarget({ kind, id });
      setDetail(null);
      setError(false);
      setOpens((n) => n + 1);
      void load(kind, id);
    };
    window.addEventListener("secretary:open-detail", onOpen);
    return () => window.removeEventListener("secretary:open-detail", onOpen);
  }, [load]);

  // stay honest under live refresh: re-pull while open on window focus
  useEffect(() => {
    if (!target) return;
    const onFocus = () => void load(target.kind, target.id);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [target, load]);

  // Escape closes an event (the task screen handles its own: a note draft is saved first).
  const isTask = detail?.kind === "task";
  useEffect(() => {
    if (!target || isTask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, isTask]);

  if (!target) return null;

  // A task opens in its own sheet from the start: no other dialog while it loads (docs/tasks/SPEC.md §2.4).
  if (target.kind === "task" && !detail && !error) {
    return <TaskScreenLoading onClose={() => setTarget(null)} backdropReady={backdropReady} />;
  }

  if (detail?.kind === "task") {
    return (
      <TaskScreen
        key={opens}
        detail={detail}
        onChange={(task) => setDetail((d) => (d?.kind === "task" ? { ...d, task: { ...d.task, ...task } } : d))}
        onReload={() => void load("task", detail.task.id)}
        onClose={() => setTarget(null)}
        backdropReady={backdropReady}
      />
    );
  }

  const provenance = (conversationId: string | null, messageId: string | null, label: string) =>
    conversationId ? (
      <Link
        href={`/chat?c=${conversationId}${messageId ? `&m=${messageId}` : ""}`}
        onClick={() => setTarget(null)}
        className="inline-flex items-center gap-1.5 text-accent hover:underline"
      >
        <MessageSquare size={13} strokeWidth={1.75} />
        {label}
      </Link>
    ) : (
      <span className="text-faint">—</span>
    );

  const reminderChips = (reminders: string[]) =>
    reminders.length === 0 ? (
      <span className="text-faint">none</span>
    ) : (
      <span className="flex flex-wrap gap-1.5">
        {[...reminders].sort().map((r) => (
          <span
            key={r}
            className="inline-flex items-center gap-1 rounded-full border border-edge bg-surface-2 px-2 py-0.5 text-xs"
          >
            <AlarmClock size={11} strokeWidth={2} className="text-warn" />
            {fmtFull(r)}
          </span>
        ))}
      </span>
    );

  return (
    <div
      onClick={closeFromBackdrop}
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-4 backdrop-blur-[2px] sm:items-center"
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="animate-rise-in max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-edge bg-surface p-5 shadow-xl"
      >
        {!detail && !error && <p className="py-6 text-center text-sm text-faint">Loading…</p>}
        {error && (
          <p className="py-6 text-center text-sm text-danger">
            Couldn&apos;t load that — it may have just been deleted.
          </p>
        )}

        {detail?.kind === "event" && (
          <>
            <div className="mb-3 flex items-start gap-3">
              <h2 className="inline-flex min-w-0 flex-1 items-baseline gap-2 text-base font-bold leading-snug">
                <Calendar size={15} strokeWidth={1.75} className="flex-none translate-y-[2px] text-accent" />
                {detail.event.title}
              </h2>
              <button
                onClick={() => setTarget(null)}
                aria-label="Close"
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
              >
                <X size={15} strokeWidth={2} />
              </button>
            </div>
            <div className="divide-y divide-edge/50">
              <Row label="When">
                {fmtFull(detail.event.startsAt)}
                {detail.event.endsAt && ` – ${fmtFull(detail.event.endsAt)}`}
              </Row>
              {detail.event.location && (
                <Row label="Where">
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin size={13} strokeWidth={1.75} className="text-muted" />
                    {detail.event.location}
                  </span>
                </Row>
              )}
              <Row label="Notes">
                {detail.event.notes ? (
                  <span className="whitespace-pre-wrap">{detail.event.notes}</span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </Row>
              <Row label="Reminders">{reminderChips(detail.event.reminders ?? [])}</Row>
              <Row label="Heard">
                {detail.event.source} · {fmtFull(detail.event.createdAt, false)}
              </Row>
              <Row label="From">
                {provenance(detail.event.conversationId, detail.event.messageId, "the conversation moment")}
              </Row>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
