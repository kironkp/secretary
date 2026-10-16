"use client";

// The task screen (v1.10, docs/tasks/SPEC.md §2.4): the approved 1-task.html, its top half. "Task" and Done; the
// done circle, the title and his note; Due, Remind me, Project (and Waiting on while blocked); everything else the
// dialog showed under one "More", collapsed every time it opens. Full screen on a phone, a dialog at most 420 wide
// otherwise. Colours are the app's tokens, so dark follows.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Clock, MessageSquare, X } from "lucide-react";
import { withoutSuggested } from "@/lib/suggested";
import { Row, fmtFull } from "./detail-parts";
import { PacketSection } from "./packet-section";
import { TaskEditor, isoToLocalInput, localInputToIso } from "./task-editor";

export type TaskDetail = {
  kind: "task";
  task: {
    id: string;
    title: string;
    status: string;
    notes: string | null;
    blockedReason: string | null;
    dueAt: string | null;
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

/** "Fri 16 Oct", with ", 9:00 AM" when it has a time of day. */
function when(iso: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(d).replace(",", "");
  if (d.getHours() === 0 && d.getMinutes() === 0) return day;
  return `${day}, ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d)}`;
}

/** The next reminder (else the latest) and how many others there are. */
function nextReminder(reminders: string[]): { at: string; more: number } | null {
  if (!reminders.length) return null;
  const sorted = [...reminders].sort();
  const now = new Date().toISOString();
  return { at: sorted.find((r) => r >= now) ?? sorted[sorted.length - 1], more: sorted.length - 1 };
}

const ROW = "flex min-h-12 w-full items-center gap-3 px-4 text-left";
const SEP = "border-t border-hairline";
const ICON = { width: 22, height: 22, strokeWidth: 1.8, className: "flex-none text-accent-ink" } as const;

export function TaskScreen({
  detail,
  onChange,
  onReload,
  onClose,
  backdropReady,
}: {
  detail: TaskDetail;
  /** The task as the route returned it after a change. */
  onChange: (task: Partial<TaskDetail["task"]>) => void;
  onReload: () => void;
  onClose: () => void;
  /** False just after it opened: the click that opened it must not also close it from the backdrop. */
  backdropReady: () => boolean;
}) {
  const router = useRouter();
  const t = detail.task;
  const [editing, setEditing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dueDraft, setDueDraft] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<string | null>(null); // null: not editing
  // The note as it was when he started typing (docs/tasks/SPEC.md §1.6).
  const [notesBase, setNotesBase] = useState<string | null>(null);
  const [togglingStage, setTogglingStage] = useState<string | null>(null);
  const [patchError, setPatchError] = useState(false);

  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    setPatchError(false);
    const res = await fetch(`/api/tasks/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      setPatchError(true);
      return false;
    }
    const { task } = (await res.json()) as { task: Partial<TaskDetail["task"]> };
    onChange(task);
    router.refresh();
    return true;
  };

  const saveNote = async () => {
    if (notesDraft === null) return true;
    const ok = await patch({ notes: notesDraft.trim() || null, notesBase });
    if (ok) setNotesDraft(null);
    return ok;
  };
  /** Done (and Escape, and a tap outside): an open note draft is saved, then it closes. Only Cancel discards. */
  const done = async () => {
    if (await saveNote()) onClose();
  };

  // Escape: the editor first, else as Done.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editing) setEditing(false);
      else void done();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleStage = async (name: string) => {
    setTogglingStage(name);
    await patch({ stages: t.stages.map((s) => (s.name === name ? { ...s, done: !s.done } : s)) });
    setTogglingStage(null);
  };

  const isDone = t.status === "done";
  // Reopening a done recurring task would leave two open copies: its circle is drawn done and is not a button.
  const circleLocked = isDone && Boolean(t.recurrence);
  const reminder = nextReminder(t.reminders ?? []);
  const note = t.notes ? withoutSuggested(t.notes) : "";

  const circle = (
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      {isDone ? (
        <>
          <circle cx="12" cy="12" r="10" className="fill-accent stroke-accent" />
          <path d="M7.5 12.5l3 3 6-6.5" stroke="#ffffff" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : (
        <circle cx="12" cy="12" r="9" stroke="currentColor" />
      )}
    </svg>
  );

  return (
    <div
      onClick={() => backdropReady() && void done()}
      className="fixed inset-0 z-[60] flex sm:items-center sm:justify-center sm:bg-black/40 sm:p-4 sm:backdrop-blur-[2px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-screen-title"
        data-task-screen=""
        onClick={(e) => e.stopPropagation()}
        className="animate-rise-in h-full w-full overflow-y-auto bg-bg text-ink sm:h-auto sm:max-h-[85dvh] sm:max-w-[420px] sm:rounded-2xl sm:shadow-xl"
      >
        <div data-task-header="" data-order="header" className="flex h-14 items-center justify-between pr-2 pl-4">
          <h2 id="task-screen-title" data-task-header-title="" className="text-[17px] font-semibold">
            Task
          </h2>
          <button
            type="button"
            data-task-done=""
            onClick={() => void done()}
            className="h-11 min-w-16 px-2 text-[17px] font-semibold text-accent-ink"
          >
            Done
          </button>
        </div>

        <div className="flex flex-col gap-4 px-4" style={{ paddingBottom: "calc(24px + env(safe-area-inset-bottom))" }}>
          <div data-task-card="title" className="flex items-start gap-0.5 rounded-xl bg-card pt-1.5 pr-4 pb-4 pl-1.5">
            {circleLocked ? (
              <span
                role="img"
                aria-label="Done"
                data-task-circle=""
                data-done="true"
                data-order="circle"
                className="flex h-11 w-11 flex-none items-center justify-center"
              >
                {circle}
              </span>
            ) : (
              <button
                type="button"
                aria-label={isDone ? "Mark not done" : "Mark done"}
                data-task-circle=""
                data-done={isDone ? "true" : "false"}
                data-order="circle"
                onClick={() => void patch(isDone ? { status: "todo" } : { status: "done", source: "task" })}
                className="flex h-11 w-11 flex-none items-center justify-center text-muted"
              >
                {circle}
              </button>
            )}
            {/* The title and the note are 44-tall buttons that keep the mockup's places: the title's box reaches
                into the card's top padding, the note's below its text. */}
            <div className="flex min-w-0 flex-1 flex-col">
              <button
                type="button"
                aria-label={`Edit task: ${t.title}`}
                data-task-title=""
                data-order="title"
                onClick={() => setEditing(true)}
                className="-mt-1 block min-h-11 w-full pt-3.5 pb-1.5 text-left"
              >
                <span data-task-title-text="" className={`block text-[20px] leading-6 font-semibold ${isDone ? "text-muted line-through" : "text-ink"}`}>
                  {t.title}
                </span>
              </button>
              {notesDraft !== null ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    rows={3}
                    autoFocus
                    placeholder="Type a note…"
                    className="w-full resize-y rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-base text-ink outline-none focus:border-accent"
                  />
                  <span className="flex gap-2">
                    <button type="button" onClick={() => void saveNote()} className="h-11 rounded-full bg-accent px-4 text-sm font-bold text-bg">
                      Save
                    </button>
                    <button type="button" onClick={() => setNotesDraft(null)} className="h-11 rounded-full border border-edge px-4 text-sm text-muted">
                      Cancel
                    </button>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  title="Edit notes"
                  data-task-note=""
                  data-order="note"
                  onClick={() => {
                    setNotesBase(t.notes ?? null);
                    setNotesDraft(t.notes ?? "");
                  }}
                  className="-mb-[22px] block min-h-11 w-full pb-[22px] text-left"
                >
                  <span data-task-note-text="" className="block text-base leading-[22px] whitespace-pre-wrap text-muted">
                    {note || "Add a note"}
                  </span>
                </button>
              )}
            </div>
          </div>

          <div data-task-card="rows" className="flex flex-col rounded-xl bg-card">
            {/* Due: the date as text; the native picker opens in place over the row, drafted and saved once. */}
            <div data-task-row="due" data-order="due" className={`relative ${ROW}`}>
              <svg aria-hidden="true" data-row-icon="" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...ICON}>
                <rect x="3" y="5" width="18" height="16" rx="3" />
                <path d="M3 10h18M8 3v4M16 3v4" />
              </svg>
              <span data-row-label="" className="flex-1 text-base text-ink">
                Due
              </span>
              <span className="flex flex-col items-end">
                <span data-row-value="" className="text-base text-muted">
                  {dueDraft ? when(localInputToIso(dueDraft) ?? "") : t.dueAt ? when(t.dueAt) : "None"}
                </span>
                {t.recurrence && <span className="text-sm text-muted">repeats {t.recurrence}</span>}
              </span>
              <input
                type="datetime-local"
                aria-label="Due date"
                value={dueDraft ?? isoToLocalInput(t.dueAt)}
                onClick={(e) => {
                  try {
                    e.currentTarget.showPicker?.();
                  } catch {
                    /* the browser opens it its own way */
                  }
                }}
                onChange={(e) => setDueDraft(e.target.value)}
                onBlur={() => {
                  if (dueDraft === null || dueDraft === isoToLocalInput(t.dueAt)) return;
                  void patch({ dueAt: localInputToIso(dueDraft) }).then((ok) => ok && setDueDraft(null));
                }}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
              {t.dueAt && (
                <button
                  type="button"
                  aria-label="Clear due date"
                  onClick={() => {
                    setDueDraft(null);
                    void patch({ dueAt: null });
                  }}
                  className="relative z-10 -mr-3 flex h-11 w-11 flex-none items-center justify-center text-muted"
                >
                  <X size={16} strokeWidth={2} />
                </button>
              )}
            </div>
            <button type="button" data-task-row="remind" data-order="remind" onClick={() => setEditing(true)} className={`${ROW} ${SEP}`}>
              <svg aria-hidden="true" data-row-icon="" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...ICON}>
                <path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z" />
                <path d="M10 21h4" />
              </svg>
              <span data-row-label="" className="flex-1 text-base text-ink">
                Remind me
              </span>
              <span data-row-value="" className="text-base text-muted">
                {reminder ? `${when(reminder.at)}${reminder.more ? ` +${reminder.more}` : ""}` : "None"}
              </span>
            </button>
            <button type="button" data-task-row="project" data-order="project" onClick={() => setEditing(true)} className={`${ROW} ${SEP}`}>
              <span aria-hidden="true" data-row-icon="" className="flex h-[22px] w-[22px] flex-none items-center justify-center">
                <span
                  data-project-dot=""
                  className="h-3 w-3 rounded-full"
                  style={{ background: detail.projectName ? (detail.projectColor ?? "var(--muted)") : "transparent", boxShadow: detail.projectName ? undefined : "inset 0 0 0 1.5px var(--muted)" }}
                />
              </span>
              <span data-row-label="" className="flex-1 text-base text-ink">
                Project
              </span>
              <span data-row-value="" className="max-w-[55%] truncate text-base text-muted">
                {detail.projectName ?? "None"}
              </span>
              <ChevronRight aria-hidden="true" data-row-chevron="" size={16} strokeWidth={2} className="-ml-1 flex-none text-muted" />
            </button>
            {/* What a blocked task waits on is kept here, not in his note (docs/tasks/SPEC.md §1.5). */}
            {t.status === "blocked" && t.blockedReason && (
              <div data-task-row="waiting" data-order="waiting" className={`${ROW} ${SEP}`}>
                <Clock aria-hidden="true" data-row-icon="" size={22} strokeWidth={1.8} className="flex-none text-accent-ink" />
                <span data-row-label="" className="flex-1 text-base text-ink">
                  Waiting on
                </span>
                <span data-row-value="" className="max-w-[60%] text-right text-base text-muted">
                  {t.blockedReason}
                </span>
              </div>
            )}
          </div>

          <div data-task-card="more" className="rounded-xl bg-card">
            <button
              type="button"
              data-task-more=""
              data-order="more"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((o) => !o)}
              className={ROW}
            >
              <span className="flex-1 text-base text-ink">More</span>
              <ChevronRight aria-hidden="true" size={16} strokeWidth={2} className={`flex-none text-muted transition-transform ${moreOpen ? "rotate-90" : ""}`} />
            </button>
            {moreOpen && (
              <div data-task-more-body="" className="divide-y divide-edge/50 border-t border-hairline px-4 pb-2">
                <Row label="Status" part="status" labelClass="text-muted">
                  {t.status.replace("_", " ")}
                  {t.postponedCount > 0 && <span className="ml-2 text-xs text-muted">pushed {t.postponedCount}×</span>}
                </Row>
                {(t.stages ?? []).length > 0 && (
                  <div data-more-part="stages" className="py-1.5">
                    <p className="mb-1.5 text-xs text-muted">
                      Stages ({t.stages.filter((s) => s.done).length}/{t.stages.length})
                    </p>
                    <div className="flex flex-col">
                      {t.stages.map((s) => (
                        <button
                          type="button"
                          key={s.name}
                          disabled={togglingStage !== null}
                          onClick={() => void toggleStage(s.name)}
                          className="flex min-h-11 items-center gap-2.5 text-left text-sm disabled:opacity-60"
                        >
                          <span
                            className={`flex h-[18px] w-[18px] flex-none items-center justify-center rounded-md border transition-colors ${
                              s.done ? "border-ok bg-ok text-bg" : "border-edge text-transparent hover:border-ok"
                            }`}
                          >
                            <Check size={11} strokeWidth={3} />
                          </span>
                          <span className={s.done ? "text-muted line-through" : ""}>{s.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div data-more-part="packet">
                  <PacketSection key={t.id} taskId={t.id} />
                </div>
                <Row label="Heard" part="heard" labelClass="text-muted">
                  {t.source} · {fmtFull(t.createdAt, false)}
                </Row>
                <Row label="From" part="from" labelClass="text-muted">
                  {t.createdFromConversationId ? (
                    <Link
                      href={`/chat?c=${t.createdFromConversationId}${t.createdFromMessageId ? `&m=${t.createdFromMessageId}` : ""}`}
                      onClick={onClose}
                      className="inline-flex min-h-11 items-center gap-1.5 text-accent-ink hover:underline"
                    >
                      <MessageSquare size={13} strokeWidth={1.75} />
                      the conversation moment
                    </Link>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Row>
                {detail.history.length > 0 && (
                  <div data-more-part="history" className="pt-2.5">
                    <p className="mb-1.5 text-xs font-bold tracking-wide text-muted uppercase">History</p>
                    {detail.history.map((h) => (
                      <p key={h.id} className="mb-1 text-xs text-muted">
                        <span className="text-muted">{fmtFull(h.at)}</span> — {h.note ?? h.type}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {patchError && <p className="text-sm text-danger">Couldn&apos;t save that change — check the connection and try again.</p>}
        </div>

        {editing && (
          <TaskEditor
            task={t}
            projectId={t.projectId}
            onClose={() => setEditing(false)}
            onSaved={() => {
              onReload();
              router.refresh();
            }}
          />
        )}
      </div>
    </div>
  );
}
