import { headers } from "next/headers";
import { after } from "next/server";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getEvents, getTasksWithContext } from "@/lib/db/queries";
import { getCurrentLayout, maybeRegenerateLayout } from "@/lib/layout/generator";
import { DashboardViews, type EventRow, type TaskRow } from "@/components/dashboard/dashboard-views";

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";
  const userId = session.user.id;

  const [rows, eventRows, layout] = await Promise.all([
    getTasksWithContext(userId),
    getEvents(userId),
    getCurrentLayout(userId),
  ]);

  // Refresh the AI arrangement in the background when the data shape changed.
  after(() => maybeRegenerateLayout(userId));

  const allTasks: TaskRow[] = rows.map(({ task, projectName, projectColor, fromConversationAt }) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    dueAt: task.dueAt?.toISOString() ?? null,
    updatedAt: task.updatedAt.toISOString(),
    postponedCount: task.postponedCount,
    priority: task.priority,
    procrastinationScore: task.procrastinationScore,
    source: task.source,
    notes: task.notes,
    projectName,
    projectColor,
    conversationId: task.createdFromConversationId,
    messageId: task.createdFromMessageId,
    conversationLabel: fromConversationAt
      ? `From ${new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(fromConversationAt)}'s conversation`
      : null,
  }));

  // Pending suggestions live in their own zone, never in the main views.
  const suggestions = allTasks.filter((t) => t.source === "suggested" && t.status === "inbox");
  const tasks = allTasks.filter((t) => !(t.source === "suggested" && t.status === "inbox"));

  const events: EventRow[] = eventRows.map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt?.toISOString() ?? null,
    location: e.location,
  }));

  return (
    <DashboardViews
      tasks={tasks}
      suggestions={suggestions}
      events={events}
      layout={layout.spec}
      layoutVersion={layout.version}
      layoutPinned={layout.pinned}
      layoutUpdatedAt={layout.updatedAt?.toISOString() ?? null}
    />
  );
}
