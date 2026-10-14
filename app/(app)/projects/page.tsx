// The Projects tab (SEC-A006; the approved look and his order since v1.11,
// docs/projects/SPEC.md §5): each group one white card on the grey ground,
// in his order, a grab handle on every row. Active first, then Lists, then
// the projects set aside (someday and archived).
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listProjects, type ProjectListRow } from "@/lib/projects/list";
import { ProjectList, type ProjectRowView } from "@/components/projects/project-list";

const view = (p: ProjectListRow): ProjectRowView => ({
  id: p.id,
  name: p.name,
  color: p.color,
  count: p.kind === "list" ? `${p.open} to get` : `${p.open} open`,
});

function Group({ group, title, rows }: { group: string; title?: string; rows: ProjectListRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col">
      {title && <h2 className="px-1 pb-2 pt-4 text-[20px] font-bold leading-[26px]">{title}</h2>}
      <ProjectList group={group} rows={rows.map(view)} />
    </section>
  );
}

export default async function ProjectsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";
  const rows = await listProjects(session.user.id, timezone);
  return (
    <div data-projects-screen="" className="mx-auto flex min-h-full max-w-2xl flex-col bg-bg pb-6">
      <div className="flex items-center justify-between pb-3 pt-5">
        <h1 className="text-[34px] font-bold leading-[40px]">Projects</h1>
      </div>
      {rows.length === 0 && (
        <p className="text-[15px] text-muted">No projects yet. Mention one in a chat or a call and it lands here.</p>
      )}
      <div className="flex flex-col gap-[10px]">
        <Group group="active" rows={rows.filter((p) => p.group === "active")} />
        <Group group="lists" title="Lists" rows={rows.filter((p) => p.group === "lists")} />
        <Group group="set_aside" title="Set aside" rows={rows.filter((p) => p.group === "set_aside")} />
      </div>
    </div>
  );
}
