// SPEC §3 invariant 4 (v1.02) through the real paths, against the local
// database: the arrange tool the voice and the chat use, the plan the
// dashboard renders, and the background planner. A made-up board in the shape
// that broke the old rule: several late projects, a quiet few, a list.
// "Put the shopping list at the top" was refused at five urgent projects, and
// at six the default itself was. Now the request is applied, the board the
// user arranged is what renders the next time and the next day, a planner
// answer cannot undo it, and a project that goes late afterwards gets its
// card without the arrangement being lost.
process.env.TZ = "UTC";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs, projects, tasks, usage, user } from "@/lib/db/schema";
import { defaultPlan, isUrgent, sectionKey, type LayoutPlan } from "@/lib/layout/plan";
import { clearPlanCache, lastPlannerUsage } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, getPlanHead, persistPlan } from "@/lib/layout/plan-store";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const NAMES = ["Atlas", "Birch", "Cedar", "Dune", "Ember", "Fjord", "Grove", "Harbor", "Iris"];
const users: string[] = [];
const day = (n: number) => new Date(Date.now() + n * 86_400_000);

/** Nine projects, the first `late` of them late, the next due in three days, the rest quiet; and a list. */
async function board(late: number) {
  const id = `test-inv4-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Board", email: `${id}@v102.test`, timezone: TZ });
  const ids: Record<string, string> = {};
  const add = async (name: string, due: number | null, kind: "project" | "list" = "project") => {
    const [p] = await db.insert(projects).values({ userId: id, name, kind, status: "active" }).returning();
    ids[name] = p.id;
    await db.insert(tasks).values({ userId: id, projectId: p.id, title: `${name}: a task`, status: "todo", source: "spoken", dueAt: due === null ? null : day(due) });
  };
  for (const [i, name] of NAMES.entries()) await add(name, i < late ? -(i + 2) : i === late ? 3 : null);
  await add("Shopping", null, "list");
  const ctx = liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 });
  const arrange = (operations: { op: string; section: string }[]) => executeTool(ctx, "arrange_dashboard", { operations });
  const head = async () => ((await getPlanHead(id))!.spec as LayoutPlan).sections.map(sectionKey);
  const rendered = async () => (await computeCurrentPlan(id)).plan;
  /** Something changes in his data, so the next render is a new situation. */
  const newTask = (project: string, due: number | null = null) =>
    db.insert(tasks).values({ userId: id, projectId: ids[project], title: `${project}: another task ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken", dueAt: due === null ? null : day(due) });
  return { id, ids, add, arrange, head, rendered, newTask, card: (name: string) => `project_card:${ids[name]}` };
}

beforeEach(() => clearPlanCache());
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe.each([5, 6, 9])("a board with %i late projects", (late) => {
  it('"put the shopping list at the top" is applied', async () => {
    const b = await board(late);
    const { result } = await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    expect(result).toMatchObject({ applied: true });
    expect((result as { order: string[] }).order[0]).toBe("Shopping list");
    expect((await b.head())[0]).toBe(b.card("Shopping"));
  });

  it('"move needs a date to the top" is applied', async () => {
    const b = await board(late);
    const { result } = await b.arrange([{ op: "move_to_top", section: "needs a date" }]);
    expect(result).toMatchObject({ applied: true });
    expect((await b.head())[0]).toBe("date_chase");
  });

  it("the board he arranged is what renders after his data changes, and again the next day", async () => {
    const b = await board(late);
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    const arranged = await b.head();

    await b.newTask("Atlas");
    expect((await b.rendered()).sections.map(sectionKey)).toEqual(arranged);

    // The next day: yesterday's layout change is a day old, and something else is new.
    await db.update(layoutSpecs).set({ createdAt: day(-2) }).where(eq(layoutSpecs.userId, b.id));
    await b.newTask("Birch");
    const plan = await b.rendered();
    expect(plan.sections.map(sectionKey)).toEqual(arranged);
    expect(plan.sections[0]).toMatchObject({ component: "project_card", props: { project_id: b.ids.Shopping } });
  });

  it("a planner answer does not undo his move, and is recorded in usage", async () => {
    const b = await board(late);
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    const arranged = await b.head();
    await db.update(layoutSpecs).set({ createdAt: day(-2) }).where(eq(layoutSpecs.userId, b.id));
    await b.newTask("Atlas");

    const bundle = await computeCurrentPlan(b.id);
    let calls = 0;
    // The planner answers with the default order (the list back at the bottom), a why on every section.
    const planner = async () => {
      calls++;
      lastPlannerUsage.model = "claude-sonnet-5";
      lastPlannerUsage.input = 4_000;
      lastPlannerUsage.output = 800;
      const plan = defaultPlan(bundle.signals);
      return JSON.stringify({ ...plan, plan_id: "tidy", sections: plan.sections.map((s) => ({ ...s, why: "Tidier this way" })) });
    };
    await persistPlan(b.id, bundle, { call: planner });
    expect(calls).toBe(1);
    expect(await b.head()).toEqual(arranged);
    expect((await b.rendered()).sections.map(sectionKey)).toEqual(arranged);
    const billed = await db.select().from(usage).where(and(eq(usage.userId, b.id), eq(usage.kind, "layout")));
    expect(billed).toHaveLength(1);
    expect(billed[0]).toMatchObject({ model: "claude-sonnet-5", inputTokens: 4_000, outputTokens: 800 });
  });

  it("a new project that goes late gets its card after the last urgent one, with a why; nothing else moves", async () => {
    const b = await board(late);
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    const arranged = await b.head();

    await b.add("Juniper", -2);
    const bundle = await computeCurrentPlan(b.id);
    const keys = bundle.plan.sections.map(sectionKey);
    expect(keys.filter((k) => k === b.card("Juniper"))).toHaveLength(1);
    expect(keys.filter((k) => k !== b.card("Juniper"))).toEqual(arranged);
    // Just after the last urgent card that was already on his board.
    const urgentKeys = new Set(bundle.signals.projects.filter(isUrgent).map((p) => `project_card:${p.id}`));
    const lastStanding = Math.max(...arranged.map((k, i) => (urgentKeys.has(k) ? i : -1)));
    expect(keys[lastStanding + 1]).toBe(b.card("Juniper"));
    expect(bundle.plan.sections[lastStanding + 1].why).toBe("Back on your board: it has late work");

    // Stored, and stable: the next render is the same board and writes nothing new.
    await persistPlan(b.id, bundle);
    expect(await b.head()).toEqual(keys);
    const again = await computeCurrentPlan(b.id);
    expect(again.plan.sections.map(sectionKey)).toEqual(keys);
    expect(again.changed).toBe(false);
  });

  it("hiding a card that is urgent now is refused, as before, and changes nothing", async () => {
    const b = await board(late);
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    const before = await getPlanHead(b.id);
    const { result } = await b.arrange([{ op: "hide", section: "Atlas" }]);
    expect((result as { error?: string }).error).toMatch(/urgent project "Atlas" \(2d late\) would have no card/);
    expect((await getPlanHead(b.id))!.version).toBe(before!.version);
  });
});

describe("a card he hid comes back when its project goes late", () => {
  it.each([5, 6])("with %i late projects: the hidden card returns in the stated place, with a why, and his board is otherwise as he left it", async (late) => {
    const b = await board(late);
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    expect((await b.arrange([{ op: "hide", section: "Iris" }])).result).toMatchObject({ applied: true });
    const arranged = await b.head();
    expect(arranged).not.toContain(b.card("Iris"));
    expect(await db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, b.id), eq(layoutPreferences.kind, "hide_section")))).toHaveLength(1);

    // A week later one of its tasks is late.
    await db.update(layoutSpecs).set({ createdAt: day(-7) }).where(eq(layoutSpecs.userId, b.id));
    await b.newTask("Iris", -1);
    const bundle = await computeCurrentPlan(b.id);
    const keys = bundle.plan.sections.map(sectionKey);
    expect(keys.filter((k) => k === b.card("Iris"))).toHaveLength(1);
    expect(keys.filter((k) => k !== b.card("Iris"))).toEqual(arranged);
    const urgentKeys = new Set(bundle.signals.projects.filter(isUrgent).map((p) => `project_card:${p.id}`));
    const lastStanding = Math.max(...arranged.map((k, i) => (urgentKeys.has(k) ? i : -1)));
    expect(keys[lastStanding + 1]).toBe(b.card("Iris"));
    expect(bundle.plan.sections[lastStanding + 1].why).toBe("Back on your board: it has late work");

    // And it stays, render after render, while the project is late.
    await persistPlan(b.id, bundle);
    const again = await computeCurrentPlan(b.id);
    expect(again.plan.sections.map(sectionKey)).toEqual(keys);
    expect(again.changed).toBe(false);
    // Also when nothing has changed since and the stored plan is served as it
    // is (no planner of any kind): his "hide" must not take the card away again.
    await persistPlan(b.id, again);
    const served = await computeCurrentPlan(b.id);
    expect(served.wantsLlmRefinement).toBe(false);
    expect(served.plan.sections.map(sectionKey)).toEqual(keys);
    expect(served.changed).toBe(false);
  });
});
