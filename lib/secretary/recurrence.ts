// Recurring tasks (the rent problem): say it once, it keeps coming back.
// Completing a recurring task spawns the next occurrence — same title,
// project, stages (reset), recurrence — with the due date advanced and any
// reminders shifted by the same delta. No cron: completion is the trigger.
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";

export const RECURRENCES = ["daily", "weekly", "monthly", "yearly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export function isRecurrence(s: string): s is Recurrence {
  return (RECURRENCES as readonly string[]).includes(s);
}

/**
 * Next occurrence of `from`. Monthly clamps to the target month's length
 * (Jan 31 → Feb 28) but remembers nothing — "the 1st" stays the 1st forever,
 * which is the case that matters.
 */
export function nextOccurrence(from: Date, recurrence: Recurrence): Date {
  const d = new Date(from.getTime());
  switch (recurrence) {
    case "daily":
      d.setDate(d.getDate() + 1);
      return d;
    case "weekly":
      d.setDate(d.getDate() + 7);
      return d;
    case "monthly": {
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, daysInMonth));
      return d;
    }
    case "yearly": {
      const day = d.getDate();
      d.setDate(1);
      d.setFullYear(d.getFullYear() + 1);
      const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, daysInMonth));
      return d;
    }
  }
}

type TaskRow = typeof tasks.$inferSelect;

/**
 * If the just-completed task recurs, insert its next occurrence and return it.
 * Base date = its due date (or completion time when it never had one).
 */
export async function spawnNextOccurrence(completed: TaskRow): Promise<TaskRow | null> {
  if (!completed.recurrence || !isRecurrence(completed.recurrence)) return null;
  const base = completed.dueAt ?? new Date();
  const nextDue = nextOccurrence(base, completed.recurrence);
  const delta = nextDue.getTime() - base.getTime();
  const nextReminders = (completed.reminders ?? []).map((iso) =>
    new Date(new Date(iso).getTime() + delta).toISOString()
  );
  const [spawned] = await db
    .insert(tasks)
    .values({
      userId: completed.userId,
      title: completed.title,
      notes: completed.notes,
      projectId: completed.projectId,
      dueAt: nextDue,
      priority: completed.priority,
      reminders: nextReminders,
      stages: (completed.stages ?? []).map((s) => ({ name: s.name, done: false })),
      recurrence: completed.recurrence,
      status: "todo",
      source: completed.source,
      createdFromConversationId: completed.createdFromConversationId,
    })
    .returning();
  return spawned;
}
