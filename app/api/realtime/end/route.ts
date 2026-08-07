import { NextResponse } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, usage } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { runExtraction } from "@/lib/secretary/extraction";

const bodySchema = z.object({
  usageId: z.string(),
  conversationId: z.string().nullish(),
  seconds: z.number().int().min(1).max(24 * 60 * 60),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
});

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  await db
    .update(usage)
    .set({
      seconds: parsed.seconds,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
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
