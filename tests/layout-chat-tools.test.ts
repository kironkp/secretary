// F7 chat-ban (SPEC §8) + edit_layout_plan, end-to-end against the real DB
// (needs the local Postgres up, like user-scoping.test.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, projects, tasks, user } from "@/lib/db/schema";
import { defaultPlan, sectionKey, type LayoutPlan } from "@/lib/layout/plan";
import { computeCurrentPlan, getPlanHead, savePlanAsHead } from "@/lib/layout/plan-store";
import { computeSignals } from "@/lib/layout/signals";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-layout-${crypto.randomUUID()}`, email: `layout-${Date.now()}@tools.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Layout Tester", email: U.email });
  await db.insert(projects).values([
    { id: `${U.id}-urgent`, userId: U.id, name: "urgent-proj", status: "active" },
    { id: `${U.id}-other`, userId: U.id, name: "other-proj", status: "active" },
  ]);
  await db.insert(tasks).values([
    {
      userId: U.id,
      projectId: `${U.id}-urgent`,
      title: "Urgent filing",
      status: "todo",
      dueAt: new Date(Date.now() + 2 * 86400000),
    },
    { userId: U.id, projectId: `${U.id}-other`, title: "Someday thing", status: "todo" },
  ]);
  // A stored head to edit against.
  const signals = await computeSignals(U.id);
  await savePlanAsHead(U.id, defaultPlan(signals));
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id)); // cascades all rows
});

describe("get_current_plan", () => {
  it("returns sections with keys, registry version, and preferences", async () => {
    const { result } = await executeTool(ctx, "get_current_plan", {});
    const r = result as { registry_version: number; sections: { key: string }[]; preferences: unknown[] };
    expect(r.registry_version).toBeGreaterThanOrEqual(2);
    expect(r.sections.some((s) => s.key === "people_index")).toBe(true);
    expect(r.preferences).toEqual([]);
  });
});

describe("F7 chat-ban", () => {
  it("stores the ban, re-renders the live plan without the section, and keeps future plans clean", async () => {
    const { result } = await executeTool(ctx, "set_layout_preference", {
      kind: "ban_component",
      component: "people_index",
    });
    expect((result as { stored?: boolean }).stored).toBe(true);

    // live plan re-rendered without it immediately
    const head = await getPlanHead(U.id);
    const headPlan = head?.spec as LayoutPlan;
    expect(headPlan.sections.map((s) => s.component)).not.toContain("people_index");

    // any later planner plan containing it is rejected → computed plan stays clean
    const bundle = await computeCurrentPlan(U.id);
    expect(bundle.plan.sections.map((s) => s.component)).not.toContain("people_index");
  });

  it("remove: true deletes the preference", async () => {
    const { result } = await executeTool(ctx, "set_layout_preference", {
      kind: "ban_component",
      component: "people_index",
      remove: true,
    });
    expect((result as { removed?: boolean }).removed).toBe(true);
    const rows = await db
      .select()
      .from(layoutPreferences)
      .where(eq(layoutPreferences.userId, U.id));
    expect(rows).toHaveLength(0);
  });
});

describe("edit_layout_plan", () => {
  it("moves a section immediately (user-initiated, no rationing)", async () => {
    const { result } = await executeTool(ctx, "edit_layout_plan", {
      operations: [{ op: "move", section: "timeline", to: 0 }],
    });
    expect((result as { applied?: boolean }).applied).toBe(true);
    const head = await getPlanHead(U.id);
    expect(sectionKey((head?.spec as LayoutPlan).sections[0])).toBe("timeline");
  });

  it("refuses an edit that hides an urgent project, and changes nothing", async () => {
    const before = await getPlanHead(U.id);
    const { result } = await executeTool(ctx, "edit_layout_plan", {
      operations: [{ op: "remove", section: `project_card:${U.id}-urgent` }],
    });
    expect((result as { error?: string }).error).toMatch(/rule/i);
    const after = await getPlanHead(U.id);
    expect(after?.version).toBe(before?.version);
  });
});
