"use client";

// The "nothing is write-only" dialog: any row anywhere can dispatch
// secretary:open-detail (via openDetail() in dashboard/shared) and this
// modal shows EVERYTHING stored about the task or event — notes in full,
// reminders, source, provenance, check-in history. Mounted once in the app
// shell; re-fetches on window focus so live updates don't show stale detail.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlarmClock,
  Calendar,
  Check,
  Flag,
  FolderKanban,
  MapPin,
  MessageSquare,
  Pencil,
  Repeat,
  X,
} from "lucide-react";
import { TaskEditor, isoToLocalInput, localInputToIso } from "./task-editor";

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
    stages: { name: string; done: boolean }[];
    recurrence: string | null;
    source: string;
    postponedCount: number;
    projectId: string | null;
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
  const router = useRouter();
  const [target, setTarget] = useState<{ kind: "task" | "event"; id: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(false);
  const [togglingStage, setTogglingStage] = useState<string | null>(null);
  // Quick edits in place (the dialog IS the minimized edit view): due date via
  // the native picker, notes via tap-to-type. The Edit button opens the full
  // editor for everything else.
  const [editing, setEditing] = useState(false);
  const [dueDraft, setDueDraft] = useState<string | null>(null); // datetime-local value
  const [notesDraft, setNotesDraft] = useState<string | null>(null); // null = not editing
  const [patchError, setPatchError] = useState(false);

  const patchTask = useCallback(
    async (id: string, body: Record<string, unknown>): Promise<boolean> => {
      setPatchError(false);
      const res = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => null);
      if (!res?.ok) {
        setPatchError(true);
        return false;
      }
      const { task } = (await res.json()) as { task: Record<string, unknown> };
      setDetail((d) => (d?.kind === "task" ? { ...d, task: { ...d.task, ...task } } : d));
      router.refresh();
      return true;
    },
    [router]
  );

  const toggleStage = async (taskId: string, stages: { name: string; done: boolean }[], name: string) => {
    setTogglingStage(name);
    const next = stages.map((s) => (s.name === name ? { ...s, done: !s.done } : s));
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stages: next }),
    });
    setTogglingStage(null);
    if (res.ok) {
      setDetail((d) =>
        d?.kind === "task" ? { ...d, task: { ...d.task, stages: next } } : d
      );
      router.refresh();
    }
  };

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
      setEditing(false);
      setDueDraft(null);
      setNotesDraft(null);
      setPatchError(false);
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
      if (e.key !== "Escape") return;
      if (editing) setEditing(false); // peel the full editor first
      else setTarget(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, editing]);

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
            <div className="mb-3 flex items-start gap-2">
              <h2 className="min-w-0 flex-1 text-base font-bold leading-snug">
                {detail.task.title}
              </h2>
              <button
                onClick={() => setEditing(true)}
                aria-label="Edit task"
                className="flex h-7 flex-none items-center gap-1.5 rounded-full border border-edge bg-card px-2.5 text-xs font-semibold text-muted hover:text-ink"
              >
                <Pencil size={12} strokeWidth={2} />
                Edit
              </button>
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
                {/* Native picker in place: draft locally, PATCH once on close —
                    iOS fires change per wheel-tick, and each later-than-before
                    PATCH would count as another postponement. */}
                <span className="flex flex-wrap items-center gap-1.5">
                  <input
                    type="datetime-local"
                    value={dueDraft ?? isoToLocalInput(detail.task.dueAt)}
                    onChange={(e) => setDueDraft(e.target.value)}
                    onBlur={() => {
                      if (dueDraft === null || dueDraft === isoToLocalInput(detail.task.dueAt))
                        return;
                      void patchTask(detail.task.id, { dueAt: localInputToIso(dueDraft) }).then(
                        (ok) => ok && setDueDraft(null)
                      );
                    }}
                    aria-label="Due date"
                    className="rounded-lg border border-edge bg-surface-2 px-2 py-1 text-sm text-ink outline-none focus:border-accent"
                  />
                  {!detail.task.dueAt && (dueDraft ?? "") === "" && (
                    <span className="text-xs text-warn">no date</span>
                  )}
                  {detail.task.dueAt && (
                    <button
                      onClick={() => {
                        setDueDraft(null);
                        void patchTask(detail.task.id, { dueAt: null });
                      }}
                      title="Clear due date"
                      aria-label="Clear due date"
                      className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-muted hover:text-danger"
                    >
                      <X size={12} strokeWidth={2.25} />
                    </button>
                  )}
                  {detail.task.recurrence && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted">
                      <Repeat size={11} strokeWidth={2} />
                      repeats {detail.task.recurrence}
                    </span>
                  )}
                </span>
              </Row>
              {(detail.task.stages ?? []).length > 0 && (
                <div className="py-1.5">
                  <p className="mb-1.5 text-xs text-faint">
                    Stages ({detail.task.stages.filter((s) => s.done).length}/
                    {detail.task.stages.length})
                  </p>
                  <div className="flex flex-col gap-1.5">
                    {detail.task.stages.map((s) => (
                      <button
                        key={s.name}
                        disabled={togglingStage !== null}
                        onClick={() => toggleStage(detail.task.id, detail.task.stages, s.name)}
                        className="flex items-center gap-2.5 text-left text-sm disabled:opacity-60"
                      >
                        <span
                          className={`flex h-[18px] w-[18px] flex-none items-center justify-center rounded-md border transition-colors ${
                            s.done
                              ? "border-ok bg-ok text-bg"
                              : "border-edge text-transparent hover:border-ok"
                          }`}
                        >
                          <Check size={11} strokeWidth={3} />
                        </span>
                        <span className={s.done ? "text-faint line-through" : ""}>{s.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {detail.task.priority > 0 && (
                <Row label="Priority">
                  <span className="inline-flex items-center gap-1.5">
                    <Flag size={12} strokeWidth={2} className="text-muted" />
                    {PRIORITY_LABEL[detail.task.priority]}
                  </span>
                </Row>
              )}
              <Row label="Notes">
                {notesDraft !== null ? (
                  <span className="flex flex-col gap-1.5">
                    <textarea
                      value={notesDraft}
                      onChange={(e) => setNotesDraft(e.target.value)}
                      rows={3}
                      autoFocus
                      placeholder="Type a note…"
                      className="w-full resize-y rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
                    />
                    <span className="flex gap-2">
                      <button
                        onClick={() =>
                          void patchTask(detail.task.id, {
                            notes: notesDraft.trim() || null,
                          }).then((ok) => ok && setNotesDraft(null))
                        }
                        className="rounded-full bg-accent px-3 py-1 text-xs font-bold text-bg"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setNotesDraft(null)}
                        className="rounded-full border border-edge px-3 py-1 text-xs text-muted hover:text-ink"
                      >
                        Cancel
                      </button>
                    </span>
                  </span>
                ) : (
                  <button
                    onClick={() => setNotesDraft(detail.task.notes ?? "")}
                    title="Edit notes"
                    className="block w-full text-left"
                  >
                    {detail.task.notes ? (
                      <span className="whitespace-pre-wrap">{detail.task.notes}</span>
                    ) : (
                      <span className="text-faint">tap to add a note</span>
                    )}
                  </button>
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
            {patchError && (
              <p className="mt-2 text-xs text-danger">
                Couldn&apos;t save that change — check the connection and try again.
              </p>
            )}
            {editing && (
              <TaskEditor
                task={detail.task}
                projectId={detail.task.projectId}
                onClose={() => setEditing(false)}
                onSaved={() => {
                  void load("task", detail.task.id);
                  router.refresh();
                }}
              />
            )}
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
