// Server component: fetches everything the dashboard needs and renders the
// client views. Used by /dashboard and by the chat split workspace, so both
// stay in lockstep.
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects as projectsTable } from "@/lib/db/schema";
import { getDocumentsWithProject, getEventsWithProject, getTasksWithContext } from "@/lib/db/queries";
import { getCurrentLayout, maybeRegenerateLayout } from "@/lib/layout/generator";
import { computeCurrentPlan, persistPlan } from "@/lib/layout/plan-store";
import type { PlanBundle } from "@/lib/layout/plan-store";
import type { PlanProject } from "./plan-view";
import type { DocRow } from "./shared";
import { DashboardViews, type EventRow, type TaskRow } from "./dashboard-views";

// SPEC Phase 1 feature flag: "plan" = LayoutPlan v2 pipeline (registry v2,
// rules planner, validator); unset/other = the v0 arranger, untouched.
const ADAPTIVE_V2 = process.env.ADAPTIVE_V2 === "true";

export async function DashboardPanel({
  userId,
  timezone,
  compact = false,
}: {
  userId: string;
  timezone: string;
  compact?: boolean;
}) {
  const [rows, eventRows, docRows, layout, planBundle, projectRows] = await Promise.all([
    getTasksWithContext(userId),
    getEventsWithProject(userId),
    getDocumentsWithProject(userId),
    getCurrentLayout(userId),
    ADAPTIVE_V2 ? computeCurrentPlan(userId) : Promise.resolve(null),
    ADAPTIVE_V2
      ? db
          .select({
            id: projectsTable.id,
            name: projectsTable.name,
            color: projectsTable.color,
            parentId: projectsTable.parentId,
          })
          .from(projectsTable)
          .where(eq(projectsTable.userId, userId))
      : Promise.resolve([] as PlanProject[]),
  ]);

  if (ADAPTIVE_V2 && planBundle) {
    // Persist plan history in the background; render never waits on writes.
    after(() => persistPlan(userId, planBundle as PlanBundle));
  } else {
    // v0: refresh the AI arrangement in the background when the data shape changed.
    after(() => maybeRegenerateLayout(userId));
  }

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
    reminders: task.reminders ?? [],
    stages: task.stages ?? [],
    recurrence: task.recurrence,
    projectId: task.projectId,
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

  const events: EventRow[] = eventRows.map(({ event: e, projectName }) => ({
    id: e.id,
    title: e.title,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt?.toISOString() ?? null,
    location: e.location,
    notes: e.notes,
    reminders: e.reminders ?? [],
    projectId: e.projectId,
    projectName,
    source: e.source,
    createdAt: e.createdAt.toISOString(),
  }));

  const docs: DocRow[] = docRows.map(({ doc, projectName }) => ({
    id: doc.id,
    title: doc.title,
    projectName,
    headings: doc.sections.map((s) => s.heading),
    updatedAt: doc.updatedAt.toISOString(),
    sectionCount: doc.sections.length,
    hasContent: doc.sections.some((s) => s.content.trim().length > 0),
  }));

  return (
    <DashboardViews
      tasks={tasks}
      suggestions={suggestions}
      events={events}
      docs={docs}
      layout={layout.spec}
      layoutVersion={layout.version}
      layoutPinned={layout.pinned}
      layoutUpdatedAt={layout.updatedAt?.toISOString() ?? null}
      plan={planBundle?.plan ?? null}
      planVersion={planBundle?.version ?? 0}
      planPinned={planBundle?.pinned ?? []}
      planProjects={projectRows}
      compact={compact}
    />
  );
}
