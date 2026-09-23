// GET/POST /api/understanding — the Settings section for the understanding
// loop (docs/understanding/SPEC.md §8, §11 phase 6).
//
// GET is what the sweep would do and what it last did: provider and model
// derived from the environment without building a client, the cadence, the
// latest run per active project, and the open question count. POST is the
// "Understand now" button: runAll for the signed-in user, one per minute,
// and the response waits for it, so the numbers it returns are real.
import { NextResponse } from "next/server";
import { z } from "zod";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { checkUnderstandNowQuota } from "@/lib/rate-limit";
import { providerHealth } from "@/lib/understanding/provider-health";
import { runAll } from "@/lib/understanding/run";
import {
  describeProvider,
  hasConnectedAnthropic,
  latestRunPerProject,
  openQuestionCount,
  sweepMinutes,
  tallyResults,
  understandingDisabled,
} from "@/lib/understanding/sweep";

const bodySchema = z.object({
  /** Call the model for every active project even where the hash matches. */
  force: z.boolean().optional(),
});

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const [projects, questionsOpen, connectedAnthropic, health] = await Promise.all([
    latestRunPerProject(user.id),
    openQuestionCount(user.id),
    hasConnectedAnthropic(user.id),
    providerHealth(user.id),
  ]);
  const { provider, model } = describeProvider({ connectedAnthropic });
  return NextResponse.json({
    // The contract's provider object (GET /api/understanding/progress): can
    // the models be used right now, and if not, why and what to do.
    provider: health,
    // Which provider and model a run would use, as describeProvider says.
    providerId: provider,
    model,
    sweepMinutes: sweepMinutes(),
    disabled: understandingDisabled(),
    projects,
    questionsOpen,
  });
}

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  // SPEC §8: with UNDERSTANDING_DISABLED "the sweep and every run return at
  // once, nothing is read". runAll would still gather and hash every active
  // project and log a skipped row per changed one; refusing here keeps the
  // sentence true. The Settings button is disabled client-side for the same
  // reason, so this is the answer for anyone calling the route directly.
  if (understandingDisabled()) {
    return NextResponse.json({ error: "Turned off (UNDERSTANDING_DISABLED)." }, { status: 409 });
  }

  const quota = checkUnderstandNowQuota(user.id);
  if (!quota.ok) return NextResponse.json({ error: quota.message }, { status: quota.status });

  const { results, retiredAsr } = await runAll(user.id, {
    timezone: user.timezone,
    force: parsed.force,
  });
  return NextResponse.json({ ...tallyResults(results), retiredAsr, results });
}
