// SEC-A004: chat's prompt is cached from one turn to the next. The briefing's
// clock line changes every minute; at the top of the instructions it made
// every turn a fresh cache write (Claude) and cut the reusable prefix to the
// persona (OpenAI). The fake Claude here caches the way Anthropic documents
// it: a breakpoint is a cache read only when it, and everything before it,
// is byte-identical to an earlier request.
process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { tasks, user } from "@/lib/db/schema";
import { buildBriefing } from "@/lib/secretary/briefing";
import { runClaudeChat } from "@/lib/secretary/chat-claude";
import { buildInstructionParts } from "@/lib/secretary/persona";
import { executeTool, type ToolContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const U = { id: `test-chat-cache-${crypto.randomUUID()}`, email: `chat-cache-${Date.now()}@sec-a004.test` };
const tok = (s: string) => Math.ceil(s.length / 4);

function cachingClaude() {
  const cache = new Set<string>();
  const client = {
    messages: {
      create: async (req: { tools: unknown[]; system: { text: string }[]; messages: unknown[] }) => {
        let key = "";
        let tokens = 0;
        let read = 0;
        const prefixes: string[] = [];
        for (const part of [JSON.stringify(req.tools), ...req.system.map((b) => b.text)]) {
          key += `\u0000${part}`;
          tokens += tok(part);
          if (cache.has(key)) read = tokens;
          prefixes.push(key);
        }
        for (const p of prefixes) cache.add(p);
        return {
          content: [{ type: "text", text: "Okay." }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: tok(JSON.stringify(req.messages)),
            output_tokens: 2,
            cache_read_input_tokens: read,
            cache_creation_input_tokens: tokens - read,
          },
        };
      },
    },
  };
  return client as unknown as Anthropic;
}

async function partsAt(iso: string) {
  vi.setSystemTime(new Date(iso));
  const briefing = await buildBriefing(U.id, TZ, { consumeNudges: false });
  return buildInstructionParts(briefing.text, {});
}

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Cache Tester", email: U.email, timezone: TZ });
  await db.insert(tasks).values({ userId: U.id, title: "Send the CPO", status: "todo" });
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterAll(async () => {
  vi.useRealTimers();
  await db.delete(user).where(eq(user.id, U.id));
});

describe("chat caches its prompt from one turn to the next", () => {
  it("Claude: from the second turn the tools and the stable instructions are a cache read", async () => {
    const client = cachingClaude();
    const ctx: ToolContext = { userId: U.id, timezone: TZ };
    const turn = (instructions: { stable: string; live: string }) =>
      runClaudeChat({ client, model: "claude-fable-5", effort: "low", instructions, history: [], message: "hi", attachments: [], toolCtx: ctx, executeTool });

    const first = await partsAt("2026-10-06T17:00:00Z");
    const second = await partsAt("2026-10-06T17:01:00Z");
    expect(second.stable).toBe(first.stable);
    expect(second.live).not.toBe(first.live); // the clock moved a minute

    expect((await turn(first)).cachedInputTokens).toBe(0);
    const again = await turn(second);
    // Not just the tools: the persona and directives are read from cache too.
    const toolsOnly = tok(JSON.stringify((await import("@/lib/secretary/tool-schemas")).anthropicToolDefs().map((t, i, all) => (i === all.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t))));
    expect(again.cachedInputTokens).toBeGreaterThanOrEqual(toolsOnly + tok(first.stable));
  });

  it("OpenAI: two turns a minute apart share everything up to the clock line", async () => {
    const a = await partsAt("2026-10-06T17:00:00Z");
    const b = await partsAt("2026-10-06T17:01:00Z");
    const one = `${a.stable}\n\n${a.live}`;
    const two = `${b.stable}\n\n${b.live}`;
    let common = 0;
    while (common < one.length && one[common] === two[common]) common++;
    expect(common).toBeGreaterThanOrEqual(one.lastIndexOf("CURRENT DATE & TIME"));
    expect(one.lastIndexOf("CURRENT DATE & TIME")).toBeGreaterThan(a.stable.length);
  });
});
