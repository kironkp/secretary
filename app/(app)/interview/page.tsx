// The Interview (the user's words: "a new tab called interview bot ... set up
// to organize the data"). Server component: the whole open queue is read
// once, so the first paint already carries the first question; the client
// keeps it fresh from /api/interview after that and never waits for a run
// (docs/understanding/SPEC.md §8, "never on read").
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { buildInterview } from "@/lib/understanding/today";
import { InterviewView } from "@/components/interview/interview-view";
import { footerLine } from "@/components/interview/words";

export default async function InterviewPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";
  const data = await buildInterview(session.user.id, timezone);
  // "last read 3 minutes ago" is written once, here, and handed down: a
  // client that computed its own on hydration could disagree with this
  // render across a minute boundary, and React would warn. The client
  // rewrites it whenever it refreshes the data.
  return (
    <InterviewView initial={data} initialFooter={footerLine(data.answeredToday, data.lastRunAt, new Date())} />
  );
}
