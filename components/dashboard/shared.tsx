"use client";

// Shared shapes + primitives for every dashboard view (List/Board/Calendar/
// Timeline/Adaptive): row types, due-date formatting, the cross-off button,
// and provenance links.
import Link from "next/link";

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
};

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
      className="text-xs text-faint hover:text-accent"
    >
      💬
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
      onClick={() => onDone(t.id)}
      title="Mark done"
      className={`flex h-5 w-5 flex-none items-center justify-center rounded-full border text-[11px] transition-colors ${
        done
          ? "border-ok/50 bg-ok/20 text-ok"
          : "border-edge text-transparent hover:border-ok hover:text-ok"
      }`}
    >
      ✓
    </button>
  );
}
