// SEC-A006 acceptance, against the local database: one account seen through
// every screen at one moment (noon in Los Angeles). Today and the board say
// the same number past due, each item shows the same "N days late" on every
// screen, an item due earlier today is "today" (never "yesterday"), a
// project's "N open" is exactly the tasks its page lists (a suggestion
// still waiting is not one), and the Workspace's project counts are real.
// SEC-A009 (sec rev's E5 and E11): a list item due today is not "due today",
// and a blocked task is open work on every screen.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // The panel files its layout history in the background; not this test's subject.
  after: () => {},
}));

import { db } from "@/lib/db";
import { projects, tasks, user } from "@/lib/db/schema";
import { buildToday } from "@/lib/understanding/today";
import { resolveBinding } from "@/lib/workspace/bindings";
import { listProjects } from "@/lib/projects/list";
import { isOpenWork } from "@/lib/due";
import { DashboardPanel } from "@/components/dashboard/dashboard-panel";
import { buildProjects } from "@/components/dashboard/zones";
import { isOverdue, type TaskRow } from "@/components/dashboard/shared";
import type { PlanProject } from "@/components/dashboard/plan-view";

const TZ = "America/Los_Angeles";
const NOON = new Date("2026-10-06T19:00:00Z"); // Tue Oct 6, 12:00 PDT
const U = { id: `test-one-truth-${crypto.randomUUID()}`, email: `one-truth-${Date.now()}@sec-a006.test` };
const ids: Record<string, string> = {};

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "One Truth", email: U.email, timezone: TZ });
  const [jazz, personal, shopping] = await db
    .insert(projects)
    .values([
      { userId: U.id, name: "Jazz music project" },
      { userId: U.id, name: "Personal" },
      { userId: U.id, name: "Shopping", kind: "list" as const },
    ])
    .returning();
  ids.jazz = jazz.id;
  ids.personal = personal.id;
  const rows = await db
    .insert(tasks)
    .values([
      { userId: U.id, projectId: jazz.id, title: "Send stems to Marcus", status: "todo" as const, source: "spoken" as const, dueAt: new Date("2026-10-04T19:00:00Z") },
      // 9 AM today: due today, not late, and never "yesterday".
      { userId: U.id, projectId: jazz.id, title: "Finish the mix", status: "in_progress" as const, source: "typed" as const, dueAt: new Date("2026-10-06T16:00:00Z") },
      { userId: U.id, projectId: jazz.id, title: "Pick the album title", status: "todo" as const, source: "spoken" as const },
      // A suggestion the user took up: their work now.
      { userId: U.id, projectId: jazz.id, title: "Call Marcus about the mix", status: "todo" as const, source: "suggested" as const, dueAt: new Date("2026-10-05T19:00:00Z") },
      // A suggestion still waiting: counted apart everywhere.
      { userId: U.id, projectId: jazz.id, title: "Batch the session notes", status: "inbox" as const, source: "suggested" as const, dueAt: new Date("2026-10-03T19:00:00Z") },
      { userId: U.id, projectId: personal.id, title: "Reply to the patent attorney", status: "todo" as const, source: "spoken" as const, dueAt: new Date("2026-09-24T19:00:00Z") },
      { userId: U.id, projectId: personal.id, title: "Old thing, done", status: "done" as const, source: "spoken" as const, dueAt: new Date("2026-09-20T19:00:00Z") },
      // Blocked is still open work, and late is late (E11).
      { userId: U.id, projectId: personal.id, title: "Renew the passport", status: "blocked" as const, source: "spoken" as const, dueAt: new Date("2026-10-05T19:00:00Z") },
      // A list item with a date: not work to chase (SEC-A003).
      { userId: U.id, projectId: shopping.id, title: "Lotion", status: "todo" as const, source: "spoken" as const, dueAt: new Date("2026-10-01T19:00:00Z") },
      // And one due today, 10 AM: still not "due today" (E5).
      { userId: U.id, projectId: shopping.id, title: "Milk", status: "todo" as const, source: "spoken" as const, dueAt: new Date("2026-10-06T17:00:00Z") },
    ])
    .returning({ id: tasks.id, title: tasks.title });
  for (const r of rows) ids[r.title] = r.id;
  // The panel reads the clock itself: pin it to noon, Date only (the database driver keeps its timers).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOON);
});

afterEach(() => undefined);
afterAll(async () => {
  vi.useRealTimers();
  await db.delete(user).where(eq(user.id, U.id));
});

/** The board's rows exactly as its views get them: suggestions waiting kept apart, list items left out. */
async function boardTasks(): Promise<TaskRow[]> {
  const el = (await DashboardPanel({ userId: U.id, timezone: TZ })) as { props: { tasks: TaskRow[]; planProjects: PlanProject[] } };
  const lists = new Set(el.props.planProjects.filter((p) => p.kind === "list").map((p) => p.id));
  return el.props.tasks.filter((t) => !lists.has(t.projectId ?? ""));
}

describe("one truth across Today, the board, the project page and the Workspace", () => {
  it("Today and the board both say 4 past due: the same items, the same words", async () => {
    const today = await buildToday(U.id, TZ, NOON);
    const board = await boardTasks();
    const pastDueOnBoard = board.filter(isOverdue);

    expect(today.counts.pastDue).toBe(4);
    expect(today.counts.pastDueSuggested).toBe(1);
    expect(pastDueOnBoard).toHaveLength(4);
    expect(new Set(pastDueOnBoard.map((t) => t.id))).toEqual(new Set(today.pastDue.map((r) => r.id)));
    expect(new Set(today.pastDue.map((r) => r.id))).toEqual(
      new Set([ids["Send stems to Marcus"], ids["Call Marcus about the mix"], ids["Reply to the patent attorney"], ids["Renew the passport"]])
    );
    // Each item reads the same on both screens.
    for (const row of today.pastDue) {
      expect(board.find((t) => t.id === row.id)?.dueLabel, row.fields.title).toBe(row.fields.due);
    }
    expect(board.find((t) => t.id === ids["Reply to the patent attorney"])?.dueLabel).toBe("12 days late");
    expect(board.find((t) => t.id === ids["Send stems to Marcus"])?.dueLabel).toBe("2 days late");
  });

  it("due earlier today is today: not past due, never yesterday", async () => {
    const mix = (await boardTasks()).find((t) => t.id === ids["Finish the mix"])!;
    expect(mix.dueLabel).toBe("today");
    expect(isOverdue(mix)).toBe(false);
    const today = await buildToday(U.id, TZ, NOON);
    expect(today.dueToday.map((r) => r.id)).toEqual([ids["Finish the mix"]]);
  });

  it("a Shopping item due today is not due today: not in the list, not in the count (E5)", async () => {
    const today = await buildToday(U.id, TZ, NOON);
    expect(today.dueToday.map((r) => r.fields.title)).not.toContain("Milk");
    expect(today.counts.dueToday).toBe(1);
    expect(today.todayLine).toBe("1 due today.");
  });

  it("a blocked task is open work on Today, the board, the project card and page, listProjects and the Workspace (E11)", async () => {
    const id = ids["Renew the passport"];
    const today = await buildToday(U.id, TZ, NOON);
    expect(today.pastDue.map((r) => r.id)).toContain(id);
    const board = await boardTasks();
    expect(board.filter(isOverdue).map((t) => t.id)).toContain(id);
    const card = buildProjects(board).find((p) => p.id === ids.personal)!;
    expect(card.open.map((t) => t.id)).toContain(id);
    const page = (await db.select().from(tasks).where(eq(tasks.projectId, ids.personal))).filter(isOpenWork);
    expect(new Set(page.map((t) => t.id))).toEqual(new Set(card.open.map((t) => t.id)));
    expect(page).toHaveLength(2);
    const listed = await listProjects(U.id, TZ, NOON);
    expect(listed.find((p) => p.id === ids.personal)).toMatchObject({ open: 2, pastDue: 2 });
    const rows = await resolveBinding(U.id, { source: "projects", where: { open: true } }, TZ, NOON);
    expect(rows.find((r) => r.fields.name === "Personal")?.fields.open).toBe("2");
  });

  it('"4 open" under Jazz is exactly the 4 tasks Jazz\'s page lists', async () => {
    const board = await boardTasks();
    const card = buildProjects(board).find((p) => p.id === ids.jazz)!;
    expect(card.open).toHaveLength(4);
    const page = (await db.select().from(tasks).where(eq(tasks.projectId, ids.jazz))).filter(isOpenWork);
    expect(new Set(page.map((t) => t.id))).toEqual(new Set(card.open.map((t) => t.id)));
    expect(page.map((t) => t.title)).not.toContain("Batch the session notes");
    const listed = await listProjects(U.id, TZ, NOON);
    expect(listed.find((p) => p.id === ids.jazz)).toMatchObject({ open: 4, pastDue: 2, next: "2 days late" });
    expect(listed.find((p) => p.name === "Shopping")).toMatchObject({ kind: "list", open: 2 });
  });

  it("the Workspace's project counts are real (they were 0 for every project) and leave waiting suggestions out", async () => {
    const rows = await resolveBinding(U.id, { source: "projects", where: { open: true } }, TZ, NOON);
    const by = Object.fromEntries(rows.map((r) => [r.fields.name, r.fields.open]));
    expect(by["Jazz music project"]).toBe("4");
    expect(by["Personal"]).toBe("2");
  });

  it("the Workspace's past-due rows read the same words as Today and the board", async () => {
    const rows = await resolveBinding(U.id, { source: "tasks", where: { open: true, due: "overdue" }, sort: "due" }, TZ, NOON);
    const board = await boardTasks();
    for (const r of rows) {
      const onBoard = board.find((t) => t.id === r.id);
      if (onBoard) expect(onBoard.dueLabel, r.fields.title).toBe(r.fields.due);
    }
  });
});
