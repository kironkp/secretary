// A question, opened (docs/understanding/SPEC.md §9). Server component: the
// row and its evidence are resolved here, scoped to the signed-in user, and
// handed down as plain props.
//
// A resolved or dismissed question still renders, marked as such, rather than
// 404ing: the user reaches this page by tapping a row that may have been
// answered by voice a moment ago, and "you answered this one already" is the
// truthful screen. Only a question that is not this user's, or does not
// exist, is a 404.
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getQuestion } from "@/lib/understanding/questions";
import { viewQuestion } from "@/lib/understanding/today";
import { QuestionView } from "@/components/today/question-view";

export default async function QuestionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");
  const { id } = await params;

  const row = await getQuestion(session.user.id, id);
  if (!row) notFound();

  const timezone = (session.user as { timezone?: string }).timezone ?? "UTC";
  const view = await viewQuestion(session.user.id, row, timezone);
  return <QuestionView initial={view} />;
}
