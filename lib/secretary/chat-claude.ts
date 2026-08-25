// Claude text-chat provider: the same secretary (persona, briefing, all ~40
// tools, same executeTool) running on an Anthropic model when the composer
// chip picks one. Mirrors the /api/chat OpenAI loop; the route falls back to
// OpenAI if this throws (refusal included) — the chip can never brick chat.
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@/lib/anthropic";
import { anthropicToolDefs } from "./tool-schemas";
import type { ToolContext, ToolOutcome } from "./tools";

const MAX_TOOL_ROUNDS = 8;

export type ClaudeChatResult = {
  text: string;
  toasts: NonNullable<ToolOutcome["toast"]>[];
  inputTokens: number;
  outputTokens: number;
};

export async function runClaudeChat(opts: {
  model: string;
  effort: string;
  instructions: string;
  /** Prior turns, text-only (oldest first, tool rows already filtered). */
  history: { role: "user" | "assistant"; content: string }[];
  message: string;
  attachments: { mime: string; name: string; data: Buffer }[];
  toolCtx: ToolContext;
  executeTool: (ctx: ToolContext, name: string, args: unknown) => Promise<ToolOutcome>;
}): Promise<ClaudeChatResult> {
  const userContent: Anthropic.ContentBlockParam[] = [
    ...(opts.message.trim()
      ? [{ type: "text" as const, text: opts.message }]
      : []),
    ...opts.attachments.map((a): Anthropic.ContentBlockParam =>
      a.mime === "application/pdf"
        ? {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: a.data.toString("base64"),
            },
          }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: a.mime as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
              data: a.data.toString("base64"),
            },
          }
    ),
  ];
  if (userContent.length === 0) userContent.push({ type: "text", text: "(empty)" });

  const messages: Anthropic.MessageParam[] = [
    ...opts.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userContent },
  ];

  const toasts: NonNullable<ToolOutcome["toast"]>[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic().messages.create({
      model: opts.model,
      max_tokens: 8000,
      system: opts.instructions,
      output_config: { effort: opts.effort as "low" | "medium" | "high" | "xhigh" | "max" },
      tools: anthropicToolDefs() as Anthropic.Tool[],
      messages,
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason === "refusal") throw new Error("claude refusal");

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, toasts, inputTokens, outputTokens };
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
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(outcome.result ?? {}),
      });
    }
    messages.push({ role: "user", content: results });
  }

  return { text: "(done)", toasts, inputTokens, outputTokens };
}
