// Phase 8: the v1 heuristic — postpones + age + ignored nudges + due-date
// slippage. Pure function, fixed clock.
import { describe, expect, it } from "vitest";
import { procrastinationScore } from "@/lib/secretary/procrastination";

const NOW = new Date("2026-07-30T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000);

describe("procrastinationScore", () => {
  it("a fresh task scores ~0", () => {
    expect(
      procrastinationScore(
        { postponedCount: 0, createdAt: NOW, dueAt: null, lastNudgedAt: null },
        NOW
      )
    ).toBe(0);
  });

  it("each postpone is the dominant signal (+2)", () => {
    const base = { createdAt: daysAgo(1), dueAt: null, lastNudgedAt: null };
    const once = procrastinationScore({ ...base, postponedCount: 1 }, NOW);
    const four = procrastinationScore({ ...base, postponedCount: 4 }, NOW);
    expect(once).toBeGreaterThanOrEqual(2);
    expect(four - once).toBeCloseTo(6, 5);
  });

  it("overdue days add up but cap", () => {
    const base = { postponedCount: 0, createdAt: daysAgo(2), lastNudgedAt: null };
    const late2 = procrastinationScore({ ...base, dueAt: daysAgo(2) }, NOW);
    const late30 = procrastinationScore({ ...base, dueAt: daysAgo(30) }, NOW);
    expect(late2).toBeGreaterThan(0);
    expect(late30 - late2).toBeLessThanOrEqual(3); // overdue contribution caps at +3
  });

  it("an ignored nudge (>1 day old, still open) adds a point", () => {
    const base = { postponedCount: 0, createdAt: daysAgo(3), dueAt: null };
    const ignored = procrastinationScore({ ...base, lastNudgedAt: daysAgo(2) }, NOW);
    const justNudged = procrastinationScore({ ...base, lastNudgedAt: daysAgo(0.5) }, NOW);
    expect(ignored - justNudged).toBe(1);
  });

  it("the spec's poster child — pushed 4× over 3 weeks — crosses the surfacing threshold", () => {
    const score = procrastinationScore(
      { postponedCount: 4, createdAt: daysAgo(21), dueAt: daysAgo(3), lastNudgedAt: daysAgo(2) },
      NOW
    );
    expect(score).toBeGreaterThanOrEqual(6); // top-offender territory
  });
});
