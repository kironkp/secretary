// POST /api/interview/more — "Ask me more" on the Interview tab: every active
// project is read again, forced past the hash, in interview mode (the prompt
// gains lib/understanding/prompt.ts INTERVIEW_ADDENDUM), and the response
// waits for it so the numbers are real. The same one-per-minute limit as
// Settings' "Understand now", and the same window: both are runAll for this
// user, and two of them a few seconds apart would pay for the same reading.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { checkUnderstandNowQuota } from "@/lib/rate-limit";
import { providerHealth } from "@/lib/understanding/provider-health";
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
  // A reopened question (a closed identity back with new evidence) is a new
  // card to the user, so it counts with the created ones.
  const questionsCreated = Object.values(results).reduce(
    (n, r) =>
      n + (r.status === "ok" ? r.questions.created.length + r.questions.reopened.length : 0),
    0
  );
  // Every project failed and the models are the reason: say so, and what to
  // do, rather than report a reading that found nothing to ask. Still 200:
  // the numbers are real.
  if (ran === 0 && failed > 0) {
    const health = await providerHealth(user.id);
    if (!health.ok) {
      return NextResponse.json({
        ran,
        failed,
        questionsCreated,
        error: health.line,
        action: health.action,
      });
    }
  }
  return NextResponse.json({ ran, failed, questionsCreated });
}
