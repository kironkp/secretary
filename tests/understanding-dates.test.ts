// SEC-A004: understanding writes dates, never countdowns. Its words are kept
// until the project is read again, which since v0.28 is when its data changes
// or a dated item crosses a line, so "due in 3 days" would go wrong the next
// morning. The prompt asks for dates; anything the model writes as a
// countdown anyway is turned into its date before it is stored.
process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, records, tasks, user } from "@/lib/db/schema";
import { absoluteDates, COUNTDOWN } from "@/lib/understanding/dates";
import { UNDERSTANDING_SYSTEM } from "@/lib/understanding/prompt";
import { runProject } from "@/lib/understanding/run";
import { CPO_NOW, CPO_TZ, fakeModel, minimalOutputFor } from "./fixtures/understanding";

// Mon Oct 19, 2026, mid-morning in Los Angeles.
const clock = { nowIso: "2026-10-19T17:00:00.000Z", timezone: CPO_TZ, localDate: "2026-10-19", tomorrowLocalDate: "2026-10-20" };
const U = { id: `test-dates-${crypto.randomUUID()}`, email: `dates-${Date.now()}@sec-a004.test` };
let projectId = "";

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Dates", email: U.email, timezone: CPO_TZ });
  const [p] = await db.insert(projects).values({ userId: U.id, name: "Caltrans" }).returning();
  projectId = p.id;
  await db.insert(tasks).values({ userId: U.id, projectId, title: "Send the CPO", status: "todo" });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("dates, not countdowns", () => {
  it("the prompt asks for dates and names countdowns as what not to write", () => {
    expect(UNDERSTANDING_SYSTEM).toContain("dates as dates, never countdowns");
    expect(UNDERSTANDING_SYSTEM).not.toContain('days as digits ("42 days late"');
  });

  it("a countdown becomes its date; today and tomorrow stay", () => {
    expect(absoluteDates("The statement is due in 3 days.", clock).text).toBe("The statement is due on Thu, Oct 22.");
    expect(absoluteDates("The sign-off is 42 days late.", clock).text).toBe("The sign-off is overdue since Mon, Sep 7.");
    expect(absoluteDates("You asked two weeks ago.", clock).text).toBe("You asked on Mon, Oct 5.");
    expect(absoluteDates("Three days left to file.", clock).text).toBe("until Thu, Oct 22 to file.");
    expect(absoluteDates("Due in a week.", clock).text).toBe("Due on Mon, Oct 26.");
    const kept = absoluteDates("Due tomorrow; the meeting is today.", clock);
    expect(kept).toEqual({ text: "Due tomorrow; the meeting is today.", changed: 0 });
  });

  it("on-screen words carry no countdown, whatever the model wrote; the record and its quotes stay verbatim (sec rev P8)", async () => {
    const counting = fakeModel((bundle) => {
      const out = minimalOutputFor(bundle);
      const [widget] = Object.keys(out.words.ledes);
      return {
        ...out,
        record: {
          ...out.record,
          // A standing rule quoting its source: "in 30 days" is a duration here.
          rules: [
            {
              text: "Reimbursements arrive in 30 days after the CPO is approved.",
              sources: [{ type: "task", id: bundle.tasksOpen[0].id }],
              confidence: "high",
            },
          ],
        },
        words: {
          todayLine: "The CPO is due in 3 days.",
          ledes: widget ? { ...out.words.ledes, [widget]: "One of these is 42 days late." } : out.words.ledes,
        },
      };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runProject(U.id, projectId, { timezone: CPO_TZ, now: CPO_NOW, model: counting });
      expect(result.status, JSON.stringify(result)).toBe("ok");
    } finally {
      warn.mockRestore();
    }
    expect(counting.calls).toHaveLength(1);
    const [row] = await db.select().from(records).where(and(eq(records.userId, U.id), eq(records.projectId, projectId)));
    expect(JSON.stringify(row.words)).not.toMatch(COUNTDOWN);
    expect(row.words.todayLine).toBe("The CPO is due on Fri, Sep 25.");
    expect(row.body.rules[0].text).toBe("Reimbursements arrive in 30 days after the CPO is approved.");
  });
});
