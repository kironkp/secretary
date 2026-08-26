import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getTodayStrip } from "@/lib/db/queries";
import { FloatingChat } from "@/components/chat/floating-chat";
import { VoiceCallProvider } from "@/components/chat/voice-call-provider";
import { DetailDialog } from "@/components/shell/detail-dialog";
import { EventChipButton } from "@/components/shell/event-chip";
import { NavTabs } from "@/components/shell/nav-tabs";
import { SplitToggle } from "@/components/shell/split-toggle";
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
    ? `${strip.nextEvent.title} · ${new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "2-digit",
      }).format(strip.nextEvent.startsAt)}`
    : null;

  return (
    // VoiceCallProvider wraps the whole shell: a live call is owned HERE, so
    // switching tabs (or opening the floating chat) never hangs it up.
    <VoiceCallProvider>
    <div className="flex h-dvh flex-col">
      <header className="z-10 flex-none border-b border-edge bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3">
          <span className="text-sm font-bold tracking-tight text-accent">Secretary</span>
          <div className="flex flex-1 items-center justify-end gap-2 overflow-x-auto text-xs">
            {nextEventLabel && strip.nextEvent && (
              <EventChipButton id={strip.nextEvent.id} label={nextEventLabel} />
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
            <SplitToggle />
            <ThemeToggle />
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-4">
          <NavTabs />
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto h-full w-full max-w-7xl px-4">{children}</div>
      </main>
      <DetailDialog />
      <FloatingChat />
    </div>
    </VoiceCallProvider>
  );
}
