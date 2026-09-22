// Today (docs/understanding/SPEC.md §9). Server component: it reads the last
// record and the ranked queue once, so the first paint already carries the
// hero question; the client keeps it fresh from /api/today after that and
// never waits for a run (§8, "never on read").
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildToday } from "@/lib/understanding/today";
import { dateLine } from "@/components/today/copy";
import { TodayView } from "@/components/today/today-view";

export default async function TodayPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";
  const data = await buildToday(session.user.id, timezone);
  // The date line is written once, here, and handed down with the data: a
  // client that computed its own on hydration would disagree with this
  // render across midnight, and React would warn. The client refreshes it
  // whenever it refreshes the data.
  return <TodayView initial={data} today={dateLine(new Date(), timezone)} timezone={timezone} />;
}
