// SPEC §11 cross-session recall: search_history reaches everything older than
// the briefing's verbatim tails — "what did I say about X last week?" — with
// time filters, mode labels, and voice-session availability.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages, user } from "@/lib/db/schema";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-hsearch-${crypto.randomUUID()}`, email: `hs-${Date.now()}@recall.test` };
const OTHER = { id: `test-hsearch-b-${crypto.randomUUID()}`, email: `hsb-${Date.now()}@recall.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };

const daysAgo = (d: number) => new Date(Date.now() - d * 86400000);

type Row = { when: string; mode: string; role: string; snippet: string; conversation_id: string };

beforeAll(async () => {
  await db.insert(user).values([
    { id: U.id, name: "Search Tester", email: U.email, timezone: ctx.timezone },
    { id: OTHER.id, name: "Other", email: OTHER.email, timezone: "UTC" },
  ]);
  const [textConv] = await db
    .insert(conversations)
    .values({ userId: U.id, mode: "text", startedAt: daysAgo(20) })
    .returning();
  const [voiceConv] = await db
    .insert(conversations)
    .values({ userId: U.id, mode: "voice", startedAt: daysAgo(5) })
    .returning();
  const [otherConv] = await db
    .insert(conversations)
    .values({ userId: OTHER.id, mode: "text" })
    .returning();
  await db.insert(messages).values([
    {
      userId: U.id,
      conversationId: textConv.id,
      role: "user",
      content: "the caterer quote for the wedding came in at 4k",
      mode: "text",
      createdAt: daysAgo(20),
    },
    {
      userId: U.id,
      conversationId: voiceConv.id,
      role: "user",
      content: "the caterer confirmed for Saturday",
      mode: "voice",
      createdAt: daysAgo(5),
    },
    {
      userId: OTHER.id,
      conversationId: otherConv.id,
      role: "user",
      content: "my own caterer secret",
      mode: "text",
      createdAt: daysAgo(5),
    },
  ]);
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
  await db.delete(user).where(eq(user.id, OTHER.id));
});

describe("search_history", () => {
  it("finds matches across modes, newest first, labeled with mode", async () => {
    const { result } = await executeTool(ctx, "search_history", { query: "caterer" });
    const rows = result as Row[];
    expect(rows).toHaveLength(2);
    expect(rows[0].snippet).toContain("confirmed for Saturday");
    expect(rows[0].mode).toBe("voice");
    expect(rows[1].mode).toBe("text");
    expect(rows[0].when).toBeTruthy();
  });

  it("after narrows to the recent window ('last week')", async () => {
    const { result } = await executeTool(ctx, "search_history", {
      query: "caterer",
      after: daysAgo(7).toISOString(),
    });
    const rows = result as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].snippet).toContain("confirmed for Saturday");
  });

  it("before reaches the deep past only", async () => {
    const { result } = await executeTool(ctx, "search_history", {
      query: "caterer",
      before: daysAgo(7).toISOString(),
    });
    const rows = result as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].snippet).toContain("4k");
  });

  it("an unparseable time filter is ignored rather than erroring the call", async () => {
    const { result } = await executeTool(ctx, "search_history", {
      query: "caterer",
      after: "last tuesday-ish",
    });
    expect(result as Row[]).toHaveLength(2);
  });

  it("never crosses users", async () => {
    const { result } = await executeTool(ctx, "search_history", { query: "caterer secret" });
    expect(result as Row[]).toHaveLength(0);
  });
});
