// Task 1.01: where a chat request's input tokens go. A measurement tool, not
// product code. It builds the request /api/chat would send to Claude, from
// the app's own builders, and never sends it for an answer: the parts are
// sized in characters and, when ANTHROPIC_API_KEY is set, counted exactly by
// the provider's token counter (which generates nothing and costs nothing).
//
// Run from the repo root against a LOCAL database (the briefing builder
// writes: it refreshes scores and marks nudges and a question as asked):
//
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5441/secretary \
//     OPENAI_API_KEY=placeholder OWNER_EMAIL=<the account's email> \
//     npx tsx docs/jarvis/baseline/size-chat-request.ts
import Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, user as userTable } from "@/lib/db/schema";
import { loadHistoryWindow } from "@/lib/db/queries";
import { buildBriefing } from "@/lib/secretary/briefing";
import { buildInstructionParts } from "@/lib/secretary/persona";
import { anthropicToolDefs, openAIToolDefs, openAIVoiceToolDefs } from "@/lib/secretary/tool-schemas";

const MODELS = (process.env.MODELS ?? "claude-fable-5,claude-opus-5").split(",");
const HISTORY_LIMIT = 40; // app/api/chat/route.ts

async function main() {
  const dbHost = new URL(process.env.DATABASE_URL ?? "").hostname;
  if (dbHost !== "localhost" && dbHost !== "127.0.0.1") throw new Error("local databases only");

  const [owner] = await db.select().from(userTable).where(eq(userTable.email, process.env.OWNER_EMAIL ?? ""));
  if (!owner) throw new Error("OWNER_EMAIL matches no user");

  // The text conversation with the most to replay, capped at the route's window.
  const convs = await db
    .select({ id: conversations.id, mode: conversations.mode })
    .from(conversations)
    .where(eq(conversations.userId, owner.id))
    .orderBy(desc(conversations.startedAt));
  let history: { role: "user" | "assistant"; content: string }[] = [];
  for (const c of convs.filter((c) => c.mode === "text")) {
    const rows = (await loadHistoryWindow(owner.id, c.id, HISTORY_LIMIT))
      .filter((m): m is typeof m & { role: "user" | "assistant" } => m.role !== "tool")
      .map((m) => ({ role: m.role, content: m.content }));
    const size = (h: typeof history) => h.reduce((n, m) => n + m.content.length, 0);
    if (size(rows) > size(history)) history = rows;
  }
  // The API wants the first turn to be the user's.
  while (history.length && history[0].role !== "user") history = history.slice(1);

  const briefing = await buildBriefing(owner.id, owner.timezone, { consumeNudges: true });
  const parts = buildInstructionParts(briefing.text, { persona: owner.persona });
  const tools = anthropicToolDefs();
  const message = "What's on my plate today?";

  const chars = {
    tools_anthropic_json: JSON.stringify(tools).length,
    tools_openai_json: JSON.stringify(openAIToolDefs()).length,
    tools_voice_json: JSON.stringify(openAIVoiceToolDefs()).length,
    instructions_stable: parts.stable.length,
    live_briefing: parts.live.length,
    history: history.reduce((n, m) => n + m.content.length, 0),
    message: message.length,
  };
  console.log("== counts");
  console.log(
    JSON.stringify({
      tools: tools.length,
      voice_tools: openAIVoiceToolDefs().length,
      history_messages: history.length,
      briefing_lines: briefing.text.split("\n").length,
    })
  );
  console.log("== characters");
  console.log(JSON.stringify(chars));
  // The briefing by section, so "live context" is not one number. A section
  // starts at a line that is all capitals up to a colon or the end.
  const sections: Record<string, number> = {};
  let current = "(preamble)";
  for (const line of briefing.text.split("\n")) {
    const head = /^([A-Z][A-Z0-9 '()/&,.-]{3,}?)(?::|$| \()/.exec(line);
    if (head) current = head[1].trim();
    sections[current] = (sections[current] ?? 0) + line.length + 1;
  }
  console.log("== briefing_sections_characters");
  for (const [name, n] of Object.entries(sections).sort((a, b) => b[1] - a[1])) console.log(JSON.stringify({ section: name, chars: n }));
  // The largest tool definitions.
  console.log("== largest_tools_characters");
  for (const t of [...tools].sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length).slice(0, 12))
    console.log(JSON.stringify({ tool: t.name, chars: JSON.stringify(t).length }));

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("== tokens: skipped (no ANTHROPIC_API_KEY)");
    return;
  }
  const client = new Anthropic();
  const user = [{ role: "user" as const, content: message }];
  for (const model of MODELS) {
    const count = async (extra: Partial<Anthropic.Messages.MessageCountTokensParams>) =>
      (await client.messages.countTokens({ model, messages: user, ...extra })).input_tokens;
    const t = tools as Anthropic.Tool[];
    const bare = await count({});
    const withTools = await count({ tools: t });
    const withStable = await count({ tools: t, system: parts.stable });
    const withLive = await count({
      tools: t,
      system: [
        { type: "text", text: parts.stable },
        { type: "text", text: parts.live },
      ],
    });
    const full = await count({
      tools: t,
      system: [
        { type: "text", text: parts.stable },
        { type: "text", text: parts.live },
      ],
      messages: [...history, ...user],
    });
    console.log(`== tokens ${model}`);
    console.log(
      JSON.stringify({
        message_only: bare,
        tool_schemas: withTools - bare,
        instructions_stable: withStable - withTools,
        live_briefing: withLive - withStable,
        history: full - withLive,
        one_request_total: full,
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
