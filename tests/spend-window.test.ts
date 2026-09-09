// Period windows for the spend view. These are LOCAL calendar boundaries, not
// "N × 24h ago" — a call at 11pm belongs to the day the user had it, and a week
// starts on Monday where they live. Getting this wrong in server time silently
// files evening spend on the wrong day.
import { describe, expect, it } from "vitest";
import { spendWindow } from "@/lib/spend";

const LA = "America/Los_Angeles";
// A Wednesday, 11:30pm in Los Angeles (07:30 UTC Thursday) — deliberately an
// instant where local and UTC disagree about what day it is.
const LATE_WEDNESDAY = new Date("2026-09-10T06:30:00Z");

const localDay = (tz: string, at: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

describe("day windows", () => {
  it("covers the user's local day, not the server's", () => {
    const w = spendWindow("day", 0, LA, LATE_WEDNESDAY);
    // 11:30pm Wednesday local is still Wednesday, even though UTC says Thursday.
    expect(localDay(LA, w.start)).toBe("2026-09-09");
    expect(w.label).toBe("Today");
    expect(w.days).toBe(1);
    expect(w.start.getTime()).toBeLessThanOrEqual(LATE_WEDNESDAY.getTime());
    expect(w.end.getTime()).toBeGreaterThan(LATE_WEDNESDAY.getTime());
  });

  it("steps back a day at a time and names the older ones", () => {
    expect(spendWindow("day", -1, LA, LATE_WEDNESDAY).label).toBe("Yesterday");
    const older = spendWindow("day", -3, LA, LATE_WEDNESDAY);
    expect(localDay(LA, older.start)).toBe("2026-09-06");
    expect(older.label).toMatch(/Sun/);
  });

  it("windows are contiguous — no gap, no overlap", () => {
    const a = spendWindow("day", -1, LA, LATE_WEDNESDAY);
    const b = spendWindow("day", 0, LA, LATE_WEDNESDAY);
    expect(a.end.getTime()).toBe(b.start.getTime());
  });
});

describe("week windows", () => {
  it("starts on Monday, local time", () => {
    const w = spendWindow("week", 0, LA, LATE_WEDNESDAY);
    expect(localDay(LA, w.start)).toBe("2026-09-07"); // the Monday
    expect(w.days).toBe(7);
    expect(w.label).toBe("This week");
  });

  it("the previous week is the seven days before it", () => {
    const w = spendWindow("week", -1, LA, LATE_WEDNESDAY);
    expect(localDay(LA, w.start)).toBe("2026-08-31");
    expect(w.label).toBe("Last week");
    expect(spendWindow("week", -2, LA, LATE_WEDNESDAY).label).toMatch(/–/);
  });
});

describe("month windows", () => {
  it("is a real calendar month, not 30 days", () => {
    const w = spendWindow("month", 0, LA, LATE_WEDNESDAY);
    expect(localDay(LA, w.start)).toBe("2026-09-01");
    expect(w.days).toBe(30); // September
    expect(w.label).toBe("This month");
  });

  it("handles month lengths and the year boundary", () => {
    const aug = spendWindow("month", -1, LA, LATE_WEDNESDAY);
    expect(aug.days).toBe(31);
    expect(aug.label).toBe("August 2026");
    const jan = spendWindow("month", -8, LA, LATE_WEDNESDAY);
    expect(jan.label).toBe("January 2026");
    const dec = spendWindow("month", -9, LA, LATE_WEDNESDAY);
    expect(dec.label).toBe("December 2025");
  });

  it("counts February correctly", () => {
    const feb = spendWindow("month", 0, LA, new Date("2026-02-15T12:00:00Z"));
    expect(feb.days).toBe(28);
  });
});

describe("navigation limits", () => {
  it("cannot step into the future", () => {
    expect(spendWindow("day", 0, LA, LATE_WEDNESDAY).hasNext).toBe(false);
    expect(spendWindow("day", -1, LA, LATE_WEDNESDAY).hasNext).toBe(true);
    // A positive offset is clamped rather than honoured.
    expect(spendWindow("day", 5, LA, LATE_WEDNESDAY).offset).toBe(0);
  });
});

describe("daylight saving", () => {
  it("a spring-forward day is still one local day wide", () => {
    // 2026-03-08 is the US spring-forward date: that local day is 23h long.
    const w = spendWindow("day", 0, LA, new Date("2026-03-08T20:00:00Z"));
    expect(localDay(LA, w.start)).toBe("2026-03-08");
    const hours = (w.end.getTime() - w.start.getTime()) / 3_600_000;
    expect(hours).toBe(23);
  });

  it("a fall-back day is 25 hours and still one day", () => {
    const w = spendWindow("day", 0, LA, new Date("2026-11-01T18:00:00Z"));
    expect(localDay(LA, w.start)).toBe("2026-11-01");
    expect((w.end.getTime() - w.start.getTime()) / 3_600_000).toBe(25);
  });

  it("a month spanning a DST change still starts on the 1st", () => {
    const w = spendWindow("month", 0, LA, new Date("2026-03-20T12:00:00Z"));
    expect(localDay(LA, w.start)).toBe("2026-03-01");
    expect(localDay(LA, new Date(w.end.getTime() - 1))).toBe("2026-03-31");
  });
});

describe("other timezones", () => {
  it("respects a timezone ahead of UTC", () => {
    // 08:00 UTC on the 10th is already 17:00 on the 10th in Tokyo.
    const w = spendWindow("day", 0, "Asia/Tokyo", new Date("2026-09-10T08:00:00Z"));
    expect(localDay("Asia/Tokyo", w.start)).toBe("2026-09-10");
  });

  it("and one behind, where UTC has already rolled over", () => {
    const w = spendWindow("day", 0, LA, new Date("2026-09-10T03:00:00Z"));
    expect(localDay(LA, w.start)).toBe("2026-09-09"); // still the 9th in LA
  });
});
