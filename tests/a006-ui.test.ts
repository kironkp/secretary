// SEC-A006: the logic behind the screens, without a browser (sec rev checks
// the screens in a real one): the tab bar, "hide until something new", and
// what Today's thinking strip says about a failed read.
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import { TABS, tabFor } from "@/components/shell/tab-bar";
import { stillHidden } from "@/components/dashboard/hide-until-new";
import { derive, FAILED_SHOWN_MS, type Progress } from "@/components/today/thinking-strip";
import { failedLines, failedOtherLines } from "@/lib/understanding/progress";

describe("the tab bar Kiron asked to make sense", () => {
  it("is Today · Dashboard · Projects · Interview · Memory · Settings", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Today", "Dashboard", "Projects", "Interview", "Memory", "Settings"]);
  });

  it("lights Dashboard for the dashboard and the Canvas's old address, Projects for every project page", () => {
    expect(tabFor("/dashboard")).toBe("/dashboard");
    expect(tabFor("/canvas")).toBe("/dashboard");
    expect(tabFor("/projects")).toBe("/projects");
    expect(tabFor("/projects/abc-123")).toBe("/projects");
    expect(tabFor("/today")).toBe("/today");
    expect(tabFor("/workspace")).toBeNull();
    expect(tabFor("/projectsx")).toBeNull();
  });
});

describe("hidden until something new", () => {
  it("stays hidden while nothing new has arrived, and comes back when something does", () => {
    expect(stillHidden(["a", "b"], null)).toBe(false);
    expect(stillHidden(["a", "b"], ["a", "b"])).toBe(true);
    // One was done meanwhile: still nothing new.
    expect(stillHidden(["a"], ["a", "b"])).toBe(true);
    // A new one went past due (or a new suggestion arrived).
    expect(stillHidden(["a", "c"], ["a", "b"])).toBe(false);
  });
});

describe("Today's failure line", () => {
  const NOW = Date.parse("2026-10-06T19:00:00Z");
  const healthy = { ok: true, line: null, action: null } as unknown as Progress["provider"];
  const progress = (over: Partial<Progress>): Progress => ({ active: [], recent: [], lastRun: null, provider: healthy, ...over });
  const lastRun = (hoursAgo: number, reason: "validation" | "no-credits" | "other" = "validation") => ({
    projectId: "p-caltrans",
    projectName: "Caltrans",
    status: "failed" as const,
    ...failedLines("Caltrans", reason === "validation" ? ["questions[0].answers[1].label: too long"] : []),
    reason,
    finishedAt: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
  });

  it("never says the model's answer did not check out", () => {
    for (const lines of [
      failedLines("Caltrans", ["record.things[0].state.sources: at least one source"]),
      failedLines("Caltrans", []),
      failedOtherLines("Caltrans"),
    ]) {
      expect(`${lines.line} ${lines.detail}`).not.toMatch(/did not check out|something went wrong|Could not read/);
      expect(lines.line).toBe("I couldn't update my notes on Caltrans");
    }
  });

  it("a failed read more than a day old, and not being read again, shows nothing at all", () => {
    const shown = derive(progress({ lastRun: lastRun(48) }), null, null, NOW);
    expect(shown.line).toBe("");
    expect(shown.retry).toBeNull();
    expect(FAILED_SHOWN_MS).toBe(24 * 3_600_000);
  });

  it("a recent one says so in plain words, with Try now for that project", () => {
    const shown = derive(progress({ lastRun: lastRun(2) }), null, null, NOW);
    expect(shown.line).toBe("I couldn't update my notes on Caltrans");
    expect(shown.detail).toMatch(/^I'll try again when something changes, /);
    expect(shown.retry).toBe("p-caltrans");
  });

  it("a provider out of money or down gets its own way out, not Try now", () => {
    expect(derive(progress({ lastRun: lastRun(2, "no-credits") }), null, null, NOW).retry).toBeNull();
    const down = { ok: false, line: "Reading is paused.", action: "Add credits." } as unknown as Progress["provider"];
    expect(derive(progress({ lastRun: lastRun(2), provider: down }), null, null, NOW).retry).toBeNull();
  });

  it("a read that failed in the last minutes shows Try now while it is fresh", () => {
    const recent = [
      {
        projectId: "p-caltrans",
        projectName: "Caltrans",
        status: "failed" as const,
        ...failedLines("Caltrans", ["questions[0].why: too long"]),
        finishedAt: new Date(NOW - 60_000).toISOString(),
      },
    ];
    const shown = derive(progress({ recent }), null, null, NOW);
    expect(shown.phase).toBe("failed");
    expect(shown.retry).toBe("p-caltrans");
  });
});
