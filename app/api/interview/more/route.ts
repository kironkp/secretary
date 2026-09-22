// POST /api/interview/more — "Ask me more" on the Interview tab: every active
// project is read again, forced past the hash, in interview mode (the prompt
// gains lib/understanding/prompt.ts INTERVIEW_ADDENDUM), and the response
// waits for it so the numbers are real. The same one-per-minute limit as
// Settings' "Understand now", and the same window: both are runAll for this
// user, and two of them a few seconds apart would pay for the same reading.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { checkUnderstandNowQuota } from "@/lib/rate-limit";
import { runAll, runInFlight } from "@/lib/understanding/run";
import { tallyResults, understandingDisabled } from "@/lib/understanding/sweep";

export async function POST() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  // SPEC §8: with UNDERSTANDING_DISABLED nothing is read; say so rather than
  // gathering every project only to skip each one.
  if (understandingDisabled()) {
    return NextResponse.json({ error: "Turned off (UNDERSTANDING_DISABLED)." }, { status: 409 });
  }

  // A sweep already running for this user (the ten-minute one, or a second
  // tap) makes runAll return empty at once; reported as a reading that found
  // nothing, that would tell the user there is nothing to ask when nothing
  // was read. Say so instead, before the quota is spent, and the client
  // polls the queue for that run to finish.
  const BUSY = { error: "Already reading your projects." };
  if (runInFlight(user.id)) return NextResponse.json(BUSY, { status: 409 });

  const quota = checkUnderstandNowQuota(user.id);
  if (!quota.ok) return NextResponse.json({ error: quota.message }, { status: quota.status });

  const { results, busy } = await runAll(user.id, {
    timezone: user.timezone,
    force: true,
    mode: "interview",
  });
  if (busy) return NextResponse.json(BUSY, { status: 409 });
  const { ran, failed } = tallyResults(results);
  const questionsCreated = Object.values(results).reduce(
    (n, r) => n + (r.status === "ok" ? r.questions.created.length : 0),
    0
  );
  return NextResponse.json({ ran, failed, questionsCreated });
}
