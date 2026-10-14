// The Projects tab (SEC-A006; the approved look and his order since v1.11,
// docs/projects/SPEC.md §5): each group one white card on the grey ground,
// in his order, a grab handle on every row, and the "New project" button.
// Active first, then Lists, then the projects set aside (someday, archived).
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listProjects, type ProjectListRow } from "@/lib/projects/list";
import { type ProjectRowView } from "@/components/projects/project-list";
import { ProjectsScreen } from "@/components/projects/projects-screen";

const view = (p: ProjectListRow): ProjectRowView => ({
  id: p.id,
  name: p.name,
  color: p.color,
  count: p.kind === "list" ? `${p.open} to get` : `${p.open} open`,
});

export default async function ProjectsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";
  const rows = await listProjects(session.user.id, timezone);
  return (
    <div data-projects-screen="" className="mx-auto flex min-h-full max-w-2xl flex-col bg-bg pb-6">
      <ProjectsScreen
        groups={{
          active: rows.filter((p) => p.group === "active").map(view),
          lists: rows.filter((p) => p.group === "lists").map(view),
          setAside: rows.filter((p) => p.group === "set_aside").map(view),
        }}
      />
    </div>
  );
}
