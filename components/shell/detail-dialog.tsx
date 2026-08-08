"use client";

// The "nothing is write-only" dialog: any row anywhere can dispatch
// secretary:open-detail (via openDetail() in dashboard/shared) and this
// modal shows EVERYTHING stored about the task or event — notes in full,
// reminders, source, provenance, check-in history. Mounted once in the app
// shell; re-fetches on window focus so live updates don't show stale detail.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlarmClock,
  Calendar,
  Flag,
  FolderKanban,
  MapPin,
  MessageSquare,
  X,
} from "lucide-react";

type TaskDetail = {
  kind: "task";
  task: {
    id: string;
    title: string;
    status: string;
    notes: string | null;
    dueAt: string | null;
    priority: number;
    reminders: string[];
    source: string;
    postponedCount: number;
    createdAt: string;
    createdFromConversationId: string | null;
    createdFromMessageId: string | null;
  };
  projectName: string | null;
  projectColor: string | null;
  history: { id: string; type: string; note: string | null; at: string }[];
};

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

const PRIORITY_LABEL = ["none", "low", "medium", "high"];

function fmtFull(iso: string, withTime = true) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(new Date(iso));
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-2 py-1.5 text-sm">
      <span className="pt-px text-xs text-faint">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function DetailDialog() {
  const [target, setTarget] = useState<{ kind: "task" | "event"; id: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(false);

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

  useEffect(() => {
    const onOpen = (e: Event) => {
      const { kind, id } = (e as CustomEvent).detail as { kind: "task" | "event"; id: string };
      setTarget({ kind, id });
      setDetail(null);
      setError(false);
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

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target]);

  if (!target) return null;

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
        <span className="self-center text-[10px] uppercase tracking-wide text-faint">
          logged only — no device alerts yet
        </span>
      </span>
    );

  return (
    <div
      onClick={() => setTarget(null)}
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/40 p-4 backdrop-blur-[2px] sm:items-center"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="animate-rise-in max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-edge bg-surface p-5 shadow-xl"
      >
        {!detail && !error && <p className="py-6 text-center text-sm text-faint">Loading…</p>}
        {error && (
          <p className="py-6 text-center text-sm text-danger">
            Couldn&apos;t load that — it may have just been deleted.
          </p>
        )}

        {detail?.kind === "task" && (
          <>
            <div className="mb-3 flex items-start gap-3">
              <h2 className="min-w-0 flex-1 text-base font-bold leading-snug">
                {detail.task.title}
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
              <Row label="Project">
                {detail.projectName ? (
                  <span className="inline-flex items-center gap-1.5">
                    <FolderKanban size={13} strokeWidth={1.75} className="text-muted" />
                    {detail.projectName}
                  </span>
                ) : (
                  <span className="text-faint">unfiled</span>
                )}
              </Row>
              <Row label="Status">
                {detail.task.status.replace("_", " ")}
                {detail.task.postponedCount > 0 && (
                  <span className="ml-2 text-xs text-warn">
                    pushed {detail.task.postponedCount}×
                  </span>
                )}
              </Row>
              <Row label="Due">
                {detail.task.dueAt ? (
                  fmtFull(detail.task.dueAt)
                ) : (
                  <span className="text-warn">no date</span>
                )}
              </Row>
              {detail.task.priority > 0 && (
                <Row label="Priority">
                  <span className="inline-flex items-center gap-1.5">
                    <Flag size={12} strokeWidth={2} className="text-muted" />
                    {PRIORITY_LABEL[detail.task.priority]}
                  </span>
                </Row>
              )}
              <Row label="Notes">
                {detail.task.notes ? (
                  <span className="whitespace-pre-wrap">{detail.task.notes}</span>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </Row>
              <Row label="Reminders">{reminderChips(detail.task.reminders ?? [])}</Row>
              <Row label="Heard">
                {detail.task.source} · {fmtFull(detail.task.createdAt, false)}
              </Row>
              <Row label="From">
                {provenance(
                  detail.task.createdFromConversationId,
                  detail.task.createdFromMessageId,
                  "the conversation moment"
                )}
              </Row>
              {detail.history.length > 0 && (
                <div className="pt-2.5">
                  <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-faint">
                    History
                  </p>
                  {detail.history.map((h) => (
                    <p key={h.id} className="mb-1 text-xs text-muted">
                      <span className="text-faint">{fmtFull(h.at)}</span> — {h.note ?? h.type}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </>
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
