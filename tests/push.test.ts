// Web Push plumbing: the once-only claim, and the minute-scanner turning due
// reminders into exactly one push each. No live pushes here — the test user
// has no subscriptions, so sendPush delivers to zero devices by construction.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { pushLog, tasks, user } from "@/lib/db/schema";
import { claimPush, scanDueReminders } from "@/lib/push";

const U = { id: `test-push-${crypto.randomUUID()}`, email: `push-${Date.now()}@pwa.test` };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Push Tester", email: U.email });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("claimPush", () => {
  it("first claim wins, second is refused — the once-only guarantee", async () => {
    const key = `test:${U.id}:${Date.now()}`;
    expect(await claimPush(U.id, key)).toBe(true);
    expect(await claimPush(U.id, key)).toBe(false);
  });
});

describe("scanDueReminders", () => {
  it("claims a just-due task reminder once; ignores future and stale ones", async () => {
    const now = new Date();
    const due = new Date(now.getTime() - 2 * 60 * 1000).toISOString(); // 2 min ago
    const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const stale = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1h ago — past catch-up
    const [t] = await db
      .insert(tasks)
      .values({
        userId: U.id,
        title: "Send the WSR",
        status: "todo",
        reminders: [due, future, stale],
      })
      .returning();

    await scanDueReminders(now);
    const logs = await db.select().from(pushLog).where(eq(pushLog.userId, U.id));
    const keys = logs.map((l) => l.key);
    expect(keys).toContain(`task:${t.id}:${due}`);
    expect(keys).not.toContain(`task:${t.id}:${future}`);
    expect(keys).not.toContain(`task:${t.id}:${stale}`);

    // second pass: nothing new claimed
    await scanDueReminders(now);
    const again = await db.select().from(pushLog).where(eq(pushLog.userId, U.id));
    expect(again.length).toBe(logs.length);
  });

  it("done tasks never ring", async () => {
    const now = new Date();
    const due = new Date(now.getTime() - 60 * 1000).toISOString();
    const [t] = await db
      .insert(tasks)
      .values({ userId: U.id, title: "Old chore", status: "done", reminders: [due] })
      .returning();
    await scanDueReminders(now);
    const logs = await db.select().from(pushLog).where(eq(pushLog.userId, U.id));
    expect(logs.map((l) => l.key)).not.toContain(`task:${t.id}:${due}`);
  });
});
