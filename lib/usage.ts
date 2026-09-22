// One place to record what a model call cost.
//
// Before this there were eight independent `db.insert(usage)` sites and no
// helper, which is exactly why the expensive ones were missing: the canvas
// painter — a multi-thousand-token generation, sometimes several per
// conversation — recorded nothing at all, so the usage table understated real
// spend. A single entry point means a new call site has one obvious thing to
// call, and a missing one is visible as an "other" row rather than as silence.
//
// Recording NEVER throws and never blocks the thing being measured: failing to
// bill a call is not a reason to fail the call.
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";
import { priceUsage } from "@/lib/pricing";

export type UsageKind =
  | "voice"
  | "transcribe"
  | "extraction"
  | "layout"
  | "chat"
  | "consult"
  | "paint"
  | "slow_loop"
  | "email"
  | "speech"
  // The understanding loop (docs/understanding/SPEC.md §4): per-token, priced
  // by model like every other structured call. lib/pricing.ts keys rates on
  // the model id, so the kind needs no rate of its own.
  | "understanding"
  | "other";

export type UsageRecord = {
  userId: string;
  kind: UsageKind;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  /** Wall-clock for time-billed things (a voice session, a transcription). */
  seconds?: number;
  /** Characters for character-billed things (speech synthesis). Stored in
   *  inputTokens so one column carries "how much", with the kind saying what
   *  the unit means — see lib/pricing.ts. */
  characters?: number;
  /** Realtime: how much of the token count was AUDIO. Audio costs 8× text
   *  under the same model id, so without this a voice row is unpriceable
   *  within a factor of eight. */
  audioInputTokens?: number | null;
  audioOutputTokens?: number | null;
  /** Re-read input, billed at a tenth. */
  cachedInputTokens?: number | null;
};

/** Fire-and-forget. Await it when you are already awaiting other writes. */
export async function recordUsage(entry: UsageRecord): Promise<void> {
  try {
    const inputTokens = Math.max(0, Math.round(entry.inputTokens ?? entry.characters ?? 0));
    const outputTokens = Math.max(0, Math.round(entry.outputTokens ?? 0));
    const seconds = Math.max(0, Math.round(entry.seconds ?? 0));
    // Priced at insert so a rate change never rewrites what was already spent.
    const priced = priceUsage({
      model: entry.model,
      kind: entry.kind,
      inputTokens,
      outputTokens,
      seconds,
      audioInputTokens: entry.audioInputTokens ?? null,
      audioOutputTokens: entry.audioOutputTokens ?? null,
      cachedInputTokens: entry.cachedInputTokens ?? null,
    });
    await db.insert(usage).values({
      userId: entry.userId,
      kind: entry.kind,
      model: entry.model ?? null,
      seconds,
      inputTokens,
      outputTokens,
      audioInputTokens: entry.audioInputTokens ?? null,
      audioOutputTokens: entry.audioOutputTokens ?? null,
      cachedInputTokens: entry.cachedInputTokens ?? null,
      costUsd: priced.usd.toFixed(6),
      costEstimated: priced.estimated || !priced.known,
    });
  } catch (e) {
    // A spend row is bookkeeping. Losing one must never break the feature that
    // generated it, but it should be loud in the log so gaps get noticed.
    console.error(
      `usage: failed to record ${entry.kind}${entry.model ? ` (${entry.model})` : ""}:`,
      e instanceof Error ? e.message : e
    );
  }
}
