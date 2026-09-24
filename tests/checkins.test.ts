// Check-ins (2026-09-24): "remember that I have weekly status reports due
// every Thursday… I don't want a task and a reminder. If I talk to it on a
// Thursday, ask me if I've sent the weekly status report." A question asked
// in conversation on given days — never a row on a list, never a push.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { standingCheckins, tasks, user } from "@/lib/db/schema";
import { buildBriefing } from "@/lib/secretary/briefing";
import { DAY_NAMES, daysInWords, localDay } from "@/lib/secretary/checkins";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-checkin-${crypto.randomUUID()}`, email: `checkin-${Date.now()}@p7.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };
const today = localDay(ctx.timezone);
const otherDay = DAY_NAMES[(today.weekday + 3) % 7];

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Checkin Tester", email: U.email, timezone: ctx.timezone });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("check-ins", () => {
  it("set_checkin stores a question for the days, and adds nothing to any list", async () => {
    const { result } = await executeTool(ctx, "set_checkin", {
      question: "Did you send the weekly status report?",
      days: [DAY_NAMES[today.weekday]],
    });
    expect((result as { saved?: boolean }).saved).toBe(true);
    const rows = await db.select().from(standingCheckins).where(eq(standingCheckins.userId, U.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].days).toEqual([today.weekday]);
    expect(await db.select().from(tasks).where(eq(tasks.userId, U.id))).toHaveLength(0);
  });

  it("the same question again replaces its days rather than adding a second", async () => {
    await executeTool(ctx, "set_checkin", {
      question: "did you send the weekly status report?",
      days: [DAY_NAMES[today.weekday], otherDay],
    });
    const rows = await db.select().from(standingCheckins).where(eq(standingCheckins.userId, U.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].days).toHaveLength(2);
  });

  it("is in the briefing on its day, and once asked, not again that day", async () => {
    let briefing = await buildBriefing(U.id, ctx.timezone);
    expect(briefing.text).toContain("CHECK-INS TODAY");
    expect(briefing.text).toContain("Did you send the weekly status report?");
    await executeTool(ctx, "checkin_asked", { checkin: "status report" });
    briefing = await buildBriefing(U.id, ctx.timezone);
    expect(briefing.text).not.toContain("CHECK-INS TODAY");
    expect(briefing.text).toContain("STANDING CHECK-INS");
  });

  it("is not asked on a day it does not name", async () => {
    await executeTool(ctx, "set_checkin", { question: "Did you water the plants?", days: [otherDay] });
    const briefing = await buildBriefing(U.id, ctx.timezone);
    const todayBlock = briefing.text.split("CHECK-INS TODAY")[1]?.split("\n\n")[0] ?? "";
    expect(todayBlock).not.toContain("water the plants");
  });

  it("remove_checkin stops it", async () => {
    await executeTool(ctx, "remove_checkin", { checkin: "plants" });
    const rows = await db.select().from(standingCheckins).where(eq(standingCheckins.userId, U.id));
    expect(rows.map((r) => r.question)).toEqual(["Did you send the weekly status report?"]);
  });

  it("days read as words", () => {
    expect(daysInWords([4])).toBe("Thursdays");
    expect(daysInWords([4, 1])).toBe("Mondays and Thursdays");
    expect(daysInWords([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
  });
});
