"use client";

// The project workspace: everything in one project — tasks (check-off),
// events, documents — plus management: rename, color, archive, delete
// (delete unfiles children, never destroys them). Back button, live refresh.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Calendar,
  Check,
  FileText,
  Pencil,
  Trash2,
} from "lucide-react";
import { RefreshOnFocus } from "@/components/shell/refresh-on-focus";
import { openDetail } from "@/components/dashboard/shared";

const COLORS = ["#4a6fe8", "#15803d", "#b45309", "#dc2626", "#7e22ce", "#0e7490", "#be185d"];

export type ProjectTask = {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  reminders: string[];
  stages: { name: string; done: boolean }[];
  recurrence: string | null;
  source: string;
};
export type ProjectEvent = {
  id: string;
  title: string;
  startsAt: string;
  location: string | null;
  reminders: string[];
};
export type ProjectDoc = { id: string; title: string; updatedAt: string; sectionCount: number };

const OPEN = new Set(["inbox", "todo", "in_progress", "blocked"]);

/** Upcoming = starts less than an hour ago or later (helper keeps render pure). */
function upcomingOf(events: ProjectEvent[]): ProjectEvent[] {
  const cutoff = Date.now() - 3600000;
  return events
    .filter((e) => new Date(e.startsAt).getTime() > cutoff)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

export function ProjectView({
  id,
  initialName,
  initialColor,
  initialStatus,
  tasks,
  events,
  docs,
}: {
  id: string;
  initialName: string;
  initialColor: string | null;
  initialStatus: string;
  tasks: ProjectTask[];
  events: ProjectEvent[];
  docs: ProjectDoc[];
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  const [status, setStatus] = useState(initialStatus);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(initialName);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [crossing, setCrossing] = useState<Set<string>>(new Set());
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    const res = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (res.ok) router.refresh();
    return res.ok;
  };

  const saveName = async () => {
    const next = nameDraft.trim();
    setEditingName(false);
    if (!next || next === name) return;
    if (await patch({ name: next })) setName(next);
  };

  const pickColor = async (c: string) => {
    setColor(c);
    await patch({ color: c });
  };

  const toggleArchive = async () => {
    const next = status === "archived" ? "active" : "archived";
    if (await patch({ status: next })) setStatus(next);
  };

  const deleteProject = async () => {
    setBusy(true);
    const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
    setBusy(false);
    if (res.ok) {
      router.push("/dashboard");
      router.refresh();
    }
  };

  const markDone = async (taskId: string) => {
    setCrossing((s) => new Set(s).add(taskId));
    setTimeout(() => setDoneIds((s) => new Set(s).add(taskId)), 500);
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    if (res.ok) router.refresh();
  };

  const openTasks = tasks.filter((t) => OPEN.has(t.status) && !doneIds.has(t.id));
  const doneTasks = tasks.filter((t) => t.status === "done" || doneIds.has(t.id));
  const upcomingEvents = upcomingOf(events);

  const fmt = (iso: string, withTime = true) =>
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
    }).format(new Date(iso));

  return (
    <div className="mx-auto max-w-2xl space-y-5 py-6">
      <RefreshOnFocus />
      <div className="flex flex-wrap items-center gap-2.5">
        <Link
          href="/dashboard"
          aria-label="Back to dashboard"
          className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
        </Link>
        <span
          className="h-3 w-3 flex-none rounded-full"
          style={{ background: color ?? "var(--color-accent)" }}
        />
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveName();
              if (e.key === "Escape") setEditingName(false);
            }}
            className="min-w-0 flex-1 rounded-lg border border-accent bg-surface px-2 py-1 text-lg font-bold outline-none"
          />
        ) : (
          <button
            onClick={() => {
              setNameDraft(name);
              setEditingName(true);
            }}
            className="group flex min-w-0 items-center gap-2 text-left"
            title="Rename project"
          >
            <h1 className="truncate text-lg font-bold tracking-tight">{name}</h1>
            <Pencil size={13} strokeWidth={1.75} className="flex-none text-faint opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
        {status === "archived" && (
          <span className="rounded-full border border-edge bg-surface-2 px-2.5 py-0.5 text-[11px] text-muted">
            archived
          </span>
        )}
        <span className="ml-auto text-xs text-faint">
          {openTasks.length} open · {doneTasks.length} done
          {upcomingEvents.length ? ` · ${upcomingEvents.length} event${upcomingEvents.length > 1 ? "s" : ""}` : ""}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => pickColor(c)}
            aria-label={`Set color ${c}`}
            className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${
              color === c ? "ring-2 ring-ink ring-offset-2 ring-offset-bg" : ""
            }`}
            style={{ background: c }}
          />
        ))}
        <span className="mx-2 h-4 w-px bg-edge" />
        <button
          onClick={toggleArchive}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full border border-edge px-3 py-1 text-xs text-muted transition-colors hover:text-ink disabled:opacity-50"
        >
          {status === "archived" ? (
            <>
              <ArchiveRestore size={12} strokeWidth={1.75} /> Unarchive
            </>
          ) : (
            <>
              <Archive size={12} strokeWidth={1.75} /> Archive
            </>
          )}
        </button>
        {confirmDelete ? (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span className="text-danger">Delete “{name}”? Its items become unfiled.</span>
            <button
              onClick={deleteProject}
              disabled={busy}
              className="rounded-full bg-danger px-3 py-1 font-bold text-bg disabled:opacity-50"
            >
              Delete
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="rounded-full border border-edge px-3 py-1 text-muted"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="inline-flex items-center gap-1.5 rounded-full border border-danger/40 px-3 py-1 text-xs text-danger transition-colors hover:bg-danger/10"
          >
            <Trash2 size={12} strokeWidth={1.75} /> Delete
          </button>
        )}
      </div>

      {upcomingEvents.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.08em] text-faint">Events</h2>
          <div className="space-y-1.5">
            {upcomingEvents.map((e) => (
              <button
                key={e.id}
                onClick={() => openDetail("event", e.id)}
                className="flex w-full items-center gap-2.5 rounded-xl border border-edge bg-surface px-3.5 py-2.5 text-left text-sm transition-colors hover:border-faint"
              >
                <Calendar size={14} strokeWidth={1.75} className="flex-none text-accent" />
                <span className="min-w-0 flex-1 truncate">{e.title}</span>
                <span className="flex-none text-xs text-muted">{fmt(e.startsAt)}</span>
                {e.reminders.length > 0 && (
                  <span className="inline-flex flex-none items-center gap-0.5 text-[10px] text-muted">
                    <AlarmClock size={10} strokeWidth={2} />
                    {e.reminders.length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.08em] text-faint">Tasks</h2>
        <div className="space-y-1.5">
          {openTasks.length === 0 && doneTasks.length === 0 && (
            <p className="rounded-xl border border-edge bg-surface px-4 py-6 text-center text-sm text-faint">
              Nothing here yet — mention it to your secretary.
            </p>
          )}
          {openTasks.map((t) => (
            <div
              key={t.id}
              onClick={() => openDetail("task", t.id)}
              className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-edge bg-surface px-3.5 py-2.5 text-sm transition-colors hover:border-faint"
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  markDone(t.id);
                }}
                aria-label="Mark done"
                className="flex h-5 w-5 flex-none items-center justify-center rounded-full border border-edge text-transparent transition-colors hover:border-ok hover:text-ok"
              >
                <Check size={12} strokeWidth={2.5} />
              </button>
              <span className={`cross-off min-w-0 flex-1 ${crossing.has(t.id) ? "crossed text-faint" : ""}`}>
                {t.title}
              </span>
              {t.stages.length > 0 && (
                <span className="flex-none text-[10px] text-muted">
                  {t.stages.filter((s) => s.done).length}/{t.stages.length}
                </span>
              )}
              {t.dueAt && <span className="flex-none text-xs text-muted">{fmt(t.dueAt, false)}</span>}
              {t.reminders.length > 0 && (
                <AlarmClock size={11} strokeWidth={2} className="flex-none text-warn" />
              )}
            </div>
          ))}
          {doneTasks.slice(0, 5).map((t) => (
            <div
              key={t.id}
              onClick={() => openDetail("task", t.id)}
              className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-edge/50 bg-surface px-3.5 py-2 text-sm opacity-70"
            >
              <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full border border-ok/50 bg-ok/20 text-ok">
                <Check size={12} strokeWidth={2.5} />
              </span>
              <span className="min-w-0 flex-1 truncate text-faint line-through">{t.title}</span>
            </div>
          ))}
          {doneTasks.length > 5 && (
            <p className="text-xs text-faint">+ {doneTasks.length - 5} more done</p>
          )}
        </div>
      </section>

      {docs.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-[0.08em] text-faint">Documents</h2>
          <div className="space-y-1.5">
            {docs.map((d) => (
              <Link
                key={d.id}
                href={`/documents/${d.id}`}
                className="flex items-center gap-2.5 rounded-xl border border-edge bg-surface px-3.5 py-2.5 text-sm transition-colors hover:border-faint"
              >
                <FileText size={14} strokeWidth={1.75} className="flex-none text-accent" />
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                <span className="flex-none text-xs text-faint">
                  {d.sectionCount} section{d.sectionCount === 1 ? "" : "s"}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
