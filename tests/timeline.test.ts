// SEC-A009: the timeline's shape and date math, without a browser
// (lib/timeline.ts). Lanes and progress per project, bars and single dates,
// the filters, and what a drag of the body or an edge changes. Days are the
// user's calendar days; a move keeps the time of day across a DST change.
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import {
  atDay,
  buildLanes,
  DEFAULT_FILTERS,
  eventItem,
  moved,
  shiftDays,
  shiftedReminders,
  taskItem,
  undated,
  windowFor,
  type TlEvent,
  type TlProject,
  type TlTask,
} from "@/lib/timeline";
import { localDay } from "@/lib/due";

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-10-06T19:00:00Z"); // Tue Oct 6, noon PDT
const TODAY = localDay(NOW, TZ);
const day = (iso: string) => localDay(new Date(iso), TZ);

const task = (over: Partial<TlTask>): TlTask => ({
  id: over.id ?? crypto.randomUUID(),
  title: over.title ?? "A task",
  status: "todo",
  dueAt: null,
  startAt: null,
  projectId: "jazz",
  reminders: [],
  ...over,
});
const event = (over: Partial<TlEvent>): TlEvent => ({
  id: over.id ?? crypto.randomUUID(),
  title: over.title ?? "An event",
  startsAt: "2026-10-08T17:00:00Z",
  endsAt: null,
  projectId: "jazz",
  recurrence: [],
  reminders: [],
  ...over,
});
const PROJECTS: TlProject[] = [
  { id: "jazz", name: "Jazz music project", color: "#7c3aed", deadline: "2026-11-20T08:00:00Z", deadlineKind: "committed" },
  { id: "personal", name: "Personal", color: null, deadline: null, deadlineKind: null },
  { id: "empty", name: "Empty project", color: null, deadline: null, deadlineKind: null },
];

describe("shiftDays: whole calendar days, the same time of day", () => {
  it("keeps 9 AM across the end of daylight time (Nov 1)", () => {
    // Sat Oct 31, 9 AM PDT → Mon Nov 2, 9 AM PST: 49 hours later, not 48.
    expect(shiftDays("2026-10-31T16:00:00.000Z", 2, TZ)).toBe("2026-11-02T17:00:00.000Z");
    expect(shiftDays("2026-11-02T17:00:00.000Z", -2, TZ)).toBe("2026-10-31T16:00:00.000Z");
  });
  it("keeps 9 AM across the start of daylight time (Mar 14, 2027)", () => {
    expect(shiftDays("2027-03-13T17:00:00.000Z", 3, TZ)).toBe("2027-03-16T16:00:00.000Z");
  });
  it("crosses a month and a year", () => {
    expect(shiftDays("2026-12-30T20:00:00.000Z", 3, "UTC")).toBe("2027-01-02T20:00:00.000Z");
  });
  it("atDay is that calendar day at 5 PM in the user's zone", () => {
    expect(atDay(day("2026-10-09T19:00:00Z"), TZ)).toBe("2026-10-10T00:00:00.000Z");
  });
  it("reminders all move by the same days", () => {
    expect(shiftedReminders(["2026-10-31T16:00:00.000Z", "2026-10-30T15:00:00.000Z"], 2, TZ)).toEqual([
      "2026-11-02T17:00:00.000Z",
      "2026-11-01T16:00:00.000Z",
    ]);
  });
});

describe("items: a bar from start to due, or a single date", () => {
  it("a task with a start before its due is a bar", () => {
    const item = taskItem(task({ startAt: "2026-10-07T16:00:00Z", dueAt: "2026-10-12T00:00:00Z" }), TZ, TODAY)!;
    expect(item).toMatchObject({ from: day("2026-10-07T16:00:00Z"), to: day("2026-10-12T00:00:00Z"), bar: true, late: false });
  });
  it("a start on the due day is a one-day bar (sec rev G5: allowed, and drawn as planned)", () => {
    const item = taskItem(task({ startAt: "2026-10-09T16:00:00Z", dueAt: "2026-10-10T00:00:00Z" }), TZ, TODAY)!;
    expect(item).toMatchObject({ bar: true, from: item.to });
  });
  it("due only is a single date; no date is not on the board", () => {
    expect(taskItem(task({ dueAt: "2026-10-09T19:00:00Z" }), TZ, TODAY)).toMatchObject({ bar: false });
    expect(taskItem(task({}), TZ, TODAY)).toBeNull();
  });
  it("a start after the due day is ignored, never drawn backwards", () => {
    const item = taskItem(task({ startAt: "2026-10-20T16:00:00Z", dueAt: "2026-10-09T19:00:00Z" }), TZ, TODAY)!;
    expect(item.from).toBe(item.to);
    expect(item.bar).toBe(false);
  });
  it("late is by calendar day: due 9 AM today is not late at noon; done is never late", () => {
    expect(taskItem(task({ dueAt: "2026-10-06T16:00:00Z" }), TZ, TODAY)!.late).toBe(false);
    expect(taskItem(task({ dueAt: "2026-10-05T16:00:00Z" }), TZ, TODAY)!.late).toBe(true);
    expect(taskItem(task({ dueAt: "2026-10-05T16:00:00Z", status: "done" }), TZ, TODAY)!.late).toBe(false);
    expect(taskItem(task({ dueAt: "2026-10-05T16:00:00Z", status: "blocked" }), TZ, TODAY)!.late).toBe(true);
  });
  it("a repeating event is locked; a one-off is not", () => {
    expect(eventItem(event({ recurrence: ["RRULE:FREQ=WEEKLY"] }), TZ)).toMatchObject({ locked: true });
    expect(eventItem(event({ endsAt: "2026-10-10T17:00:00Z" }), TZ)).toMatchObject({ locked: false, bar: true });
  });
});

describe("lanes: one per project, with its progress, late first", () => {
  const tasks = [
    task({ title: "Send stems", dueAt: "2026-10-12T19:00:00Z", projectId: "jazz" }),
    task({ title: "Mix", status: "done", dueAt: "2026-10-01T19:00:00Z", projectId: "jazz" }),
    task({ title: "Title", projectId: "jazz" }),
    task({ title: "Dropped one", status: "dropped", dueAt: "2026-10-02T19:00:00Z", projectId: "jazz" }),
    task({ title: "Passport", status: "blocked", dueAt: "2026-10-05T19:00:00Z", projectId: "personal" }),
    task({ title: "Loose end", dueAt: "2026-10-20T19:00:00Z", projectId: null }),
  ];
  const lanes = buildLanes(PROJECTS, tasks, [event({ title: "Session", projectId: "jazz" })], TZ, NOW, DEFAULT_FILTERS);

  it("progress counts every task of the project but dropped ones, whatever the filter shows", () => {
    const jazz = lanes.find((l) => l.id === "jazz")!;
    expect({ done: jazz.done, total: jazz.total }).toEqual({ done: 1, total: 3 });
    // Open by default: the done one is counted but not drawn.
    expect(jazz.items.map((i) => i.title)).toEqual(["Session", "Send stems"]);
  });
  it("a late project comes first; a project with nothing is left out; tasks in none get a lane", () => {
    expect(lanes.map((l) => l.name)).toEqual(["Personal", "Jazz music project", "No project"]);
    expect(lanes[0].late).toBe(true);
  });
  it("a late project stays first even when the filter hides its late task", () => {
    // Done shows no open task anywhere, so the nearest-date order ties; late still leads.
    const done = buildLanes(PROJECTS, tasks, [], TZ, NOW, { ...DEFAULT_FILTERS, status: "done" });
    expect(done.map((l) => l.name)).toEqual(["Personal", "Jazz music project", "No project"]);
  });
  it("the deadline is a flag at its day, committed or not", () => {
    expect(lanes.find((l) => l.id === "jazz")!.deadline).toEqual({ day: day("2026-11-20T08:00:00Z"), committed: true });
  });
  it("filters: Late, Done, All, events off, one project", () => {
    const names = (f: Partial<typeof DEFAULT_FILTERS>) =>
      buildLanes(PROJECTS, tasks, [event({ title: "Session" })], TZ, NOW, { ...DEFAULT_FILTERS, ...f }).flatMap((l) => l.items.map((i) => i.title));
    expect(names({ status: "late" })).toEqual(["Passport"]);
    expect(names({ status: "done" })).toEqual(["Mix"]);
    expect(names({ status: "all" }).sort()).toEqual(["Loose end", "Mix", "Passport", "Send stems", "Session"]);
    expect(names({ events: false })).not.toContain("Session");
    expect(buildLanes(PROJECTS, tasks, [], TZ, NOW, { ...DEFAULT_FILTERS, project: "personal" }).map((l) => l.id)).toEqual(["personal"]);
  });
  it("the No date tray is open tasks without a date, by project", () => {
    expect(undated(tasks, DEFAULT_FILTERS).map((t) => t.title)).toEqual(["Title"]);
    expect(undated(tasks, { ...DEFAULT_FILTERS, project: "personal" })).toEqual([]);
  });
  it("the window reaches past every item and deadline", () => {
    const span = windowFor(lanes, "week", TZ, NOW);
    expect(span.from).toBeLessThanOrEqual(day("2026-10-05T19:00:00Z") - 2);
    expect(span.to).toBeGreaterThanOrEqual(day("2026-11-20T08:00:00Z") + 2);
  });
});

describe("moves: what a drag of the body or an edge changes", () => {
  const bar = taskItem(task({ startAt: "2026-10-07T16:00:00Z", dueAt: "2026-10-12T00:00:00Z" }), TZ, TODAY)!;
  const single = taskItem(task({ dueAt: "2026-10-09T19:00:00Z" }), TZ, TODAY)!;

  it("the body moves start and due together, by the same days", () => {
    expect(moved(bar, "body", 3, TZ)).toEqual({
      due_at: shiftDays("2026-10-12T00:00:00Z", 3, TZ),
      start_at: shiftDays("2026-10-07T16:00:00Z", 3, TZ),
      reminders: null,
    });
    expect(moved(single, "body", -1, TZ)).toEqual({ due_at: "2026-10-08T19:00:00.000Z", reminders: null });
  });
  it("the right edge moves only the due date, never before the start", () => {
    expect(moved(bar, "end", 2, TZ)).toEqual({ due_at: shiftDays("2026-10-12T00:00:00Z", 2, TZ), reminders: null });
    expect(moved(bar, "end", -10, TZ)).toBeNull();
  });
  it("the left edge moves only the start, never past the due day", () => {
    expect(moved(bar, "start", -2, TZ)).toEqual({ start_at: "2026-10-05T16:00:00.000Z" });
    expect(moved(bar, "start", 10, TZ)).toBeNull();
  });
  it("a single date's left handle grows a start out of its due day", () => {
    expect(moved(single, "start", -3, TZ)).toEqual({ start_at: "2026-10-06T19:00:00.000Z" });
    expect(moved(single, "start", 1, TZ)).toBeNull();
  });
  it("no move, no change; a repeating event never moves by drag", () => {
    expect(moved(bar, "body", 0, TZ)).toBeNull();
    expect(moved(eventItem(event({ recurrence: ["RRULE:FREQ=WEEKLY"] }), TZ), "body", 1, TZ)).toBeNull();
  });
  it("a one-off event's body moves both ends; its edges each move one", () => {
    const e = eventItem(event({ startsAt: "2026-10-08T17:00:00Z", endsAt: "2026-10-10T17:00:00Z" }), TZ);
    expect(moved(e, "body", 1, TZ)).toEqual({ starts_at: "2026-10-09T17:00:00.000Z", ends_at: "2026-10-11T17:00:00.000Z", reminders: null });
    expect(moved(e, "end", 1, TZ)).toEqual({ ends_at: "2026-10-11T17:00:00.000Z" });
    expect(moved(e, "start", 5, TZ)).toBeNull();
  });
});

describe("lanes in the one urgency order (SEC-A007, lib/project-order.ts)", () => {
  const P = (id: string, name: string, deadline: string | null = null): TlProject => ({
    id,
    name,
    color: null,
    deadline,
    deadlineKind: deadline ? "committed" : null,
  });

  it("a project with nothing dated sorts by its own deadline: after late work, before a later date", () => {
    const lanes = buildLanes(
      [P("alpha", "Alpha"), P("beta", "Beta", "2026-10-08T19:00:00Z"), P("gamma", "Gamma")],
      [
        task({ projectId: "alpha", dueAt: "2026-10-16T19:00:00Z" }), // in 10 days
        task({ projectId: "beta" }), // no date of its own; the project is due in 2 days
        task({ projectId: "gamma", dueAt: "2026-10-03T19:00:00Z" }), // 3 days late
      ],
      [],
      TZ,
      NOW,
      DEFAULT_FILTERS
    );
    expect(lanes.map((l) => l.name)).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("a lane is ordered by when its work is DUE, not by when it was planned to start", () => {
    const lanes = buildLanes(
      [P("alpha", "Alpha"), P("beta", "Beta")],
      [
        // Started ten days ago, due in five: not late, and after Beta.
        task({ projectId: "alpha", startAt: "2026-09-26T19:00:00Z", dueAt: "2026-10-11T19:00:00Z" }),
        task({ projectId: "beta", dueAt: "2026-10-08T19:00:00Z" }), // due in two days
      ],
      [],
      TZ,
      NOW,
      DEFAULT_FILTERS
    );
    expect(lanes.map((l) => l.name)).toEqual(["Beta", "Alpha"]);
    expect(lanes.find((l) => l.name === "Alpha")?.soonest).toBe(TODAY + 5);
  });

  it("the lanes follow his project order first (v1.11): the ones he placed by place, then the urgency order", () => {
    const lanes = buildLanes(
      [{ ...P("alpha", "Alpha"), position: 1 }, { ...P("beta", "Beta"), position: 0 }, P("gamma", "Gamma")],
      [
        task({ projectId: "alpha", dueAt: "2026-10-16T19:00:00Z" }), // in 10 days
        task({ projectId: "beta" }),
        task({ projectId: "gamma", dueAt: "2026-10-03T19:00:00Z" }), // 3 days late: first, had he placed nothing
      ],
      [],
      TZ,
      NOW,
      DEFAULT_FILTERS
    );
    expect(lanes.map((l) => l.name)).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("two lanes with one name keep their places: when the project was made, then its id (v1.11 r2)", () => {
    const older = { ...P("b", "Twin"), createdAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...P("a", "Twin"), createdAt: "2026-02-01T00:00:00.000Z" };
    const tasks = [task({ projectId: "a" }), task({ projectId: "b" })];
    for (const projects of [[older, newer], [newer, older]]) {
      expect(buildLanes(projects, tasks, [], TZ, NOW, DEFAULT_FILTERS).map((l) => l.id)).toEqual(["b", "a"]);
    }
  });

  it("the order is the same whatever the status filter shows", () => {
    const projects = [P("alpha", "Alpha"), P("zeta", "Zeta")];
    const tasks = [
      task({ projectId: "alpha", dueAt: "2026-10-04T19:00:00Z" }), // 2 days late
      task({ projectId: "alpha", status: "done", dueAt: "2026-10-01T19:00:00Z" }),
      task({ projectId: "zeta", dueAt: "2026-09-27T19:00:00Z" }), // 9 days late
      task({ projectId: "zeta", status: "done", dueAt: "2026-10-01T19:00:00Z" }),
    ];
    for (const status of ["open", "late", "done", "all"] as const) {
      const lanes = buildLanes(projects, tasks, [], TZ, NOW, { ...DEFAULT_FILTERS, status });
      expect(lanes.map((l) => l.name), `status filter: ${status}`).toEqual(["Zeta", "Alpha"]);
    }
  });
});
