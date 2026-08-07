// F-6: user A must never see user B's data. Exercises the real query layer
// against the real database (needs `npm run db:local` or Docker Postgres up).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages, tasks, user } from "@/lib/db/schema";
import {
  getConversations,
  getMessages,
  getTasks,
  getTodayStrip,
} from "@/lib/db/queries";

const A = { id: `test-user-a-${crypto.randomUUID()}`, email: `a-${Date.now()}@scoping.test` };
const B = { id: `test-user-b-${crypto.randomUUID()}`, email: `b-${Date.now()}@scoping.test` };

let bConversationId: string;

beforeAll(async () => {
  await db.insert(user).values([
    { id: A.id, name: "User A", email: A.email, timezone: "America/New_York" },
    { id: B.id, name: "User B", email: B.email, timezone: "Europe/London" },
  ]);

  await db.insert(tasks).values([
    { userId: A.id, title: "A's private task", status: "todo" },
    {
      userId: B.id,
      title: "B's overdue secret",
      status: "todo",
      dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    },
  ]);

  const [conv] = await db
    .insert(conversations)
    .values({ userId: B.id, mode: "text" })
    .returning();
  bConversationId = conv.id;
  await db.insert(messages).values({
    userId: B.id,
    conversationId: bConversationId,
    role: "user",
    content: "B's confidential message",
    mode: "text",
  });
});

afterAll(async () => {
  // user cascade wipes tasks/conversations/messages
  await db.delete(user).where(inArray(user.id, [A.id, B.id]));
});

describe("user scoping", () => {
  it("A's task list never contains B's tasks", async () => {
    const aTasks = await getTasks(A.id);
    expect(aTasks.length).toBe(1);
    expect(aTasks[0].title).toBe("A's private task");
    expect(aTasks.some((t) => t.userId !== A.id)).toBe(false);
  });

  it("A cannot see B's conversations", async () => {
    const aConvs = await getConversations(A.id);
    expect(aConvs.length).toBe(0);
  });

  it("A cannot read B's messages even with a valid conversation id", async () => {
    const stolen = await getMessages(A.id, bConversationId);
    expect(stolen.length).toBe(0);
  });

  it("B still sees their own data (scoping isn't just returning nothing)", async () => {
    const bTasks = await getTasks(B.id);
    expect(bTasks.map((t) => t.title)).toEqual(["B's overdue secret"]);
    const bMsgs = await getMessages(B.id, bConversationId);
    expect(bMsgs.length).toBe(1);
  });

  it("today-strip counts are scoped (B's overdue task doesn't leak into A's strip)", async () => {
    const aStrip = await getTodayStrip(A.id, "America/New_York");
    expect(aStrip.overdueCount).toBe(0);
    const bStrip = await getTodayStrip(B.id, "Europe/London");
    expect(bStrip.overdueCount).toBe(1);
  });
});
