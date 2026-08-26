// Text-mode secretary: same persona, same briefing, same tools, same data as
// voice. Runs a tool loop against the Responses API.
import { NextResponse } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { attachments, conversations, messages, usage, user as userTable } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import { loadHistoryWindow } from "@/lib/db/queries";
import { buildBriefing } from "@/lib/secretary/briefing";
import { buildInstructions } from "@/lib/secretary/persona";
import { openAIToolDefs } from "@/lib/secretary/tool-schemas";
import { executeTool, type ToolOutcome } from "@/lib/secretary/tools";
import { runExtraction } from "@/lib/secretary/extraction";
import { openai, TEXT_MODEL } from "@/lib/openai";
import { anthropicFor, chatProvider, chatSettings, claudeBrainEnabled } from "@/lib/anthropic";
import { runClaudeChat } from "@/lib/secretary/chat-claude";

const bodySchema = z.object({
  // Empty text is fine when attachments carry the message ("here's the flyer").
  message: z.string().max(8000).default(""),
  conversationId: z.string().nullish(),
  attachmentIds: z.array(z.string()).max(4).optional(),
});

const MAX_TOOL_ROUNDS = 8;
const HISTORY_LIMIT = 40;

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  // Load the user's uploaded-but-unbound attachments for this message.
  const attachRows = parsed.attachmentIds?.length
    ? await db
        .select()
        .from(attachments)
        .where(
          and(eq(attachments.userId, user.id), inArray(attachments.id, parsed.attachmentIds))
        )
    : [];
  if (!parsed.message.trim() && attachRows.length === 0) {
    return NextResponse.json({ error: "Say something or attach a file." }, { status: 400 });
  }

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

  const storedText =
    parsed.message.trim() ||
    (attachRows.length === 1 ? `(sent ${attachRows[0].name})` : `(sent ${attachRows.length} files)`);
  const [userMessage] = await db
    .insert(messages)
    .values({
      userId: user.id,
      conversationId,
      role: "user",
      content: storedText,
      mode: "text",
      attachments: attachRows.length
        ? attachRows.map((a) => ({ id: a.id, mime: a.mime, name: a.name }))
        : null,
    })
    .returning();
  if (attachRows.length) {
    await db
      .update(attachments)
      .set({ messageId: userMessage.id })
      .where(inArray(attachments.id, attachRows.map((a) => a.id)));
  }

  // Newest-first window: a long thread must keep what was just said — loading
  // the oldest 40 silently dropped recent turns (SPEC §11 cross-session recall).
  const history = await loadHistoryWindow(user.id, conversationId, HISTORY_LIMIT);

  const briefing = await buildBriefing(user.id, user.timezone, {
    consumeNudges: true,
    // this thread is already the model's input — prior sessions only
    excludeConversationId: conversationId,
  });
  const [userRow] = await db
    .select({ persona: userTable.persona })
    .from(userTable)
    .where(eq(userTable.id, user.id));
  const instructions = buildInstructions(briefing.text, { persona: userRow?.persona });

  // Composer chip: which model answers, at what effort. Claude models need a
  // key — the user's connected account first, then the house key; without
  // either the turn quietly runs the OpenAI default.
  const chip = await chatSettings(user.id);
  const claudeClient =
    chatProvider(chip.model) === "anthropic" && claudeBrainEnabled()
      ? await anthropicFor(user.id)
      : null;
  const useClaude = Boolean(claudeClient);
  const openAIModel = chatProvider(chip.model) === "openai" ? chip.model : TEXT_MODEL;
  const openAIEffort = chatProvider(chip.model) === "openai" ? chip.effort : undefined;

  type InputItem = Record<string, unknown>;
  // The current turn: text plus any attached photos/PDFs as vision input.
  // History replay stays text-only — the analysis lives in the assistant's
  // reply, so old images never re-bloat the context.
  const userTurn: InputItem = attachRows.length
    ? {
        role: "user",
        content: [
          ...(parsed.message.trim() ? [{ type: "input_text", text: parsed.message }] : []),
          ...attachRows.map((a) =>
            a.mime === "application/pdf"
              ? {
                  type: "input_file",
                  filename: a.name,
                  file_data: `data:application/pdf;base64,${a.data.toString("base64")}`,
                }
              : {
                  type: "input_image",
                  image_url: `data:${a.mime};base64,${a.data.toString("base64")}`,
                }
          ),
        ],
      }
    : { role: "user", content: parsed.message };
  // Reasoning models pair function_call items with reasoning items, so turns
  // and tool rounds are chained via previous_response_id. The chain is only
  // valid if no voice session added messages since it was last stored.
  const prior = history.filter((m) => m.id !== userMessage.id);
  const canChain = Boolean(storedResponseId) && prior.length > 0 && prior[prior.length - 1].mode === "text";
  let input: InputItem[] = canChain
    ? [userTurn]
    : (prior
        .filter((m) => m.role !== "tool")
        .map((m) => ({ role: m.role, content: m.content })) as InputItem[]
      ).concat([userTurn]);
  let previousResponseId: string | undefined = canChain ? storedResponseId! : undefined;

  const toasts: NonNullable<ToolOutcome["toast"]>[] = [];
  let assistantText = "";
  let totalIn = 0;
  let totalOut = 0;
  let servedBy = openAIModel;
  let claudeServed = false;

  if (useClaude && claudeClient) {
    try {
      const result = await runClaudeChat({
        client: claudeClient,
        model: chip.model,
        effort: chip.effort,
        instructions,
        history: prior
          .filter((m): m is typeof m & { role: "user" | "assistant" } => m.role !== "tool")
          .map((m) => ({ role: m.role, content: m.content })),
        message: parsed.message,
        attachments: attachRows,
        toolCtx: {
          userId: user.id,
          timezone: user.timezone,
          conversationId,
          anchorMessageId: userMessage.id,
        },
        executeTool,
      });
      assistantText = result.text;
      toasts.push(...result.toasts);
      totalIn = result.inputTokens;
      totalOut = result.outputTokens;
      servedBy = chip.model;
      claudeServed = true;
      // Claude turns aren't in OpenAI's server-side chain — force the next
      // OpenAI turn to replay history instead of resuming a stale id.
      await db
        .update(conversations)
        .set({ lastResponseId: null })
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));
      previousResponseId = undefined;
    } catch (e) {
      console.error(
        "claude chat failed, falling back to openai:",
        e instanceof Error ? e.message : e
      );
    }
  }

  try {
    for (let round = 0; !claudeServed && round < MAX_TOOL_ROUNDS; round++) {
      const response = await openai.responses.create({
        model: openAIModel,
        instructions,
        input: input as never,
        tools: openAIToolDefs() as never,
        previous_response_id: previousResponseId,
        ...(openAIEffort ? { reasoning: { effort: openAIEffort as never } } : {}),
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

  if (!claudeServed && previousResponseId) {
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
    model: servedBy,
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
