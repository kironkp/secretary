// Claude text-chat provider: the same secretary (persona, briefing, all ~40
// tools, same executeTool) running on an Anthropic model when the composer
// chip picks one. Mirrors the /api/chat OpenAI loop; the route falls back to
// OpenAI if this throws (refusal included) — the chip can never brick chat.
import type Anthropic from "@anthropic-ai/sdk";
import { cacheControl } from "@/lib/prompt-cache";
import { estimateSentTokens, mayHaveBeenBilled } from "@/lib/unanswered";
import { anthropicToolDefs } from "./tool-schemas";
import { anthropicAttachmentBlocks } from "./attachment-blocks";
import type { ToolContext, ToolOutcome } from "./tools";

const MAX_TOOL_ROUNDS = 8;

/** What the rounds that answered reported, summed the way a usage row wants it. */
export type ClaudeSpent = { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number };

/**
 * The turn failed on Claude, and the route falls back to OpenAI. It carries
 * what was already spent (docs/spend/SPEC.md §1.2): the rounds that answered,
 * as they reported (a refusal included), and the estimate for a round that was
 * sent and never answered (0 when Claude refused it before doing any work).
 */
export class ClaudeChatFailure extends Error {
  constructor(
    readonly reason: unknown,
    readonly spent: ClaudeSpent,
    readonly unansweredInputTokens: number
  ) {
    super(reason instanceof Error ? reason.message : String(reason));
  }
}

export type ClaudeChatResult = {
  text: string;
  toasts: NonNullable<ToolOutcome["toast"]>[];
  /** UI-only actions (SPEC §7.6 auto-open) — transient, never model-visible. */
  uiActions: NonNullable<ToolOutcome["uiAction"]>[];
  inputTokens: number;
  outputTokens: number;
  /** Of inputTokens, how many were served from the prompt cache (billed ~10%).
   *  Reported so a cache that silently stops working is visible. */
  cachedInputTokens: number;
  /** Of inputTokens, how many were written to the prompt cache (billed above the input rate). */
  cacheWriteInputTokens: number;
};

export async function runClaudeChat(opts: {
  /** Per-user client (connected account or house key). */
  client: Anthropic;
  model: string;
  effort: string;
  /** The stable part (persona, directives) and the live part (the briefing), cached as two blocks. */
  instructions: { stable: string; live: string };
  /** Prior turns, text-only (oldest first, tool rows already filtered). */
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
  attachments: { mime: string; name: string; data: Buffer }[];
  toolCtx: ToolContext;
  executeTool: (ctx: ToolContext, name: string, args: unknown) => Promise<ToolOutcome>;
  /** Each piece of text as Claude writes it, with the round it belongs to (docs/chat/SPEC.md §1). */
  onText?: (round: number, text: string) => void;
}): Promise<ClaudeChatResult> {
  const userContent: Anthropic.ContentBlockParam[] = [
    ...(opts.message.trim()
      ? [{ type: "text" as const, text: opts.message }]
      : []),
    ...anthropicAttachmentBlocks(opts.attachments),
  ];
  if (userContent.length === 0) userContent.push({ type: "text", text: "(empty)" });

  const messages: Anthropic.MessageParam[] = [
    ...opts.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userContent },
  ];

  const toasts: NonNullable<ToolOutcome["toast"]>[] = [];
  const uiActions: NonNullable<ToolOutcome["uiAction"]>[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;

  // THE COST FIX. A single user turn runs up to MAX_TOOL_ROUNDS requests, and
  // every one re-sends the identical prefix: instructions (~6k tokens) plus the
  // full tool schemas (~9.5k). Measured, that prefix is ~15.6k tokens and it
  // was being charged at full price on every round — which is why one turn
  // averaged 47k input tokens and peaked at 76k.
  //
  // Two cache breakpoints, ordered longest-stable-first the way the API
  // requires: tools change only when the code changes, instructions change per
  // session. Everything before a breakpoint is cached, so rounds 2..N of a turn
  // — and later turns in the same session — re-read the prefix at a tenth the
  // price instead of paying for it again.
  const cachedTools = anthropicToolDefs().map((tool, i, all) =>
    i === all.length - 1
      ? { ...tool, cache_control: cacheControl() }
      : tool
  ) as Anthropic.Tool[];
  // Three breakpoints: the tools, the stable instructions, then the live
  // briefing. As one block, the briefing's per-minute clock line made the
  // whole system prompt a fresh cache write every turn (SEC-A004); split,
  // the persona and directives are a cache read from the second turn on,
  // and rounds 2..N of a turn read the briefing too.
  const cachedSystem: Anthropic.TextBlockParam[] = [
    { type: "text", text: opts.instructions.stable, cache_control: cacheControl() },
    { type: "text", text: opts.instructions.live, cache_control: cacheControl() },
  ];

  const spent = (): ClaudeSpent => ({ inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const request = {
      model: opts.model,
      max_tokens: 8000,
      system: cachedSystem,
      output_config: { effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max" },
      tools: cachedTools,
      messages,
    };
    let response: Anthropic.Message;
    try {
      // Streamed so the page sees the answer as it is written; read whole at the end, as before.
      const stream = opts.client.messages.stream(request);
      if (opts.onText) stream.on("text", (piece) => opts.onText!(round, piece));
      response = await stream.finalMessage();
    } catch (e) {
      // Sent and never answered: counted at the estimate unless refused before any work.
      throw new ClaudeChatFailure(e, spent(), mayHaveBeenBilled(e) ? estimateSentTokens([JSON.stringify(request)]) : 0);
    }
    // cache_read is billed at ~10% and cache_creation at ~125%, so both are
    // counted as input and each portion is reported separately: the read one
    // is the only way to know the cache is actually being HIT rather than
    // merely enabled, and the written one is priced above the input rate
    // (docs/spend/SPEC.md §1.1; until v1.04 it was counted as fresh input).
    const cacheRead = response.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
    inputTokens += response.usage.input_tokens + cacheRead + cacheWrite;
    cachedInputTokens += cacheRead;
    cacheWriteInputTokens += cacheWrite;
    outputTokens += response.usage.output_tokens;

    // A refusal answered, and reported what it cost: counted as reported.
    if (response.stop_reason === "refusal") throw new ClaudeChatFailure(new Error("claude refusal"), spent(), 0);

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, toasts, uiActions, inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens };
    }

    // Full assistant content back (thinking blocks included — required for
    // multi-turn continuation on the same model), then every tool_result in
    // ONE user message.
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of toolUses) {
      let outcome: ToolOutcome;
      try {
        outcome = await opts.executeTool(opts.toolCtx, call.name, call.input ?? {});
      } catch (e) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `Error: ${e instanceof Error ? e.message : "tool failed"}`,
          is_error: true,
        });
        continue;
      }
      if (outcome.toast) toasts.push(outcome.toast);
      if (outcome.uiAction) uiActions.push(outcome.uiAction);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(outcome.result ?? {}),
      });
    }
    messages.push({ role: "user", content: results });
  }

  return { text: "(done)", toasts, uiActions, inputTokens, outputTokens, cachedInputTokens, cacheWriteInputTokens };
}
