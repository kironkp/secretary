// SEC-A004 review R3: a Sonnet extraction cut at max_tokens was billed and
// then thrown away without a usage row, and the gpt-5.5 fallback had no
// ceiling. Claude and OpenAI are both fakes here, counted.
process.env.TZ = "UTC";

import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const calls = vi.hoisted(() => ({ claude: 0, openai: 0, openaiMax: [] as unknown[] }));

vi.mock("@/lib/anthropic", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/anthropic")>();
  const client = {
    messages: {
      parse: async () => {
        calls.claude++;
        return { stop_reason: "max_tokens", parsed_output: null, content: [], usage: { input_tokens: 4000, output_tokens: 3000 } };
      },
    },
  };
  return {
    ...real,
    claudeBrainEnabled: () => true,
    anthropicFor: async () => client,
    brainSettings: async () => ({ model: "claude-opus-5", effort: "high" }),
  };
});
vi.mock("@/lib/openai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/openai")>();
  return {
    ...real,
    openai: {
      responses: {
        create: async (req: { max_output_tokens?: number; text?: { format?: { name?: string } } }) => {
          if (req.text?.format?.name !== "extraction") throw new Error("only extraction expected");
          calls.openai++;
          calls.openaiMax.push(req.max_output_tokens);
          return {
            output_text: JSON.stringify({ tasks: [], events: [], status_updates: [], facts: [], mentions: [], ambiguities: [] }),
            usage: { input_tokens: 3000, output_tokens: 400 },
          };
        },
      },
    },
  };
});

import { db } from "@/lib/db";
import { conversations, messages, usage, user } from "@/lib/db/schema";
import { runExtraction } from "@/lib/secretary/extraction";

process.env.OPENAI_API_KEY = "test-not-sent";
const U = { id: `test-xbill-${crypto.randomUUID()}`, email: `xbill-${Date.now()}@sec-a004.test` };

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("a cut extraction is paid for once, recorded, and its fallback has a ceiling", () => {
  it("records the cut Sonnet pass, priced, then the capped gpt-5.5 fallback", async () => {
    await db.insert(user).values({ id: U.id, name: "Bill", email: U.email, timezone: "America/Los_Angeles" });
    const [conv] = await db.insert(conversations).values({ userId: U.id, mode: "voice" }).returning();
    await db.insert(messages).values({ userId: U.id, conversationId: conv.id, role: "user", content: "remind me about the boat", mode: "voice" });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runExtraction(U.id, conv.id, "America/Los_Angeles");
    } finally {
      quiet.mockRestore();
    }
    expect(calls.claude).toBe(1);
    expect(calls.openai).toBe(1);
    expect(calls.openaiMax).toEqual([3000]);
    const rows = await db.select().from(usage).where(and(eq(usage.userId, U.id), eq(usage.kind, "extraction")));
    const sonnet = rows.find((r) => r.model === "claude-sonnet-5")!;
    expect(sonnet).toMatchObject({ inputTokens: 4000, outputTokens: 3000 });
    expect(Number(sonnet.costUsd)).toBeCloseTo((4000 * 2 + 3000 * 10) / 1e6, 6);
    expect(rows.find((r) => r.model === "gpt-5.5")).toBeDefined();
    expect(rows).toHaveLength(2);
  });
});
