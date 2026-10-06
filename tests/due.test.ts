// SEC-A006: one due-date truth (lib/due.ts). Calendar days in the user's
// zone, on both sides of the 2026 DST changes in Los Angeles (Mar 8, Nov 1).
import { describe, expect, it } from "vitest";
import { daysFromToday, dueLabel, isOpenWork, isPastDue, isWaitingSuggestion, localDay } from "@/lib/due";

const LA = "America/Los_Angeles";
const at = (iso: string) => new Date(iso);

describe("calendar days in the user's zone", () => {
  it("a task due earlier today is due today, never late or yesterday", () => {
    const now = at("2026-10-06T19:00:00Z"); // noon in LA
    const nineAm = at("2026-10-06T16:00:00Z");
    expect(daysFromToday(nineAm, LA, now)).toBe(0);
    expect(dueLabel(nineAm, LA, now)).toBe("today");
    expect(isPastDue({ dueAt: nineAm, status: "todo" }, LA, now)).toBe(false);
  });

  it("11:59 PM yesterday is 1 day late; the label says days in words", () => {
    const now = at("2026-10-06T08:30:00Z"); // 1:30 AM in LA
    expect(dueLabel(at("2026-10-06T06:59:00Z"), LA, now)).toBe("1 day late"); // Oct 5, 11:59 PM
    expect(dueLabel(at("2026-09-24T19:00:00Z"), LA, now)).toBe("12 days late");
    expect(isPastDue({ dueAt: "2026-10-06T06:59:00Z", status: "todo" }, LA, now)).toBe(true);
  });

  it("across the end of daylight time (Nov 1): a 25-hour day still counts as one", () => {
    const nov2 = at("2026-11-02T18:00:00Z"); // Nov 2, 10 AM PST
    const nov1HalfPastMidnight = at("2026-11-01T07:30:00Z"); // Nov 1, 00:30 PDT
    // A 24-hour count said 2 here (Nov 1 is 25 hours long).
    expect(daysFromToday(nov1HalfPastMidnight, LA, nov2)).toBe(-1);
    expect(dueLabel(nov1HalfPastMidnight, LA, nov2)).toBe("1 day late");
    const nov1Late = at("2026-11-02T07:30:00Z"); // Nov 1, 11:30 PM PST
    expect(daysFromToday(nov1Late, LA, nov2)).toBe(-1);
    // On Nov 1 itself, before and after 2 AM, both are today.
    const nov1Early = at("2026-11-01T08:30:00Z"); // 1:30 AM PDT
    const nov1Afternoon = at("2026-11-01T23:00:00Z"); // 3 PM PST
    expect(daysFromToday(nov1Afternoon, LA, nov1Early)).toBe(0);
    expect(dueLabel(at("2026-11-02T09:00:00Z"), LA, nov1Early)).toBe("tomorrow"); // Nov 2, 1 AM PST
  });

  it("across the start of daylight time (Mar 8): a 23-hour day still counts as one", () => {
    const mar9 = at("2026-03-09T16:00:00Z"); // Mar 9, 9 AM PDT
    expect(daysFromToday(at("2026-03-08T08:30:00Z"), LA, mar9)).toBe(-1); // Mar 8, 00:30 PST
    expect(daysFromToday(at("2026-03-09T06:30:00Z"), LA, mar9)).toBe(-1); // Mar 8, 11:30 PM PDT
    expect(daysFromToday(at("2026-03-08T07:30:00Z"), LA, mar9)).toBe(-2); // Mar 7, 11:30 PM PST
    expect(localDay(at("2026-03-08T07:30:00Z"), LA)).toBe(localDay(at("2026-03-07T20:00:00Z"), LA));
  });

  it("a week out is a weekday; further is a date; no date is empty", () => {
    const now = at("2026-10-06T19:00:00Z"); // Tue
    expect(dueLabel(at("2026-10-09T19:00:00Z"), LA, now)).toBe("Fri");
    expect(dueLabel(at("2026-10-20T19:00:00Z"), LA, now)).toBe("Oct 20");
    expect(dueLabel(null, LA, now)).toBe("");
  });

  it("done or dropped is never past due", () => {
    const now = at("2026-10-06T19:00:00Z");
    expect(isPastDue({ dueAt: "2026-10-01T19:00:00Z", status: "done" }, LA, now)).toBe(false);
    expect(isPastDue({ dueAt: "2026-10-01T19:00:00Z", status: "dropped" }, LA, now)).toBe(false);
    expect(isPastDue({ dueAt: null, status: "todo" }, LA, now)).toBe(false);
  });
});

describe("open work", () => {
  it("a suggestion still waiting is not open work; once taken up it is", () => {
    expect(isWaitingSuggestion({ source: "suggested", status: "inbox" })).toBe(true);
    expect(isOpenWork({ source: "suggested", status: "inbox" })).toBe(false);
    expect(isOpenWork({ source: "suggested", status: "todo" })).toBe(true);
    expect(isOpenWork({ source: "spoken", status: "inbox" })).toBe(true);
    expect(isOpenWork({ source: "typed", status: "done" })).toBe(false);
  });
});
