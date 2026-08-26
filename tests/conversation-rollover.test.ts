// SPEC §11 cross-session recall: a text thread idle >6h is over — the next
// open stamps endedAt and starts fresh, making "last session" a real boundary
// the briefing's PRIOR SESSIONS block can quote. Rollover keys on idle time,
// NOT endedAt: a voice call that just hung up still restores.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages, user } from "@/lib/db/schema";
import { getActiveConversation } from "@/lib/db/queries";

const U = { id: `test-rollover-${crypto.randomUUID()}`, email: `ro-${Date.now()}@recall.test` };

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000);

async function seedConversation(
  mode: "text" | "voice",
  startedAt: Date,
  lastMessageAt: Date | null,
  endedAt: Date | null = null
) {
  const [conv] = await db
    .insert(conversations)
    .values({ userId: U.id, mode, startedAt, endedAt })
    .returning();
  if (lastMessageAt) {
    await db.insert(messages).values({
      userId: U.id,
      conversationId: conv.id,
      role: "user",
      content: "hello",
      mode,
      createdAt: lastMessageAt,
    });
  }
  return conv.id;
}

async function wipe() {
  await db.delete(conversations).where(eq(conversations.userId, U.id));
}

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Rollover Tester", email: U.email, timezone: "UTC" });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("6h-idle conversation rollover", () => {
  it("a fresh thread restores untouched", async () => {
    await wipe();
    const id = await seedConversation("text", hoursAgo(2), hoursAgo(1));
    const active = await getActiveConversation(U.id);
    expect(active?.conversation.id).toBe(id);
    expect(active?.conversation.endedAt).toBeNull();
  });

  it("an idle thread rolls over: endedAt stamped at last activity, chat opens fresh", async () => {
    await wipe();
    const lastSaid = hoursAgo(7);
    const id = await seedConversation("text", hoursAgo(8), lastSaid);
    expect(await getActiveConversation(U.id)).toBeNull();
    const [conv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.userId, U.id)));
    expect(conv.endedAt).not.toBeNull();
    expect(Math.abs(conv.endedAt!.getTime() - lastSaid.getTime())).toBeLessThan(1000);
    // idempotent: a second open doesn't re-stamp or resurrect
    expect(await getActiveConversation(U.id)).toBeNull();
  });

  it("a messageless thread idles out from its start time", async () => {
    await wipe();
    await seedConversation("text", hoursAgo(9), null);
    expect(await getActiveConversation(U.id)).toBeNull();
  });

  it("a recently-ended voice call still restores (rollover is idle-based, not endedAt-based)", async () => {
    await wipe();
    const id = await seedConversation("voice", hoursAgo(2), hoursAgo(1), hoursAgo(1));
    const active = await getActiveConversation(U.id);
    expect(active?.conversation.id).toBe(id);
  });

  it("nothing to restore returns null quietly", async () => {
    await wipe();
    expect(await getActiveConversation(U.id)).toBeNull();
  });
});
