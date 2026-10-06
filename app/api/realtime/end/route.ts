import { NextResponse } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, usage } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { runExtraction } from "@/lib/secretary/extraction";
import { REALTIME_TRANSCRIBE_MODEL } from "@/lib/openai";
import { priceRealtime, priceUsage } from "@/lib/pricing";

const bodySchema = z.object({
  usageId: z.string(),
  conversationId: z.string().nullish(),
  seconds: z.number().int().min(1).max(24 * 60 * 60),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
  /** The billed split (SEC-A004): without it a call was stored with no price. */
  split: z
    .object({
      textIn: z.number().int().min(0),
      audioIn: z.number().int().min(0),
      cachedTextIn: z.number().int().min(0),
      cachedAudioIn: z.number().int().min(0),
      textOut: z.number().int().min(0),
      audioOut: z.number().int().min(0),
    })
    .optional(),
});

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  const [row] = await db
    .select({ model: usage.model })
    .from(usage)
    .where(and(eq(usage.id, parsed.usageId), eq(usage.userId, user.id)));
  if (!row) return NextResponse.json({ ok: true });
  // Priced now (SEC-A004): every call was stored with cost_usd null, which
  // Settings, the spend alert and the caps all read as $0. With the split,
  // to the token; without it (an old client), as all-fresh audio, the
  // expensive guess, flagged as estimated.
  const session = parsed.split
    ? priceRealtime(row.model, parsed.split)
    : priceUsage({ model: row.model, kind: "voice", inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens, seconds: parsed.seconds });
  // The call's own transcription is billed per minute of audio, apart from the
  // session; it is counted on this row, not a row of its own, so it does not
  // use up the dictation quota (which counts "transcribe" rows).
  const listening = priceUsage({ model: REALTIME_TRANSCRIBE_MODEL, kind: "transcribe", inputTokens: 0, outputTokens: 0, seconds: parsed.seconds });
  const priced = { usd: session.usd + listening.usd, known: session.known && listening.known, estimated: session.estimated };
  await db
    .update(usage)
    .set({
      seconds: parsed.seconds,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      ...(parsed.split
        ? {
            audioInputTokens: parsed.split.audioIn,
            audioOutputTokens: parsed.split.audioOut,
            cachedInputTokens: parsed.split.cachedTextIn + parsed.split.cachedAudioIn,
          }
        : {}),
      costUsd: priced.usd.toFixed(6),
      costEstimated: priced.estimated || !priced.known,
    })
    .where(and(eq(usage.id, parsed.usageId), eq(usage.userId, user.id)));


  if (parsed.conversationId) {
    const conversationId = parsed.conversationId;
    await db
      .update(conversations)
      .set({ endedAt: new Date() })
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));
    // Safety-net extraction (Flow 2) — after the response, never blocking it.
    after(() => runExtraction(user.id, conversationId, user.timezone));
  }

  return NextResponse.json({ ok: true });
}
