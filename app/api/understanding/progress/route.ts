// GET /api/understanding/progress — what the understanding loop is doing
// for the signed-in user, for the screen to show while it waits
// (docs/understanding/SPEC.md §8):
//   active    the runs in flight, phase by phase, from memory
//   recent    the runs finished in the last five minutes, from memory
//   lastRun   the newest ok or failed run row, always, so a fresh dyno still
//             has something true to say
//   provider  whether the models can be used right now and, if not, why
//             and what to do (lib/understanding/provider-health.ts)
// Every line is authored on the server. Cheap enough to poll: no model, a
// memory snapshot and two small queries at most.
import { NextResponse } from "next/server";
import { isErrorResponse, requireSession } from "@/lib/api";
import { snapshot } from "@/lib/understanding/progress";
import { providerHealth } from "@/lib/understanding/provider-health";
import { lastRunFor } from "@/lib/understanding/sweep";

export async function GET() {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const [lastRun, provider] = await Promise.all([lastRunFor(user.id), providerHealth(user.id)]);
  return NextResponse.json(
    { ...snapshot(user.id), lastRun, provider },
    { headers: { "Cache-Control": "no-store" } }
  );
}
