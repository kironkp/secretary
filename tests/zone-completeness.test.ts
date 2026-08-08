// Render-completeness tripwire (adaptive-UI principle #4): every zone's
// data-shaping function must include every entity type in its declared scope.
// Pure functions over fixtures — no DB, no component rendering. If a new
// entity/field ships without appearing in a covering zone, this file is where
// the build should start failing.
import { describe, expect, it } from "vitest";
import {
  buildLoopGroups,
  buildProjects,
  findNextUp,
  timelineRows,
  upcomingReminders,
} from "@/components/dashboard/zones";
import type { EventRow, TaskRow } from "@/components/dashboard/shared";

const now = Date.now();
const HOUR = 3600000;
const DAY = 24 * HOUR;
const iso = (msFromNow: number) => new Date(now + msFromNow).toISOString();

const task: TaskRow = {
  id: "task-1",
  title: "Prep questions for Ash",
  status: "todo",
  dueAt: iso(3 * DAY),
  updatedAt: iso(-1 * HOUR),
  postponedCount: 0,
  priority: 0,
  procrastinationScore: 0,
  source: "spoken",
  notes: null,
  reminders: [iso(20 * HOUR)],
  projectName: "DAW patent",
  projectColor: null,
  conversationId: "conv-1",
  messageId: null,
  conversationLabel: null,
};

const event: EventRow = {
  id: "event-1",
  title: "Patent meeting with Ash",
  startsAt: iso(2 * DAY),
  endsAt: null,
  location: "Stephens Law Group",
  notes: "11:00 AM PT / 2:00 PM ET",
  reminders: [iso(2 * DAY - 10 * 60000), iso(2 * DAY - 5 * 60000), iso(2 * DAY)],
  projectName: "DAW patent",
  source: "spoken",
  createdAt: iso(-2 * HOUR),
};

describe("render completeness: open loops", () => {
  it("includes the event in its project group, date-sorted with tasks, reminders intact", () => {
    const groups = buildLoopGroups([task], [event]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.name).toBe("DAW patent");
    expect(g.eventCount).toBe(1);
    expect(g.openCount).toBe(1);
    // event (2d) sorts before the task (3d)
    expect(g.items[0].kind).toBe("event");
    const ev = g.items[0];
    if (ev.kind !== "event") throw new Error("unreachable");
    expect(ev.event.reminders).toHaveLength(3);
    expect(ev.event.notes).toContain("2:00 PM ET");
  });

  it("drops past events and events beyond the 14-day window", () => {
    const past: EventRow = { ...event, id: "past", startsAt: iso(-3 * DAY) };
    const far: EventRow = { ...event, id: "far", startsAt: iso(20 * DAY) };
    const groups = buildLoopGroups([], [past, far]);
    expect(groups).toHaveLength(0);
  });
});

describe("render completeness: project grid", () => {
  it("shows the project's next event and lets it drive the pressure date", () => {
    const undatedTask: TaskRow = { ...task, id: "t2", dueAt: null };
    const projects = buildProjects([undatedTask], [event]);
    const daw = projects.find((p) => p.name === "DAW patent");
    expect(daw?.nextEvent?.id).toBe("event-1");
    expect(daw?.nextEvent?.reminders).toHaveLength(3);
    // pressure comes from the event (2d), not "undated"
    expect(daw?.earliestDays).toBe(2);
  });

  it("a project with only events still gets a card", () => {
    const projects = buildProjects([], [event]);
    expect(projects.find((p) => p.name === "DAW patent")).toBeTruthy();
  });
});

describe("render completeness: focus card", () => {
  it("an event competes with tasks and wins when soonest, carrying notes + reminders", () => {
    const next = findNextUp([task], [event]);
    expect(next?.kind).toBe("event");
    expect(next?.id).toBe("event-1");
    expect(next?.notes).toContain("2:00 PM ET");
    expect(next?.reminders).toHaveLength(3);
  });
});

describe("render completeness: coming-up strip", () => {
  it("renders BOTH task and event reminders inside 48h, sorted", () => {
    const upcoming = upcomingReminders([task], [event]);
    expect(upcoming.some((r) => r.kind === "task" && r.id === "task-1")).toBe(true);
    expect(upcoming.filter((r) => r.kind === "event")).toHaveLength(3);
    const times = upcoming.map((r) => r.at.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("render completeness: five-week chart", () => {
  it("puts event markers on the project's row", () => {
    const rows = timelineRows([task], [event]);
    const daw = rows.find((r) => r.name.startsWith("DAW patent"));
    expect(daw?.eventMarks).toHaveLength(1);
    expect(daw?.eventMarks[0].label).toContain("Patent meeting");
  });

  it("a project with only events still gets a row", () => {
    const rows = timelineRows([], [event]);
    expect(rows.find((r) => r.name === "DAW patent")?.eventMarks).toHaveLength(1);
  });
});
