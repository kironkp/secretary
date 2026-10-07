// SEC-A007 (sec rev): the Overview's cards and its progress strip are the
// same order, on the same data, because both sort with lib/project-order.ts.
// Kiron's shape from production: his late projects (Jazz, Fund Finder,
// Caltrans, Personal) before Secretary app, which has nothing late; undated
// projects after; the Shopping list last. Against the local database.
process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks, user } from "@/lib/db/schema";
import { computeSignals } from "@/lib/layout/signals";
import { defaultPlan } from "@/lib/layout/plan";
import { buildLanes, DEFAULT_FILTERS } from "@/lib/timeline";

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-10-06T19:00:00Z"); // Tue Oct 6, noon PDT
const U = { id: `test-overview-order-${crypto.randomUUID()}`, email: `overview-order-${Date.now()}@sec-a007.test` };
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const names = new Map<string, string>();

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Overview Order", email: U.email, timezone: TZ });
  const shape: [string, (number | null)[], "list" | "project"][] = [
    ["Secretary app", [3], "project"],
    ["Personal", [-12, 5], "project"],
    ["DAW patent", [null], "project"],
    ["Caltrans", [-13, -4, 2], "project"],
    ["Find It app", [null], "project"],
    ["Jazz music project", [-14], "project"],
    ["Kiyomi", [25], "project"],
    ["Fund Finder", [-15], "project"],
    ["News Bot", [null], "project"],
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
      "Fund Finder",
      "Jazz music project",
      "Caltrans",
      "Personal",
      "Secretary app",
      "Kiyomi",
      "DAW patent",
      "Find It app",
      "News Bot",
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
