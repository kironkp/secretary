// Tool execution endpoint for the voice path. The Realtime model decides WHAT
// to do; this route is the only thing that can actually touch the database,
// and it re-validates everything against the user's session.
import { NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages } from "@/lib/db/schema";
import { nextClarification } from "@/lib/secretary/entities";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { executeTool } from "@/lib/secretary/tools";

const bodySchema = z.object({
  name: z.string(),
  args: z.unknown().optional(),
  conversationId: z.string().nullish(),
  // The call's flavor (lib/secretary/interview-voice.ts): on an interview
  // call answer_question also returns the next question to ask.
  surface: z.enum(["interview"]).optional(),
});

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  // Provenance: anchor to the latest user message in this (owned) conversation.
  let conversationId: string | undefined;
  let anchorMessageId: string | undefined;
  if (parsed.conversationId) {
    const [owned] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.id, parsed.conversationId), eq(conversations.userId, user.id))
      )
      .limit(1);
    if (owned) {
      conversationId = owned.id;
      const [lastUserMsg] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, owned.id),
            eq(messages.userId, user.id),
            eq(messages.role, "user")
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(1);
      anchorMessageId = lastUserMsg?.id;
    }
  }

  const outcome = await executeTool(
    { userId: user.id, timezone: user.timezone, conversationId, anchorMessageId, surface: parsed.surface },
    parsed.name,
    parsed.args
  );

  // SPEC §11: the async extractor queues clarifications while the call runs;
  // tool results are the injection channel back into the realtime session.
  // At most one rides along, marked asked — the model raises it at the next
  // natural pause, never mid-flow.
  // Not on an interview call: that call's one job is the understanding
  // queue, and while it is open the ASR queue waits (SPEC §6, "Voice").
  if (
    parsed.surface !== "interview" &&
    parsed.name !== "queue_clarification" &&
    parsed.name !== "resolve_clarification"
  ) {
    const clarification = await nextClarification(user.id);
    if (clarification && outcome.result && typeof outcome.result === "object") {
      (outcome.result as Record<string, unknown>).ask_at_next_pause = clarification.question;
    }
  }

  return NextResponse.json(outcome);
}
