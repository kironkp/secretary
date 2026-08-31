"use client";

// The FULL task editor: everything the quick dialog can't do — retitle,
// refile, status, priority, due date, notes, reminders — in one full-screen
// form. Opened from the detail dialog's Edit button; one PATCH on save.
import { useEffect, useState } from "react";
import { AlarmClock, Plus, X } from "lucide-react";
import { Button } from "@/components/ui";

type EditableTask = {
  id: string;
  title: string;
  status: string;
  notes: string | null;
  dueAt: string | null;
  priority: number;
  reminders: string[];
  projectId?: string | null;
};

const STATUSES = ["inbox", "todo", "in_progress", "blocked", "done", "dropped"] as const;
const PRIORITIES = ["none", "low", "medium", "high"];

/** ISO ↔ the local wall-clock string <input type="datetime-local"> speaks. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function localInputToIso(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-faint">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent";

export function TaskEditor({
  task,
  projectId,
  onClose,
  onSaved,
}: {
  task: EditableTask;
  projectId: string | null;
  onClose: () => void;
  /** Called with the PATCHed task so the dialog under refreshes instantly. */
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [status, setStatus] = useState(task.status);
  const [priority, setPriority] = useState(task.priority);
  const [project, setProject] = useState<string>(projectId ?? "");
  const [due, setDue] = useState(isoToLocalInput(task.dueAt));
  const [notes, setNotes] = useState(task.notes ?? "");
  const [reminders, setReminders] = useState<string[]>(task.reminders ?? []);
  const [newReminder, setNewReminder] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) throw new Error();
        const body = (await res.json()) as { projects: { id: string; name: string }[] };
        if (!cancelled) setProjects(body.projects);
      } catch {
        if (!cancelled) setProjects([]); // picker degrades to "unfiled + current"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    if (!title.trim()) {
      setError("A task needs a title.");
      return;
    }
    setSaving(true);
    setError("");
    const res = await fetch(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        status,
        priority,
        projectId: project || null,
        dueAt: localInputToIso(due),
        notes: notes.trim() || null,
        reminders,
      }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError("Couldn't save — check the connection and try again.");
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-bg">
      <div className="flex flex-none items-center justify-between border-b border-edge px-4 py-3">
        <h2 className="text-sm font-bold">Edit task</h2>
        <button
          onClick={onClose}
          aria-label="Close editor"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [-webkit-overflow-scrolling:touch]">
        <div className="mx-auto max-w-md space-y-4">
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("_", " ")}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className={inputCls}
              >
                {PRIORITIES.map((p, i) => (
                  <option key={p} value={i}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Project">
            <select value={project} onChange={(e) => setProject(e.target.value)} className={inputCls}>
              <option value="">unfiled</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              {/* current project still selectable while the list loads */}
              {projects === null && projectId && <option value={projectId}>…</option>}
            </select>
          </Field>

          <Field label="Due">
            <span className="flex items-center gap-2">
              <input
                type="datetime-local"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                className={inputCls}
              />
              {due && (
                <button
                  onClick={() => setDue("")}
                  title="Clear due date"
                  aria-label="Clear due date"
                  className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              )}
            </span>
          </Field>

          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Anything worth remembering about this…"
              className={`${inputCls} resize-y`}
            />
          </Field>

          <Field label="Reminders">
            <span className="flex flex-col gap-2">
              {reminders.length > 0 && (
                <span className="flex flex-wrap gap-1.5">
                  {[...reminders].sort().map((r) => (
                    <span
                      key={r}
                      className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-2 px-2.5 py-1 text-xs"
                    >
                      <AlarmClock size={11} strokeWidth={2} className="text-warn" />
                      {new Intl.DateTimeFormat("en-US", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      }).format(new Date(r))}
                      <button
                        onClick={() => setReminders((rs) => rs.filter((x) => x !== r))}
                        aria-label="Remove reminder"
                        className="text-muted hover:text-danger"
                      >
                        <X size={11} strokeWidth={2.5} />
                      </button>
                    </span>
                  ))}
                </span>
              )}
              <span className="flex items-center gap-2">
                <input
                  type="datetime-local"
                  value={newReminder}
                  onChange={(e) => setNewReminder(e.target.value)}
                  className={inputCls}
                />
                <button
                  onClick={() => {
                    const iso = localInputToIso(newReminder);
                    if (!iso) return;
                    setReminders((rs) => (rs.includes(iso) ? rs : [...rs, iso]));
                    setNewReminder("");
                  }}
                  disabled={!newReminder}
                  title="Add reminder"
                  aria-label="Add reminder"
                  className="flex h-8 w-8 flex-none items-center justify-center rounded-full border border-edge text-muted hover:text-ink disabled:opacity-40"
                >
                  <Plus size={15} strokeWidth={2} />
                </button>
              </span>
              <span className="text-[11px] text-faint">Reminders ring this device at the exact time.</span>
            </span>
          </Field>

          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      </div>

      <div className="flex flex-none items-center justify-end gap-2 border-t border-edge px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
