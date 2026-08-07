// Text-mode secretary: same persona, same briefing, same tools, same data as
// voice. Runs a tool loop against the Responses API.
import { NextResponse } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages, usage } from "@/lib/db/schema";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { buildBriefing } from "@/lib/secretary/briefing";
import { buildInstructions } from "@/lib/secretary/persona";
import { openAIToolDefs } from "@/lib/secretary/tool-schemas";
import { executeTool, type ToolOutcome } from "@/lib/secretary/tools";
import { runExtraction } from "@/lib/secretary/extraction";
import { openai, TEXT_MODEL } from "@/lib/openai";

const bodySchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().nullish(),
});

const MAX_TOOL_ROUNDS = 8;
const HISTORY_LIMIT = 40;

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  // Conversation: reuse if owned, else create (text mode).
  let conversationId = parsed.conversationId ?? null;
  let storedResponseId: string | null = null;
  if (conversationId) {
    const [owned] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
      .limit(1);
    if (!owned) conversationId = null;
    else storedResponseId = owned.lastResponseId;
  }
  if (!conversationId) {
    const [conv] = await db
      .insert(conversations)
      .values({ userId: user.id, mode: "text" })
      .returning();
    conversationId = conv.id;
  }

  const [userMessage] = await db
    .insert(messages)
    .values({
      userId: user.id,
      conversationId,
      role: "user",
      content: parsed.message,
      mode: "text",
    })
    .returning();

  const history = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.userId, user.id)))
    .orderBy(asc(messages.createdAt))
    .limit(HISTORY_LIMIT);

  const briefing = await buildBriefing(user.id, user.timezone, { consumeNudges: true });
  const instructions = buildInstructions(briefing.text);

  type InputItem = Record<string, unknown>;
  // Reasoning models pair function_call items with reasoning items, so turns
  // and tool rounds are chained via previous_response_id. The chain is only
  // valid if no voice session added messages since it was last stored.
  const prior = history.filter((m) => m.id !== userMessage.id);
  const canChain = Boolean(storedResponseId) && prior.length > 0 && prior[prior.length - 1].mode === "text";
  let input: InputItem[] = canChain
    ? [{ role: "user", content: parsed.message }]
    : prior
        .filter((m) => m.role !== "tool")
        .map((m) => ({ role: m.role, content: m.content }))
        .concat([{ role: "user", content: parsed.message }]);
  let previousResponseId: string | undefined = canChain ? storedResponseId! : undefined;

  const toasts: NonNullable<ToolOutcome["toast"]>[] = [];
  let assistantText = "";
  let totalIn = 0;
  let totalOut = 0;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await openai.responses.create({
        model: TEXT_MODEL,
        instructions,
        input: input as never,
        tools: openAIToolDefs() as never,
        previous_response_id: previousResponseId,
      });
      previousResponseId = response.id;
      totalIn += response.usage?.input_tokens ?? 0;
      totalOut += response.usage?.output_tokens ?? 0;

      const calls = response.output.filter((o) => o.type === "function_call");
      if (calls.length === 0) {
        assistantText = response.output_text ?? "";
        break;
      }
      const outputs: InputItem[] = [];
      for (const call of calls) {
        const outcome = await executeTool(
          {
            userId: user.id,
            timezone: user.timezone,
            conversationId,
            anchorMessageId: userMessage.id,
          },
          call.name,
          JSON.parse(call.arguments || "{}")
        );
        if (outcome.toast) toasts.push(outcome.toast);
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(outcome.result ?? {}),
        });
      }
      input = outputs;
    }
  } catch (e) {
    console.error("chat failed:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: "The secretary couldn't respond. Try again." },
      { status: 502 }
    );
  }

  if (!assistantText) assistantText = "(done)";

  if (previousResponseId) {
    await db
      .update(conversations)
      .set({ lastResponseId: previousResponseId })
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));
  }

  const [assistantMessage] = await db
    .insert(messages)
    .values({
      userId: user.id,
      conversationId,
      role: "assistant",
      content: assistantText,
      mode: "text",
    })
    .returning();

  await db.insert(usage).values({
    userId: user.id,
    kind: "chat",
    model: TEXT_MODEL,
    inputTokens: totalIn,
    outputTokens: totalOut,
  });

  // Safety-net extraction over the new turn (incremental — extractedAt
  // high-water mark keeps repeated runs cheap).
  const convId = conversationId;
  after(() => runExtraction(user.id, convId, user.timezone));

  return NextResponse.json({
    conversationId,
    userMessageId: userMessage.id,
    assistantMessage: {
      id: assistantMessage.id,
      role: "assistant",
      content: assistantText,
      createdAt: assistantMessage.createdAt,
    },
    toasts,
  });
}
