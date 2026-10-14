// Text-mode secretary: same persona, same briefing, same tools, same data as
// voice. Runs a tool loop against the Responses API.
//
// Delivered once (docs/chat/SPEC.md, v1.09): the page names each turn, and the
// answer streams over this same POST when the page asks for it (a line as soon
// as his message is stored, Claude's text as it is written, a ping whenever
// nothing else went out for a few seconds, then the answer). Heroku's router
// cuts a request that sends no byte for 30 seconds; before v1.09 this route
// sent nothing until the whole answer, tools and all, was done.
import { NextResponse } from "next/server";
import { after } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { attachments, conversations, messages, user as userTable } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";
import { isErrorResponse, parseBody, requireSession } from "@/lib/api";
import {
  claimNewTurn,
  findTurn,
  finishTurn,
  keepTurnAlive,
  noteTurnMessage,
  savedAnswer,
  takeOverTurn,
  waitOnTurn,
  type FoundTurn,
} from "@/lib/chat/turns";
import { loadHistoryWindow } from "@/lib/db/queries";
import { buildBriefing } from "@/lib/secretary/briefing";
import { settleFollowUps } from "@/lib/secretary/expectations";
import { buildInstructionParts } from "@/lib/secretary/persona";
import { openAIToolDefs } from "@/lib/secretary/tool-schemas";
import { untrustedSince } from "@/lib/secretary/proposals";
import { executeTool, liveTurnContext, type ToolOutcome } from "@/lib/secretary/tools";
import { runExtraction } from "@/lib/secretary/extraction";
import { openaiClientFor, TEXT_MODEL } from "@/lib/openai";
import { anthropicClientFor, chatProvider, chatSettings, claudeBrainEnabled } from "@/lib/anthropic";
import { ClaudeChatFailure, runClaudeChat } from "@/lib/secretary/chat-claude";
import {
  errorMessage,
  noteProviderFailure,
  noteProviderOk,
  outageLine,
} from "@/lib/understanding/provider-health";
import { estimateSentTokens, mayHaveBeenBilled, recordUnanswered } from "@/lib/unanswered";
import { recordUsage } from "@/lib/usage";
import {
  openAIAttachmentBlocks,
  storedAttachmentText,
} from "@/lib/secretary/attachment-blocks";

const bodySchema = z.object({
  // Empty text is fine when attachments carry the message ("here's the flyer").
  message: z.string().max(8000).default(""),
  conversationId: z.string().nullish(),
  attachmentIds: z.array(z.string()).max(4).optional(),
  // The page's own name for this turn (docs/chat/SPEC.md §2). A page opened
  // before v1.09 sends none, and each of its posts is a turn of its own.
  turnId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
  // The page's own asks after a drop: fetch or wait, never run a model.
  resume: z.boolean().optional(),
});

const MAX_TOOL_ROUNDS = 8;
const HISTORY_LIMIT = 40;
/** A ping whenever nothing else went out for this long (docs/chat/SPEC.md §1). */
const heartbeatMs = () => {
  const v = Number(process.env.CHAT_HEARTBEAT_MS);
  return Number.isFinite(v) && v > 0 ? v : 5_000;
};
const NOT_DELIVERED = "Not delivered";

type Body = z.infer<typeof bodySchema>;
type Attachment = typeof attachments.$inferSelect;
type Who = { id: string; timezone: string };
/** What the route sends as the answer: the plain JSON, and the stream's last line. */
type Answer = {
  conversationId: string | null;
  userMessageId: string | null;
  assistantMessage: { id: string; role: "assistant"; content: string; createdAt: Date };
  toasts: unknown[];
  uiActions: unknown[];
};
type Outcome = { kind: "done"; answer: Answer; ranIn?: string } | { kind: "error"; error: string; status: number };
type Line =
  | { type: "accepted"; turnId: string | null; conversationId: string; userMessageId: string }
  | { type: "text"; round: number; text: string }
  | { type: "ping" };
type Emit = (line: Line) => void;

export async function POST(req: Request) {
  const user = await requireSession();
  if (isErrorResponse(user)) return user;

  const parsed = parseBody(bodySchema, await req.json().catch(() => ({})));
  if (isErrorResponse(parsed)) return parsed;

  // Load the user's uploaded-but-unbound attachments for this message. The
  // query has no ORDER BY, so restore the order the user attached them in —
  // with several documents, which one is "the first" carries meaning.
  const attachRows = parsed.attachmentIds?.length
    ? await db
        .select()
        .from(attachments)
        .where(
          and(eq(attachments.userId, user.id), inArray(attachments.id, parsed.attachmentIds))
        )
        .then((rows) =>
          [...rows].sort(
            (a, b) => parsed.attachmentIds!.indexOf(a.id) - parsed.attachmentIds!.indexOf(b.id)
          )
        )
    : [];
  if (!parsed.message.trim() && attachRows.length === 0) {
    return NextResponse.json({ error: "Say something or attach a file." }, { status: 400 });
  }

  const streamed = (req.headers.get("accept") ?? "").includes("application/x-ndjson");
  const out = streamed ? streamOut() : null;
  const work = deliverTurn(user, parsed, attachRows, out?.emit ?? (() => {}));

  // Safety-net extraction over the new turn (incremental — extractedAt
  // high-water mark keeps repeated runs cheap). Asked for now, while the
  // request is in hand; it runs once the turn this ask ran is saved.
  after(async () => {
    const outcome = await work;
    if (outcome.kind === "done" && outcome.ranIn) await runExtraction(user.id, outcome.ranIn, user.timezone);
  });

  if (out) return out.respond(work);
  const outcome = await work;
  return outcome.kind === "done"
    ? NextResponse.json(outcome.answer)
    : NextResponse.json({ error: outcome.error }, { status: outcome.status });
}

/**
 * The turn's row first (docs/chat/SPEC.md §2): a turn that is done gives its
 * saved answer, one still running is waited on, and only a send or his tap
 * runs a model, on a turn that is new, failed, or gone and taken over.
 */
async function deliverTurn(user: Who, parsed: Body, attachRows: Attachment[], emit: Emit): Promise<Outcome> {
  const turnId = parsed.turnId ?? null;
  if (!turnId) {
    return parsed.resume ? { kind: "error", error: NOT_DELIVERED, status: 404 } : runTurn(user, parsed, attachRows, emit, null, null);
  }
  const fresh = parsed.resume ? null : await claimNewTurn(user.id, turnId);
  if (fresh) return runTurn(user, parsed, attachRows, emit, turnId, null);

  let told = false;
  for (let found = await findTurn(user.id, turnId); ; ) {
    if (!found) return { kind: "error", error: NOT_DELIVERED, status: 404 };
    if (!told && found.conversationId && found.userMessageId) {
      emit({ type: "accepted", turnId, conversationId: found.conversationId, userMessageId: found.userMessageId });
      told = true;
    }
    if (found.status === "done") return answerOf(found);
    if (found.status === "running" && !found.gone) {
      found = await waitOnTurn(user.id, turnId);
      continue;
    }
    // Failed, or gone. A resume only brings that back.
    if (parsed.resume) return { kind: "error", error: found.status === "failed" ? (found.error ?? NOT_DELIVERED) : NOT_DELIVERED, status: 502 };
    const taken = await takeOverTurn(user.id, turnId);
    if (taken) return runTurn(user, parsed, attachRows, emit, turnId, taken);
    // Another ask took it over at the same moment: wait on that one.
    found = await findTurn(user.id, turnId);
  }
}

async function answerOf(found: FoundTurn): Promise<Outcome> {
  const answer = await savedAnswer(found);
  return answer ? { kind: "done", answer } : { kind: "error", error: NOT_DELIVERED, status: 404 };
}

/**
 * One run of the turn: what the route did before v1.09, with his stored
 * message reused when the turn ran before (a failed or gone run), and the
 * turn's row kept alive while it runs and closed when it ends.
 */
async function runTurn(
  user: Who,
  parsed: Body,
  attachRows: Attachment[],
  emit: Emit,
  turnId: string | null,
  earlier: { conversationId: string | null; userMessageId: string | null } | null
): Promise<Outcome> {
  const stopAlive = turnId ? keepTurnAlive(user.id, turnId) : () => {};
  try {
    const outcome = await runModels(user, parsed, attachRows, emit, turnId, earlier);
    if (turnId) {
      await finishTurn(
        user.id,
        turnId,
        outcome.kind === "done"
          ? { replyMessageId: outcome.answer.assistantMessage.id, toasts: outcome.answer.toasts, uiActions: outcome.answer.uiActions }
          : { error: outcome.error }
      );
    }
    return outcome;
  } catch (e) {
    console.error("chat turn failed:", errorMessage(e));
    const error = "The secretary couldn't respond. Try again.";
    if (turnId) await finishTurn(user.id, turnId, { error }).catch(() => {});
    return { kind: "error", error, status: 500 };
  } finally {
    stopAlive();
  }
}

async function runModels(
  user: Who,
  parsed: Body,
  attachRows: Attachment[],
  emit: Emit,
  turnId: string | null,
  earlier: { conversationId: string | null; userMessageId: string | null } | null
): Promise<Outcome> {
  // Conversation: the turn's own when it ran before; else reuse if owned, else
  // create (text mode).
  let conversationId = earlier?.conversationId ?? parsed.conversationId ?? null;
  let storedResponseId: string | null = null;
  // Mail has been read into this conversation, or it is an intake thread
  // (SEC-A005/b): writes need a yes.
  let readMail = false;
  if (conversationId) {
    const [owned] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)))
      .limit(1);
    if (!owned) conversationId = null;
    else {
      storedResponseId = owned.lastResponseId;
      readMail = untrustedSince(owned) !== null;
    }
  }
  if (!conversationId) {
    const [conv] = await db
      .insert(conversations)
      .values({ userId: user.id, mode: "text" })
      .returning();
    conversationId = conv.id;
  }

  // What gets persisted as the user's turn. Attachment bytes never replay —
  // history is text-only and OpenAI's server-side chain is dropped after any
  // Claude turn — so a bounded fenced extract goes into the stored message.
  // Without it, "what was in row 14?" reaches a model holding only a filename.
  // A turn that ran before already stored it: never twice.
  const [storedBefore] = earlier?.userMessageId
    ? await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, earlier.userMessageId), eq(messages.userId, user.id), eq(messages.conversationId, conversationId)))
    : [];
  let userMessage = storedBefore;
  if (!userMessage) {
    const storedText = [
      parsed.message.trim(),
      attachRows.length ? storedAttachmentText(attachRows) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    [userMessage] = await db
      .insert(messages)
      .values({
        userId: user.id,
        conversationId,
        role: "user",
        content: storedText,
        mode: "text",
        origin: "app",
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
  }
  if (turnId) await noteTurnMessage(user.id, turnId, conversationId, userMessage.id);
  // The page's first line: his message is stored, before any model is asked.
  emit({ type: "accepted", turnId, conversationId, userMessageId: userMessage.id });

  // Newest-first window: a long thread must keep what was just said — loading
  // the oldest 40 silently dropped recent turns (SPEC §11 cross-session recall).
  const history = await loadHistoryWindow(user.id, conversationId, HISTORY_LIMIT);

  const briefing = await buildBriefing(user.id, user.timezone, {
    // A session start: nudges are spent, and what Secretary promised to ask
    // is raised (SPEC §11); those are settled below, once a model has
    // answered with this briefing.
    consumeNudges: true,
    // this thread is already the model's input — prior sessions only
    excludeConversationId: conversationId,
  });
  const [userRow] = await db
    .select({ persona: userTable.persona })
    .from(userTable)
    .where(eq(userTable.id, user.id));
  const instructionParts = buildInstructionParts(briefing.text, { persona: userRow?.persona });
  const instructions = `${instructionParts.stable}\n\n${instructionParts.live}`;

  // Composer chip: which model answers, at what effort. Claude models need a
  // key — the user's connected account first, then the house key; without
  // either the turn quietly runs the OpenAI default.
  const chip = await chatSettings(user.id);
  const claudeResolved =
    chatProvider(chip.model) === "anthropic" && claudeBrainEnabled()
      ? await anthropicClientFor(user.id)
      : null;
  const claudeClient = claudeResolved?.client ?? null;
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
          ...openAIAttachmentBlocks(attachRows),
        ],
      }
    : { role: "user", content: parsed.message };
  // Reasoning models pair function_call items with reasoning items, so turns
  // and tool rounds are chained via previous_response_id. The chain is only
  // valid if no voice session added messages since it was last stored.
  const prior = history.filter((m) => m.id !== userMessage.id);

  // One context for every tool this turn calls, whichever model answers: a
  // turn that carries a flyer or a file asks before writing Google Calendar.
  const toolCtx = liveTurnContext({
    userId: user.id,
    timezone: user.timezone,
    conversationId,
    anchorMessageId: userMessage.id,
    attachmentCount: attachRows.length,
    untrusted: readMail,
  });
  const canChain = Boolean(storedResponseId) && prior.length > 0 && prior[prior.length - 1].mode === "text";
  let input: InputItem[] = canChain
    ? [userTurn]
    : (prior
        .filter((m) => m.role !== "tool")
        .map((m) => ({ role: m.role, content: m.content })) as InputItem[]
      ).concat([userTurn]);
  let previousResponseId: string | undefined = canChain ? storedResponseId! : undefined;

  const toasts: NonNullable<ToolOutcome["toast"]>[] = [];
  // UI-only actions (SPEC §7.6 auto-open) — transient, never model-visible.
  const uiActions: NonNullable<ToolOutcome["uiAction"]>[] = [];
  let assistantText = "";
  let totalIn = 0;
  let totalCached = 0;
  /** Claude only: input written to the prompt cache, priced above the input rate. Null on the OpenAI road, which reports none. */
  let totalCacheWrite: number | null = null;
  let totalOut = 0;
  let servedBy = openAIModel;
  let claudeServed = false;

  if (useClaude && claudeClient) {
    try {
      const result = await runClaudeChat({
        client: claudeClient,
        model: chip.model,
        effort: chip.effort,
        instructions: instructionParts,
        history: prior
          .filter((m): m is typeof m & { role: "user" | "assistant" } => m.role !== "tool")
          .map((m) => ({ role: m.role, content: m.content })),
        message: parsed.message,
        attachments: attachRows,
        toolCtx,
        executeTool,
        onText: (round, text) => emit({ type: "text", round, text }),
      });
      assistantText = result.text;
      toasts.push(...result.toasts);
      uiActions.push(...result.uiActions);
      totalIn = result.inputTokens;
      totalCached = result.cachedInputTokens;
      totalCacheWrite = result.cacheWriteInputTokens;
      totalOut = result.outputTokens;
      servedBy = chip.model;
      claudeServed = true;
      noteProviderOk("anthropic", claudeResolved?.source);
      // Claude turns aren't in OpenAI's server-side chain — force the next
      // OpenAI turn to replay history instead of resuming a stale id.
      await db
        .update(conversations)
        .set({ lastResponseId: null })
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, user.id)));
      previousResponseId = undefined;
    } catch (e) {
      const reason = e instanceof ClaudeChatFailure ? e.reason : e;
      // What the Claude rounds already cost is counted before the fallback
      // answers (docs/spend/SPEC.md §1.2): they left no row until v1.09.
      if (e instanceof ClaudeChatFailure) {
        const { spent } = e;
        if (spent.inputTokens || spent.outputTokens) {
          await recordUsage({
            userId: user.id,
            kind: "chat",
            model: chip.model,
            inputTokens: spent.inputTokens,
            outputTokens: spent.outputTokens,
            cachedInputTokens: spent.cachedInputTokens,
            cacheWriteInputTokens: spent.cacheWriteInputTokens,
          });
        }
        if (e.unansweredInputTokens) {
          await recordUnanswered({ userId: user.id, kind: "chat", model: chip.model, inputTokens: e.unansweredInputTokens });
        }
      }
      // Distinguish the attachment path: a systematic failure there would
      // otherwise be invisible behind a working OpenAI fallback.
      console.error(
        attachRows.length
          ? `claude chat failed WITH ${attachRows.length} attachment(s), falling back to openai:`
          : "claude chat failed, falling back to openai:",
        errorMessage(reason)
      );
      // The provider memory hears it, so Settings and the progress line can
      // say the key is capped or refused, whichever surface saw it first.
      noteProviderFailure("anthropic", errorMessage(reason), claudeResolved?.source);
    }
  }

  // The user's connected OpenAI key first, then the house key. With neither
  // and no Claude turn served there is nothing to answer with.
  const gpt = claudeServed ? null : await openaiClientFor(user.id);
  if (!claudeServed && !gpt) {
    return { kind: "error", error: "The secretary has no OpenAI key. Connect one in Settings.", status: 502 };
  }

  /** The round that was sent and never answered, at the estimate (docs/spend/SPEC.md §1.2). */
  let unanswered = 0;
  try {
    for (let round = 0; !claudeServed && gpt && round < MAX_TOOL_ROUNDS; round++) {
      const request = {
        model: openAIModel,
        instructions,
        input: input as never,
        tools: openAIToolDefs() as never,
        previous_response_id: previousResponseId,
        ...(openAIEffort ? { reasoning: { effort: openAIEffort as never } } : {}),
      };
      const response = await gpt.client.responses.create(request).catch((e: unknown) => {
        if (mayHaveBeenBilled(e)) unanswered = estimateSentTokens([JSON.stringify(request)]);
        throw e;
      });
      previousResponseId = response.id;
      totalIn += response.usage?.input_tokens ?? 0;
      // OpenAI caches automatically; this is what it actually served cached.
      totalCached += response.usage?.input_tokens_details?.cached_tokens ?? 0;
      totalOut += response.usage?.output_tokens ?? 0;

      const calls = response.output.filter((o) => o.type === "function_call");
      if (calls.length === 0) {
        assistantText = response.output_text ?? "";
        break;
      }
      const outputs: InputItem[] = [];
      for (const call of calls) {
        const outcome = await executeTool(
          toolCtx,
          call.name,
          JSON.parse(call.arguments || "{}")
        );
        if (outcome.toast) toasts.push(outcome.toast);
        if (outcome.uiAction) uiActions.push(outcome.uiAction);
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(outcome.result ?? {}),
        });
      }
      input = outputs;
    }
    if (!claudeServed && gpt) noteProviderOk("openai", gpt.source);
  } catch (e) {
    // The rounds that answered before the failure are counted, and the one
    // that never came back at the estimate (docs/spend/SPEC.md §1.2).
    if (totalIn || totalOut) {
      await recordUsage({
        userId: user.id,
        kind: "chat",
        model: openAIModel,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cachedInputTokens: totalCached,
      });
    }
    if (unanswered) await recordUnanswered({ userId: user.id, kind: "chat", model: openAIModel, inputTokens: unanswered });
    const message = errorMessage(e);
    console.error("chat failed:", message);
    // When the provider said why — no credits, a cap, a refused key — the
    // user hears that and what to do, not "try again".
    const failure = noteProviderFailure("openai", message, gpt?.source);
    return {
      kind: "error",
      error:
        outageLine("The secretary could not respond", "openai", failure) ??
        "The secretary couldn't respond. Try again.",
      status: 502,
    };
  }

  if (!assistantText) assistantText = "(done)";

  // A model answered this turn with the briefing in hand, so the follow-ups
  // it raised have been asked (SPEC §11, v1.03). A turn that failed returned
  // above and left them open for the next one.
  await settleFollowUps(user.id, briefing.followUps);

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

  // Priced through the shared recorder, and carrying the cached-input count so
  // the spend panel shows whether prompt caching is actually being HIT. A cache
  // that silently stops working looks exactly like one that works, until the
  // bill arrives.
  await recordUsage({
    userId: user.id,
    kind: "chat",
    model: servedBy,
    inputTokens: totalIn,
    outputTokens: totalOut,
    cachedInputTokens: totalCached,
    cacheWriteInputTokens: totalCacheWrite,
  });

  return {
    kind: "done",
    ranIn: conversationId,
    answer: {
      conversationId,
      userMessageId: userMessage.id,
      assistantMessage: {
        id: assistantMessage.id,
        role: "assistant",
        content: assistantText,
        createdAt: assistantMessage.createdAt,
      },
      toasts,
      uiActions,
    },
  };
}

/**
 * The stream's side (docs/chat/SPEC.md §1): one JSON object per line, a ping
 * whenever nothing else went out for a heartbeat, the answer as the last line.
 * A page that goes away stops the lines, never the turn.
 */
function streamOut() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  let lastSent = Date.now();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      open = false;
    },
  });
  const send = (line: Record<string, unknown>) => {
    if (!open) return;
    try {
      controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      lastSent = Date.now();
    } catch {
      open = false;
    }
  };
  const every = heartbeatMs();
  const beat = setInterval(() => {
    if (Date.now() - lastSent >= every) send({ type: "ping" });
  }, Math.max(10, Math.floor(every / 5)));

  return {
    emit: ((line) => send(line)) as Emit,
    respond(work: Promise<Outcome>) {
      void work
        .then((o) => send(o.kind === "done" ? { type: "done", ...o.answer } : { type: "error", error: o.error }))
        .catch((e) => {
          console.error("chat stream failed:", errorMessage(e));
          send({ type: "error", error: "The secretary couldn't respond. Try again." });
        })
        .finally(() => {
          clearInterval(beat);
          if (open) {
            open = false;
            try {
              controller.close();
            } catch {
              // the page already went away
            }
          }
        });
      return new Response(body, {
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
      });
    },
  };
}
