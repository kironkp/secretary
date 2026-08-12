import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { documents, events, projects, tasks } from "@/lib/db/schema";
import { ProjectView } from "@/components/projects/project-view";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const userId = session.user.id;
  const { id } = await params;

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .limit(1);
  if (!project) notFound();

  const [taskRows, eventRows, docRows] = await Promise.all([
    db.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.projectId, id))),
    db.select().from(events).where(and(eq(events.userId, userId), eq(events.projectId, id))),
    db.select().from(documents).where(and(eq(documents.userId, userId), eq(documents.projectId, id))),
  ]);

  return (
    <ProjectView
      id={project.id}
      initialName={project.name}
      initialColor={project.color}
      initialStatus={project.status}
      tasks={taskRows.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dueAt: t.dueAt?.toISOString() ?? null,
        reminders: t.reminders ?? [],
        stages: t.stages ?? [],
        recurrence: t.recurrence,
        source: t.source,
      }))}
      events={eventRows.map((e) => ({
        id: e.id,
        title: e.title,
        startsAt: e.startsAt.toISOString(),
        location: e.location,
        reminders: e.reminders ?? [],
      }))}
      docs={docRows.map((d) => ({
        id: d.id,
        title: d.title,
        updatedAt: d.updatedAt.toISOString(),
        sectionCount: d.sections.length,
      }))}
    />
  );
}
