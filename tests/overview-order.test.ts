// SEC-A007 (sec rev): the Overview's cards and its progress strip are the
// same order, on the same data, because both sort with lib/project-order.ts.
// A board of made-up projects: four with late work, by how late; then one
// due in three days and one in 25; three with no date, by name; and a list,
// itself late, that still comes last. Against the local database.
process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // The panel files its layout history in the background; not this test's subject.
  after: () => {},
}));

import { db } from "@/lib/db";
import { projects, tasks, user } from "@/lib/db/schema";
import { computeSignals } from "@/lib/layout/signals";
import { defaultPlan, type PlanSection } from "@/lib/layout/plan";
import { buildLanes, DEFAULT_FILTERS } from "@/lib/timeline";
import { DashboardPanel } from "@/components/dashboard/dashboard-panel";
import { cardDraws, groupCards, type PlanProject } from "@/components/dashboard/plan-view";
import type { EventRow, TaskRow } from "@/components/dashboard/shared";

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-10-06T19:00:00Z"); // Tue Oct 6, noon PDT
const U = { id: `test-overview-order-${crypto.randomUUID()}`, email: `overview-order-${Date.now()}@sec-a007.test` };
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const names = new Map<string, string>();

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Overview Order", email: U.email, timezone: TZ });
  const shape: [string, (number | null)[], "list" | "project"][] = [
    ["Sailing club", [3], "project"],
    ["Paperwork", [-12, 5], "project"],
    ["Deck repair", [null], "project"],
    ["Campus move", [-13, -4, 2], "project"],
    ["Field notes", [null], "project"],
    ["House concert", [-14], "project"],
    ["Kitchen remodel", [25], "project"],
    ["Garden shed", [-15], "project"],
    ["Model railway", [null], "project"],
    ["Shopping", [-30], "list"],
  ];
  for (const [name, dues, kind] of shape) {
    const [p] = await db.insert(projects).values({ userId: U.id, name, kind, status: "active" }).returning();
    names.set(p.id, name);
    await db.insert(tasks).values(
      dues.map((d, i) => ({ userId: U.id, projectId: p.id, title: `${name} ${i}`, status: "todo" as const, source: "spoken" as const, dueAt: d === null ? null : day(d) }))
    );
  }
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("cards and strip, one order", () => {
  it("the cards: late first by how late, then upcoming, then undated, the list last", async () => {
    const signals = await computeSignals(U.id, NOW);
    const cards = defaultPlan(signals)
      .sections.filter((s) => s.component === "project_card")
      .map((s) => names.get(String(s.props?.project_id)));
    expect(cards).toEqual([
      "Garden shed",
      "House concert",
      "Campus move",
      "Paperwork",
      "Sailing club",
      "Kitchen remodel",
      "Deck repair",
      "Field notes",
      "Model railway",
      "Shopping",
    ]);
  });

  it("the strip (and the Timeline) lists the projects in exactly the cards' order", async () => {
    const signals = await computeSignals(U.id, NOW);
    const cards = defaultPlan(signals)
      .sections.filter((s) => s.component === "project_card")
      .map((s) => String(s.props?.project_id))
      .filter((id) => names.get(id) !== "Shopping");
    const rows = await db.select().from(tasks).where(eq(tasks.userId, U.id));
    const work = (await db.select().from(projects).where(eq(projects.userId, U.id))).filter((p) => p.kind !== "list");
    const lanes = buildLanes(
      work.map((p) => ({ id: p.id, name: p.name, color: p.color, deadline: p.deadline?.toISOString() ?? null, deadlineKind: p.deadlineKind })),
      rows
        .filter((t) => work.some((p) => p.id === t.projectId))
        .map((t) => ({ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt?.toISOString() ?? null, startAt: null, projectId: t.projectId, reminders: [] })),
      [],
      TZ,
      NOW,
      { ...DEFAULT_FILTERS, events: false }
    );
    expect(lanes.map((l) => l.id)).toEqual(cards);
  });
});

// Seen on the real board, 2026-10-12: a project with nothing open sat between
// two that had work, and the grid showed a hole the width of a card where its
// (empty) card would have been. No seeded project had nothing open.
describe("a card with nothing to draw gets no cell in the grid", () => {
  const V = { id: `test-overview-hole-${crypto.randomUUID()}`, email: `overview-hole-${Date.now()}@sec-a007.test` };

  beforeAll(async () => {
    await db.insert(user).values({ id: V.id, name: "Overview Hole", email: V.email, timezone: TZ });
    // Nothing dated, so they sort by name: A, B, C. B's one task was finished
    // a month ago: nothing open, nothing finished this week, no event coming.
    const shape = [
      ["A has work", "todo", null],
      ["B is finished", "done", day(-30)],
      ["C has work", "todo", null],
    ] as const;
    for (const [name, status, finished] of shape) {
      const [p] = await db.insert(projects).values({ userId: V.id, name, status: "active" }).returning();
      await db.insert(tasks).values({
        userId: V.id,
        projectId: p.id,
        title: `${name}: a task`,
        status,
        source: "spoken",
        ...(finished ? { completedAt: finished, updatedAt: finished } : {}),
      });
    }
  });
  afterAll(async () => {
    await db.delete(user).where(eq(user.id, V.id));
  });

  it("the plan names all three projects; the grid is one run of two cells", async () => {
    const el = (await DashboardPanel({ userId: V.id, timezone: TZ })) as {
      props: { tasks: TaskRow[]; events: EventRow[]; planProjects: PlanProject[] };
    };
    const { tasks: rows, events, planProjects } = el.props;
    const plan = defaultPlan(await computeSignals(V.id));
    const nameOf = (s: PlanSection) => planProjects.find((p) => p.id === s.props?.project_id)?.name;
    expect(plan.sections.filter((s) => s.component === "project_card").map(nameOf)).toEqual([
      "A has work",
      "B is finished",
      "C has work",
    ]);

    const grids = groupCards(plan.sections, planProjects, (s) => cardDraws(s, planProjects, rows, events)).flatMap((g) =>
      g.kind === "cards" ? [g.sections.map(({ section }) => nameOf(section))] : []
    );
    expect(grids).toEqual([["A has work", "C has work"]]);
  });

  it("a compact card always draws its row, so it keeps its cell", async () => {
    const el = (await DashboardPanel({ userId: V.id, timezone: TZ })) as {
      props: { tasks: TaskRow[]; events: EventRow[]; planProjects: PlanProject[] };
    };
    const { tasks: rows, events, planProjects } = el.props;
    const finished = planProjects.find((p) => p.name === "B is finished")!;
    expect(cardDraws({ component: "project_card", props: { project_id: finished.id, variant: "full" } }, planProjects, rows, events)).toBe(false);
    expect(cardDraws({ component: "project_card", props: { project_id: finished.id, variant: "compact" } }, planProjects, rows, events)).toBe(true);
    expect(cardDraws({ component: "project_card", props: { project_id: "no-such-project" } }, planProjects, rows, events)).toBe(false);
  });
});
