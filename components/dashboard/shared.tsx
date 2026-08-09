"use client";

// Shared shapes + primitives for every dashboard view (List/Board/Calendar/
// Timeline/Adaptive): row types, due-date formatting, the cross-off button,
// and provenance links.
import Link from "next/link";
import { AlarmClock, Check, MessageSquare, Repeat } from "lucide-react";

export type TaskRow = {
  id: string;
  title: string;
  status: "inbox" | "todo" | "in_progress" | "blocked" | "done" | "dropped";
  dueAt: string | null;
  updatedAt: string;
  postponedCount: number;
  priority: number;
  procrastinationScore: number;
  source: "spoken" | "typed" | "inferred" | "suggested";
  notes: string | null;
  reminders: string[];
  stages: { name: string; done: boolean }[];
  recurrence: string | null;
  projectName: string | null;
  projectColor: string | null;
  conversationId: string | null;
  messageId: string | null;
  conversationLabel: string | null;
};

export type EventRow = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  notes: string | null;
  reminders: string[];
  projectName: string | null;
  source: string;
  createdAt: string;
};

export type DocRow = {
  id: string;
  title: string;
  projectName: string | null;
  headings: string[];
  updatedAt: string;
  sectionCount: number;
  hasContent: boolean;
};

/** Open the global detail dialog (mounted in the app shell) for any item. */
export function openDetail(kind: "task" | "event", id: string) {
  window.dispatchEvent(new CustomEvent("secretary:open-detail", { detail: { kind, id } }));
}

/** Stage progress at a glance: 2/4 with a segmented micro-bar. */
export function StageDots({ stages }: { stages: { name: string; done: boolean }[] }) {
  if (!stages || stages.length === 0) return null;
  const done = stages.filter((s) => s.done).length;
  const next = stages.find((s) => !s.done);
  return (
    <span
      title={next ? `Next: ${next.name}` : "All stages done"}
      className="inline-flex flex-none items-center gap-1 rounded-full bg-surface-2 px-1.5 py-px text-[10px] text-muted"
    >
      <span className="flex gap-[2px]">
        {stages.map((s, i) => (
          <span
            key={i}
            className={`h-[7px] w-[7px] rounded-[2px] ${s.done ? "bg-ok" : "bg-faint/40"}`}
          />
        ))}
      </span>
      {done}/{stages.length}
    </span>
  );
}

/** Marks recurring tasks so the dashboard makes them recognizable. */
export function RepeatChip({ recurrence }: { recurrence: string | null }) {
  if (!recurrence) return null;
  return (
    <span
      title={`Repeats ${recurrence}`}
      className="inline-flex flex-none items-center gap-0.5 rounded-full bg-surface-2 px-1.5 py-px text-[10px] text-muted"
    >
      <Repeat size={10} strokeWidth={2} />
      {recurrence}
    </span>
  );
}

/** Small clock chip for rows/cards that carry reminders. */
export function ReminderChip({ reminders }: { reminders?: string[] }) {
  if (!reminders || reminders.length === 0) return null;
  return (
    <span
      title={`${reminders.length} reminder${reminders.length > 1 ? "s" : ""}`}
      className="inline-flex flex-none items-center gap-0.5 rounded-full bg-surface-2 px-1.5 py-px text-[10px] text-muted"
    >
      <AlarmClock size={10} strokeWidth={2} />
      {reminders.length}
    </span>
  );
}

export const STATUS_LABEL: Record<TaskRow["status"], string> = {
  inbox: "inbox",
  todo: "to do",
  in_progress: "in progress",
  blocked: "blocked",
  done: "done",
  dropped: "dropped",
};

export function isOverdue(t: TaskRow) {
  return (
    t.dueAt !== null &&
    !["done", "dropped"].includes(t.status) &&
    new Date(t.dueAt).getTime() < Date.now()
  );
}

export function fmtDue(dueAt: string | null) {
  if (!dueAt) return "—";
  const d = new Date(dueAt);
  const now = new Date();
  const diffDays = Math.floor((d.getTime() - now.getTime()) / 86400000);
  if (diffDays < -1) return `${-diffDays}d late`;
  if (diffDays === -1 || (diffDays === 0 && d < now)) return "yesterday";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
}

export function ProvenanceLink({ t }: { t: TaskRow }) {
  if (!t.conversationId) return null;
  return (
    <Link
      href={`/chat?c=${t.conversationId}${t.messageId ? `&m=${t.messageId}` : ""}`}
      title={t.conversationLabel ?? "From a conversation"}
      aria-label={t.conversationLabel ?? "From a conversation"}
      onClick={(e) => e.stopPropagation()}
      className="text-faint transition-colors hover:text-accent"
    >
      <MessageSquare size={13} strokeWidth={1.75} />
    </Link>
  );
}

export function CheckButton({
  t,
  onDone,
}: {
  t: TaskRow;
  onDone: (id: string) => void;
}) {
  const done = t.status === "done";
  return (
    <button
      disabled={done}
      onClick={(e) => {
        e.stopPropagation();
        onDone(t.id);
      }}
      title="Mark done"
      aria-label="Mark done"
      className={`flex h-5 w-5 flex-none items-center justify-center rounded-full border transition-colors ${
        done
          ? "border-ok/50 bg-ok/20 text-ok"
          : "border-edge text-transparent hover:border-ok hover:text-ok"
      }`}
    >
      <Check size={12} strokeWidth={2.5} />
    </button>
  );
}
