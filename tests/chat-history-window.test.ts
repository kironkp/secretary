// SPEC §11 cross-session recall: the chat model's context window keeps the
// NEWEST turns of a thread. The observed failure: loading the oldest 40
// silently dropped what was just said once a thread grew past the limit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages, user } from "@/lib/db/schema";
import { loadHistoryWindow } from "@/lib/db/queries";

const U = { id: `test-histwin-${crypto.randomUUID()}`, email: `hw-${Date.now()}@recall.test` };
const OTHER = { id: `test-histwin-b-${crypto.randomUUID()}`, email: `hwb-${Date.now()}@recall.test` };

let conversationId: string;

beforeAll(async () => {
  await db.insert(user).values([
    { id: U.id, name: "Window Tester", email: U.email, timezone: "America/Los_Angeles" },
    { id: OTHER.id, name: "Other", email: OTHER.email, timezone: "UTC" },
  ]);
  const [conv] = await db
    .insert(conversations)
    .values({ userId: U.id, mode: "text" })
    .returning();
  conversationId = conv.id;
  // 50 turns with strictly increasing timestamps — a thread past the window
  const base = Date.now() - 50 * 60000;
  await db.insert(messages).values(
    Array.from({ length: 50 }, (_, i) => ({
      userId: U.id,
      conversationId,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn ${i + 1}`,
      mode: "text" as const,
      createdAt: new Date(base + i * 60000),
    }))
  );
});
afterAll(async () => {
  // user cascade wipes conversations/messages
  await db.delete(user).where(eq(user.id, U.id));
  await db.delete(user).where(eq(user.id, OTHER.id));
});

describe("chat history window", () => {
  it("keeps the NEWEST 40 turns of a long thread, oldest-first", async () => {
    const rows = await loadHistoryWindow(U.id, conversationId, 40);
    expect(rows).toHaveLength(40);
    // the opening turns fall off; what was just said stays
    expect(rows[0].content).toBe("turn 11");
    expect(rows[rows.length - 1].content).toBe("turn 50");
  });

  it("returns the window in ascending order (replay-ready)", async () => {
    const rows = await loadHistoryWindow(U.id, conversationId, 40);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].createdAt.getTime()).toBeGreaterThanOrEqual(rows[i - 1].createdAt.getTime());
    }
  });

  it("returns the whole thread when it's shorter than the limit", async () => {
    const rows = await loadHistoryWindow(U.id, conversationId, 100);
    expect(rows).toHaveLength(50);
    expect(rows[0].content).toBe("turn 1");
  });

  it("is user-scoped: another user gets nothing even with the conversation id", async () => {
    const stolen = await loadHistoryWindow(OTHER.id, conversationId, 40);
    expect(stolen).toHaveLength(0);
  });
});
