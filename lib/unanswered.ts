// A paid call that was sent and did not come back is still counted
// (docs/spend/SPEC.md §1.2). The provider received the request and may have
// done the work; the app's own timeout, a dropped connection or a cut stream
// only means the app never saw the usage. Until v1.04 such a call left no
// row, so no cap could see it.
import { recordUsage, type UsageKind } from "@/lib/usage";

/**
 * Bytes per token, as a floor: the estimate must not be below what was sent.
 * Measured on this app's own requests on 2026-10-12 (docs/jarvis/BASELINE.md),
 * a token is 2.4 to 3.0 characters, so two bytes a token errs high.
 */
const BYTES_PER_TOKEN = 2;

/** Tokens for everything a request carried, not below the real count. */
export function estimateSentTokens(parts: (string | null | undefined)[]): number {
  const bytes = parts.reduce((n, part) => n + Buffer.byteLength(part ?? "", "utf8"), 0);
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/**
 * Whether a call that threw may have cost money. A provider that refused
 * before doing any work says so with an HTTP 4xx (a rate limit, a bad key,
 * no credit, a malformed request): that cost nothing. Anything else, our own
 * timeout included, may have been worked on and is counted.
 */
export function mayHaveBeenBilled(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return !(typeof status === "number" && status >= 400 && status < 500);
}

/**
 * The row for a call that was sent and never answered: the input as a floor,
 * no output (it is not guessed), marked estimated. A model nobody named is
 * priced at the ceiling, like any unknown model.
 */
export async function recordUnanswered(entry: {
  userId: string;
  kind: UsageKind;
  model: string | null;
  inputTokens: number;
}): Promise<void> {
  await recordUsage({ userId: entry.userId, kind: entry.kind, model: entry.model, inputTokens: entry.inputTokens, outputTokens: 0, estimated: true });
}
