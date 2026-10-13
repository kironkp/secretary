// Task 1.01: does prompt caching hit on the chat model? A measurement tool,
// not product code, and the only script here that spends money: two real
// requests, each cut off at 32 output tokens. The prefix is the one
// lib/secretary/chat-claude.ts sends (the tool block and the stable
// instructions, each ending in a cache breakpoint); the live briefing is left
// out to keep the cost down. The first request should write the cache, the
// second should read it.
//
//   OPENAI_API_KEY=placeholder DATABASE_URL=postgresql://localhost/none \
//     ANTHROPIC_API_KEY=... MODEL=claude-fable-5 npx tsx docs/jarvis/baseline/cache-probe.ts
import Anthropic from "@anthropic-ai/sdk";
import { buildInstructionParts } from "@/lib/secretary/persona";
import { anthropicToolDefs } from "@/lib/secretary/tool-schemas";

const model = process.env.MODEL ?? "claude-fable-5";

async function main() {
  const client = new Anthropic();
  const tools = anthropicToolDefs().map((tool, i, all) =>
    i === all.length - 1 ? { ...tool, cache_control: { type: "ephemeral" as const } } : tool
  ) as Anthropic.Tool[];
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: buildInstructionParts("", { persona: null }).stable, cache_control: { type: "ephemeral" } },
  ];
  for (const n of [1, 2]) {
    const r = await client.messages.create({
      model,
      max_tokens: 32,
      system,
      tools,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "Reply with the one word: ok" }],
    });
    console.log(
      JSON.stringify({
        request: n,
        model: r.model,
        stop_reason: r.stop_reason,
        input_tokens: r.usage.input_tokens,
        cache_creation_input_tokens: r.usage.cache_creation_input_tokens,
        cache_read_input_tokens: r.usage.cache_read_input_tokens,
        output_tokens: r.usage.output_tokens,
      })
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
