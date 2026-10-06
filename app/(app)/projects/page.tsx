// The Projects tab (SEC-A006): a plain list of the user's projects, each row
// opening its project page. Lists (Shopping) sit apart; projects set aside
// (someday, archived) come last, quieter.
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { auth } from "@/lib/auth";
import { listProjects, type ProjectListRow } from "@/lib/projects/list";

function Row({ p }: { p: ProjectListRow }) {
  return (
    <li>
      <Link
        href={`/projects/${p.id}`}
        className="flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-surface-2/50"
      >
        <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: p.color ?? "var(--color-accent)" }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold">{p.name}</span>
          <span className="block text-xs text-faint">
            {p.kind === "list"
              ? `${p.open} to get`
              : [`${p.open} open`, p.pastDue ? `${p.pastDue} past due` : null, p.next && !p.pastDue ? `next ${p.next}` : null]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
        </span>
        <ChevronRight size={16} strokeWidth={2} className="flex-none text-faint" />
      </Link>
    </li>
  );
}

function Group({ title, rows }: { title: string; rows: ProjectListRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="mb-1 px-3 text-xs font-bold uppercase tracking-wide text-faint">{title}</h2>
      <ul className="divide-y divide-sep rounded-2xl border border-edge bg-surface">
        {rows.map((p) => (
          <Row key={p.id} p={p} />
        ))}
      </ul>
    </section>
  );
}

export default async function ProjectsPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";
  const rows = await listProjects(session.user.id, timezone);
  const projects = rows.filter((p) => p.kind === "project");
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 py-6">
      <h1 className="text-[34px] font-bold leading-[1.2] tracking-[-0.01em]">Projects</h1>
      {rows.length === 0 && (
        <p className="text-sm text-muted">No projects yet. Mention one in a chat or a call and it lands here.</p>
      )}
      <Group title="Active" rows={projects.filter((p) => p.status === "active")} />
      <Group title="Lists" rows={rows.filter((p) => p.kind === "list")} />
      <Group title="Set aside" rows={projects.filter((p) => p.status !== "active")} />
    </div>
  );
}
