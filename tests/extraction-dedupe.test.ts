// Phase 6: the extraction safety net must never duplicate what the live model
// already logged, and status signals must land on the right task. Pure dedupe
// functions first, then applyExtraction against the real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, events, memories, tasks, user } from "@/lib/db/schema";
import {
  findDuplicate,
  findDuplicateEvent,
  titleSimilarity,
} from "@/lib/secretary/dedupe";
import { applyExtraction, type ExtractionResult } from "@/lib/secretary/extraction";

describe("titleSimilarity", () => {
  it("identical and near-identical titles score high", () => {
    expect(titleSimilarity("Renew passport", "Renew passport")).toBe(1);
    expect(titleSimilarity("Renew my passport", "renew passport!")).toBeGreaterThanOrEqual(0.6);
  });

  it("rewordings that share the meaningful tokens still match", () => {
    expect(
      titleSimilarity("Send the insurance form", "send insurance form")
    ).toBeGreaterThanOrEqual(0.6);
  });

  it("unrelated titles score low", () => {
    expect(titleSimilarity("Renew passport", "Call the accountant")).toBeLessThan(0.6);
    expect(titleSimilarity("Book flights", "Dentist appointment")).toBeLessThan(0.6);
  });

  it("stopwords don't create false matches", () => {
    expect(titleSimilarity("Do the thing for my mom", "Do the thing for my boss")).toBeLessThan(1);
  });
});

describe("findDuplicate", () => {
  const existing = [
    { id: 1, title: "Renew passport", dueAt: new Date("2026-09-02T17:00:00Z") },
    { id: 2, title: "Call the accountant", dueAt: null },
  ];

  it("matches a reworded candidate with the same due date", () => {
    const hit = findDuplicate(
      { title: "renew my passport", dueAt: new Date("2026-09-02T09:00:00Z") },
      existing
    );
    expect(hit?.id).toBe(1);
  });

  it("a candidate without a date still matches on title", () => {
    expect(findDuplicate({ title: "call accountant" }, existing)?.id).toBe(2);
  });

  it("same title but a clearly different deadline is NOT a duplicate", () => {
    const hit = findDuplicate(
      { title: "Renew passport", dueAt: new Date("2026-12-01T17:00:00Z") },
      existing
    );
    expect(hit).toBeNull();
  });

  it("unrelated candidate passes through", () => {
    expect(findDuplicate({ title: "Buy groceries" }, existing)).toBeNull();
  });
});

describe("findDuplicateEvent", () => {
  const existing = [{ id: 1, title: "Lunch with Sam", startsAt: new Date("2026-08-01T12:00:00Z") }];

  it("same event a few hours off matches", () => {
    expect(
      findDuplicateEvent(
        { title: "lunch w/ Sam", startsAt: new Date("2026-08-01T12:30:00Z") },
        existing
      )?.id
    ).toBe(1);
  });

  it("same title a week later is a different event", () => {
    expect(
      findDuplicateEvent(
        { title: "Lunch with Sam", startsAt: new Date("2026-08-08T12:00:00Z") },
        existing
      )
    ).toBeNull();
  });
});

describe("applyExtraction (real database)", () => {
  const U = { id: `test-extract-${crypto.randomUUID()}`, email: `x-${Date.now()}@extract.test` };
  // relative dates: the extraction event-dedupe window is "yesterday onward",
  // so fixtures must not rot as the calendar advances
  const LUNCH_AT = new Date(Date.now() + 2 * 86400000);
  const LUNCH_AT_LATER = new Date(LUNCH_AT.getTime() + 30 * 60000);
  let convId: string;
  let insuranceTaskId: string;

  beforeAll(async () => {
    await db.insert(user).values({ id: U.id, name: "Extract Test", email: U.email });
    const { conversations } = await import("@/lib/db/schema");
    const [conv] = await db
      .insert(conversations)
      .values({ userId: U.id, mode: "voice" })
      .returning();
    convId = conv.id;
    const [insurance] = await db
      .insert(tasks)
      .values({
        userId: U.id,
        title: "Send the insurance form",
        status: "todo",
        dueAt: new Date(Date.now() - 86400000),
      })
      .returning();
    insuranceTaskId = insurance.id;
    await db.insert(tasks).values({
      userId: U.id,
      title: "Renew passport",
      status: "todo",
      dueAt: new Date("2026-09-02T17:00:00Z"),
    });
  });

  afterAll(async () => {
    await db.delete(user).where(eq(user.id, U.id));
  });

  it("dedupes known tasks, inserts new ones as inferred, applies status signals", async () => {
    const result: ExtractionResult = {
      tasks: [
        // duplicate of the existing row — must be dropped
        { title: "renew my passport", notes: null, due_at: "2026-09-02T10:00:00Z" },
        // genuinely new — must be inserted with source='inferred'
        { title: "Book dentist appointment", notes: "molar hurts", due_at: null },
      ],
      events: [
        { title: "Lunch with Sam", starts_at: LUNCH_AT.toISOString(), ends_at: null, location: null },
      ],
      status_updates: [
        { task: "insurance form", signal: "done", new_due_at: null, reason: null },
      ],
      facts: ["User's dentist is Dr. Patel"],
    };

    const summary = await applyExtraction(U.id, convId, result);
    expect(summary).toEqual({ createdTasks: 1, createdEvents: 1, updatedTasks: 1, savedFacts: 1 });

    const rows = await db.select().from(tasks).where(eq(tasks.userId, U.id));
    expect(rows).toHaveLength(3); // 2 originals + dentist, no passport dupe
    const dentist = rows.find((t) => t.title === "Book dentist appointment");
    expect(dentist?.source).toBe("inferred");
    expect(dentist?.createdFromConversationId).toBe(convId);

    const insurance = rows.find((t) => t.id === insuranceTaskId);
    expect(insurance?.status).toBe("done");
    const insuranceCheckins = await db
      .select()
      .from(checkins)
      .where(eq(checkins.taskId, insuranceTaskId));
    expect(insuranceCheckins).toHaveLength(1);
    expect(insuranceCheckins[0].type).toBe("auto_detected");

    const evs = await db.select().from(events).where(eq(events.userId, U.id));
    expect(evs).toHaveLength(1);
    expect(evs[0].source).toBe("inferred");

    const facts = await db.select().from(memories).where(eq(memories.userId, U.id));
    expect(facts.map((f) => f.fact)).toEqual(["User's dentist is Dr. Patel"]);
  });

  it("running the same extraction again changes nothing (idempotent via dedupe)", async () => {
    const again = await applyExtraction(U.id, convId, {
      tasks: [{ title: "book a dentist appointment", notes: null, due_at: null }],
      events: [
        {
          title: "lunch w/ Sam",
          starts_at: LUNCH_AT_LATER.toISOString(),
          ends_at: null,
          location: null,
        },
      ],
      status_updates: [],
      facts: ["The user's dentist is Dr. Patel"],
    });
    expect(again).toEqual({ createdTasks: 0, createdEvents: 0, updatedTasks: 0, savedFacts: 0 });
  });

  it("postpone signal bumps postponedCount and moves the due date", async () => {
    const summary = await applyExtraction(U.id, convId, {
      tasks: [],
      events: [],
      status_updates: [
        {
          task: "renew passport",
          signal: "postponed",
          new_due_at: "2026-09-03T17:00:00Z",
          reason: "waiting on photos",
        },
      ],
      facts: [],
    });
    expect(summary.updatedTasks).toBe(1);
    const [passport] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.userId, U.id))
      .then((r) => r.filter((t) => t.title === "Renew passport"));
    expect(passport.postponedCount).toBe(1);
    expect(passport.dueAt?.toISOString()).toBe("2026-09-03T17:00:00.000Z");
  });
});
