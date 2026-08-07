import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getTodayStrip } from "@/lib/db/queries";
import { NavTabs } from "@/components/shell/nav-tabs";
import { ThemeToggle } from "@/components/shell/theme";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";
  const strip = await getTodayStrip(session.user.id, timezone);

  const nextEventLabel = strip.nextEvent
    ? `📅 ${strip.nextEvent.title} · ${new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
      }).format(strip.nextEvent.startsAt)}`
    : null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 border-b border-edge bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <span className="text-sm font-bold tracking-tight text-accent">Secretary</span>
          <div className="flex flex-1 items-center justify-end gap-2 overflow-x-auto text-xs">
            {nextEventLabel && (
              <span className="whitespace-nowrap rounded-full border border-edge bg-card px-3 py-1 text-muted">
                {nextEventLabel}
              </span>
            )}
            <span
              className={`whitespace-nowrap rounded-full border px-3 py-1 ${
                strip.overdueCount > 0
                  ? "border-danger/50 bg-danger/10 text-danger"
                  : "border-edge bg-card text-faint"
              }`}
            >
              {strip.overdueCount} overdue
            </span>
            <span className="whitespace-nowrap rounded-full border border-edge bg-card px-3 py-1 text-muted">
              {strip.dueTodayCount} due today
            </span>
            <ThemeToggle />
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-4">
          <NavTabs />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}
