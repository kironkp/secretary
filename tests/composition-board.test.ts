// SPEC §2 "Composition" (v1.02) through the real paths, against the local
// database: the two tools that arrange the dashboard (arrange_dashboard for
// voice and taps, edit_layout_plan for the chat), the pin button, the plan the
// dashboard renders and stores, and the background planner. Made-up boards in
// the shape that broke the old rules: several late projects, a quiet few, a
// list. What he places stays where he put it; every card he did not place
// follows the data, at the next render, the cached one and the next day; and
// no tool says "applied" to something the next render does not show.
process.env.TZ = "UTC";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs, projects, tasks, usage, user } from "@/lib/db/schema";
import { defaultPlan, sectionKey, type LayoutPlan } from "@/lib/layout/plan";
import { clearPlanCache, lastPlannerUsage } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, getPlanHead, persistPlan, revertPlan, setPinned } from "@/lib/layout/plan-store";
import { REGISTRY_VERSION } from "@/lib/layout/registry";
import { computeSignals, signalsHash } from "@/lib/layout/signals";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const NAMES = ["Atlas", "Birch", "Cedar", "Dune", "Ember", "Fjord", "Grove", "Harbor", "Iris"];
const users: string[] = [];
const day = (n: number) => new Date(Date.now() + n * 86_400_000);

/** Nine projects, the first `late` of them late, the next due in three days, the rest quiet; and a list. */
async function board(late: number) {
  const id = `test-compose-${crypto.randomUUID()}`;
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
  const card = (name: string) => `project_card:${ids[name]}`;
  /** One visit to the dashboard: what renders, and the store that follows it. */
  const render = async () => {
    const bundle = await computeCurrentPlan(id);
    await persistPlan(id, bundle);
    return bundle;
  };
  const keys = async () => (await render()).plan.sections.map(sectionKey);
  /** The cards in the default order for his data now, as keys. */
  const byData = async () => defaultPlan(await computeSignals(id)).sections.filter((s) => s.component === "project_card").map(sectionKey);
  const cardsOf = (k: string[]) => k.filter((x) => x.startsWith("project_card:"));
  return {
    id,
    ids,
    card,
    add,
    render,
    keys,
    byData,
    cardsOf,
    arrange: (operations: { op: string; section: string }[]) => executeTool(ctx, "arrange_dashboard", { operations }),
    chatEdit: (operations: Record<string, unknown>[]) => executeTool(ctx, "edit_layout_plan", { operations }),
    head: async () => (await getPlanHead(id))!,
    /** Something changes in his data, so the next render is a new situation. */
    newTask: (project: string, due: number | null = null) =>
      db.insert(tasks).values({ userId: id, projectId: ids[project], title: `${project}: another task ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken", dueAt: due === null ? null : day(due) }),
    /** The stored plans are a day or more old: the rationing clock has moved on. */
    nextDay: () => db.update(layoutSpecs).set({ createdAt: day(-2) }).where(eq(layoutSpecs.userId, id)),
    archive: (project: string) => db.update(projects).set({ status: "archived" }).where(eq(projects.id, ids[project])),
  };
}
type Board = Awaited<ReturnType<typeof board>>;
/** Everything on the board except what he placed is in the default order for the data. */
async function expectCardsFollowData(b: Board, shown: string[], placed: string[]) {
  expect(b.cardsOf(shown).filter((k) => !placed.includes(k))).toEqual((await b.byData()).filter((k) => !placed.includes(k)));
}

beforeEach(() => clearPlanCache());
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe.each([5, 6, 9])("a board with %i late projects", (late) => {
  const tools: [string, (b: Board) => Promise<unknown>, (b: Board) => string][] = [
    ["arrange_dashboard: the shopping list to the top", (b) => b.arrange([{ op: "move_to_top", section: "shopping list" }]), (b) => b.card("Shopping")],
    ["arrange_dashboard: needs a date to the top", (b) => b.arrange([{ op: "move_to_top", section: "needs a date" }]), () => "date_chase"],
    ["edit_layout_plan: the shopping list to the top", (b) => b.chatEdit([{ op: "move", section: b.card("Shopping"), to: 0 }]), (b) => b.card("Shopping")],
    ["edit_layout_plan: needs a date to the top", (b) => b.chatEdit([{ op: "move", section: "date_chase", to: 0 }]), () => "date_chase"],
  ];

  it.each(tools)("%s: applied, pinned, and it stays through new data, the next day and a project going late", async (_what, act, keyOf) => {
    const b = await board(late);
    await b.render();
    const { result } = (await act(b)) as { result: Record<string, unknown> };
    expect(result).toMatchObject({ applied: true });
    const key = keyOf(b);
    expect((await b.head()).pinned).toContain(key);

    // The next render (served from what the tool stored), then again from the cache.
    for (let i = 0; i < 2; i++) {
      const shown = await b.keys();
      expect(shown[0]).toBe(key);
      await expectCardsFollowData(b, shown, [key]);
    }
    // New data.
    await b.newTask("Atlas");
    expect((await b.keys())[0]).toBe(key);
    // The next day, and a project that was quiet goes late: it takes its place by the data.
    await b.nextDay();
    const quiet = late < 8 ? "Iris" : "Juniper";
    if (quiet === "Juniper") await b.add("Juniper", null);
    await b.newTask(quiet, -40);
    const after = await b.keys();
    expect(after[0]).toBe(key);
    await expectCardsFollowData(b, after, [key]);
    expect(b.cardsOf(after).filter((k) => k !== key)[0]).toBe(b.card(quiet));
    // And the next render of the same situation is the same board, with nothing new stored.
    const again = await b.render();
    expect(again.plan.sections.map(sectionKey)).toEqual(after);
    expect(again.changed).toBe(false);
  });

  it("hiding a card that is urgent now is refused by both tools, and changes nothing", async () => {
    const b = await board(late);
    await b.render();
    const before = (await b.head()).version;
    expect(((await b.arrange([{ op: "hide", section: "Atlas" }])).result as { error?: string }).error).toMatch(/urgent project "Atlas" \(2d late\) would have no card/);
    expect(((await b.chatEdit([{ op: "remove", section: b.card("Atlas") }])).result as { error?: string }).error).toMatch(/urgent project "Atlas" \(2d late\) would have no card/);
    expect((await b.head()).version).toBe(before);
    expect(await db.select().from(layoutPreferences).where(eq(layoutPreferences.userId, b.id))).toHaveLength(0);
  });
});

describe("on a board he has not arranged, the cards follow the data at every render", () => {
  it("a date edited into the past, a late date moved into next month, a project made, a project archived", async () => {
    const b = await board(2);
    await expectCardsFollowData(b, await b.keys(), []);
    await expectCardsFollowData(b, await b.keys(), []); // served from the stored plan
    // Iris has one undated task; it is set to nine days ago. Nothing is added or finished.
    await db.update(tasks).set({ dueAt: day(-9) }).where(and(eq(tasks.userId, b.id), eq(tasks.projectId, b.ids.Iris)));
    const late = await b.keys();
    await expectCardsFollowData(b, late, []);
    expect(b.cardsOf(late)[0]).toBe(b.card("Iris"));
    // Atlas (2 days late) is rescheduled to 30 days out.
    await db.update(tasks).set({ dueAt: day(30) }).where(and(eq(tasks.userId, b.id), eq(tasks.projectId, b.ids.Atlas)));
    await expectCardsFollowData(b, await b.keys(), []);
    await b.nextDay();
    await b.add("Juniper", null);
    const made = await b.keys();
    expect(made).toContain(b.card("Juniper"));
    await expectCardsFollowData(b, made, []);
    await b.archive("Birch");
    const archived = await b.keys();
    expect(archived).not.toContain(b.card("Birch"));
    await expectCardsFollowData(b, archived, []);
  });

  it("D1: also when the stored plan is served from the cache, which a date edited into the past does not always miss", async () => {
    const b = await board(2);
    await b.render();
    await db.update(tasks).set({ dueAt: day(-9) }).where(and(eq(tasks.userId, b.id), eq(tasks.projectId, b.ids.Iris)));
    // The stored plan is stamped for exactly these signals, as it is when the hash does not see the change.
    const head = await b.head();
    await db.update(layoutSpecs).set({ signalsHash: signalsHash(await computeSignals(b.id), REGISTRY_VERSION) }).where(eq(layoutSpecs.id, head.id));
    const bundle = await computeCurrentPlan(b.id);
    expect(bundle.wantsLlmRefinement).toBe(false); // the cache branch
    const shown = bundle.plan.sections.map(sectionKey);
    await expectCardsFollowData(b, shown, []);
    expect(b.cardsOf(shown)[0]).toBe(b.card("Iris"));
  });

  it("with a stored planner plan: its cards are ignored from the first render, and it is not what renders once the data has moved on", async () => {
    const b = await board(3);
    const signals = await computeSignals(b.id);
    const base = defaultPlan(signals);
    const others = base.sections.filter((s) => s.component !== "project_card");
    const own = base.sections.filter((s) => s.component === "project_card").toReversed();
    const stored: LayoutPlan = { plan_id: "plan-old", reason_summary: "A busy week", sections: [{ component: "focus_banner", props: { text: "Atlas is due today", tone: "serious" } }, ...others.slice(0, 3), ...own, ...others.slice(3)] };
    await db.insert(layoutSpecs).values({ userId: b.id, version: 1, spec: stored, pinned: [], kind: "plan", signalsHash: "an-older-situation", reasonSummary: stored.reason_summary, outcome: "accepted", createdAt: day(-3) });
    const first = await b.render();
    await expectCardsFollowData(b, first.plan.sections.map(sectionKey), []);
    // A banner written for another day's signals is not shown: the rules plan is today's.
    expect(first.plan.sections.map(sectionKey)).not.toContain("focus_banner");
    await b.newTask("Iris", -40);
    await expectCardsFollowData(b, await b.keys(), []);
  });

  it("D3: one change in his data is at most one planner call, and a re-sort does not reset the rationing clock", async () => {
    const b = await board(3);
    await b.render();
    await b.nextDay();
    let calls = 0;
    const planner = (signals: Parameters<typeof defaultPlan>[0]) => async () => {
      calls++;
      lastPlannerUsage.model = "claude-sonnet-5";
      lastPlannerUsage.input = 4_000;
      lastPlannerUsage.output = 800;
      return JSON.stringify(defaultPlan(signals));
    };
    // One change: a quiet project goes late, so the cards re-sort.
    await b.newTask("Iris", -40);
    for (let i = 0; i < 3; i++) {
      const bundle = await computeCurrentPlan(b.id);
      await persistPlan(b.id, bundle, { call: planner(bundle.signals) });
      expect(bundle.signals.context.days_since_layout_change).toBeGreaterThanOrEqual(1);
    }
    expect(calls).toBe(1);
    expect(await db.select().from(usage).where(and(eq(usage.userId, b.id), eq(usage.kind, "layout")))).toHaveLength(1);
  });
});

describe("a planner answer cannot undo what he placed", () => {
  it("the planner sends the list back to the bottom: the list stays on top, the answer is used for emphasis and recorded in usage", async () => {
    const b = await board(5);
    await b.render();
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    await b.nextDay();
    await b.newTask("Atlas");
    const bundle = await computeCurrentPlan(b.id);
    let calls = 0;
    const planner = async () => {
      calls++;
      lastPlannerUsage.model = "claude-sonnet-5";
      lastPlannerUsage.input = 4_000;
      lastPlannerUsage.output = 800;
      const plan = defaultPlan(bundle.signals);
      return JSON.stringify({ ...plan, plan_id: "tidy", reason_summary: "Tidier this way", sections: plan.sections.map((s) => (s.props?.project_id === b.ids.Iris ? { ...s, props: { ...s.props, variant: "compact" }, why: "Nothing due" } : s)) });
    };
    await persistPlan(b.id, bundle, { call: planner });
    expect(calls).toBe(1);
    const shown = (await b.render()).plan;
    expect(sectionKey(shown.sections[0])).toBe(b.card("Shopping"));
    expect(shown.plan_id).toMatch(/^llm-/);
    expect(shown.sections.find((s) => s.props?.project_id === b.ids.Iris)).toMatchObject({ props: { variant: "compact" }, why: "Nothing due" });
    await expectCardsFollowData(b, shown.sections.map(sectionKey), [b.card("Shopping")]);
    expect(await db.select().from(usage).where(and(eq(usage.userId, b.id), eq(usage.kind, "layout")))).toHaveLength(1);
  });
});

describe("on a board with one section he placed, everything else still follows the data", () => {
  it("case 1: a project he makes afterwards with nothing due has a card at once, and the next day, in its place by the data", async () => {
    const b = await board(5);
    await b.render();
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    await b.add("Juniper", null);
    const now = await b.keys();
    expect(now.filter((k) => k === b.card("Juniper"))).toHaveLength(1);
    await expectCardsFollowData(b, now, [b.card("Shopping")]);
    await b.nextDay();
    await b.newTask("Atlas");
    const later = await b.keys();
    expect(later[0]).toBe(b.card("Shopping"));
    expect(later).toContain(b.card("Juniper"));
    await expectCardsFollowData(b, later, [b.card("Shopping")]);
  });

  it("case 2: a project he archives loses its card, placed or not", async () => {
    const b = await board(5);
    await b.render();
    await b.arrange([{ op: "move_to_bottom", section: "Iris" }]);
    expect((await b.keys()).at(-1)).toBe(b.card("Iris"));
    await b.archive("Grove");
    const shown = await b.keys();
    expect(shown).not.toContain(b.card("Grove"));
    expect(shown.at(-1)).toBe(b.card("Iris"));
    await b.archive("Iris");
    expect(await b.keys()).not.toContain(b.card("Iris"));
  });

  it("case 3: show does not pin. A card he hid and showed again comes back in its place by the data", async () => {
    const b = await board(5);
    await b.render();
    expect((await b.arrange([{ op: "hide", section: "Iris" }])).result).toMatchObject({ applied: true });
    expect(await b.keys()).not.toContain(b.card("Iris"));
    expect((await b.arrange([{ op: "show", section: "Iris" }])).result).toMatchObject({ applied: true });
    expect((await b.head()).pinned).not.toContain(b.card("Iris"));
    const shown = await b.keys();
    expect(shown).toContain(b.card("Iris"));
    await expectCardsFollowData(b, shown, []);
    // The data moves it like any other card.
    await b.newTask("Iris", -40);
    expect(b.cardsOf(await b.keys())[0]).toBe(b.card("Iris"));
  });

  it("a card he hid is back while its project is late, in its place by the data, with a why; and hidden again when it is not", async () => {
    const b = await board(5);
    await b.render();
    await b.arrange([{ op: "hide", section: "Iris" }]);
    const [late] = await b.newTask("Iris", -1).returning();
    const bundle = await b.render();
    const shown = bundle.plan.sections.map(sectionKey);
    expect(shown.filter((k) => k === b.card("Iris"))).toHaveLength(1);
    await expectCardsFollowData(b, shown, []);
    expect(bundle.plan.sections.find((s) => s.props?.project_id === b.ids.Iris)?.why).toBe("Back on your board: it has late work");
    expect(await b.keys()).toContain(b.card("Iris")); // and from the cache
    await db.update(tasks).set({ status: "done", completedAt: new Date() }).where(eq(tasks.id, late.id));
    expect(await b.keys()).not.toContain(b.card("Iris"));
  });

  it("calm mode: the default with no rule's emphasis; what he placed and hid still holds, and a move made meanwhile shows", async () => {
    const b = await board(5);
    expect((await b.render()).plan.sections.some((s) => s.props?.accent === true)).toBe(true); // rule 1 fires on this board
    await b.arrange([{ op: "move_to_top", section: "shopping list" }, { op: "hide", section: "stats" }]);
    await db.update(user).set({ calmMode: true }).where(eq(user.id, b.id));
    const bundle = await b.render();
    const shown = bundle.plan.sections.map(sectionKey);
    expect(bundle.signals.context.calm_mode).toBe(true);
    expect(bundle.plan.sections.some((s) => s.why || s.props?.accent === true)).toBe(false);
    expect(shown[0]).toBe(b.card("Shopping"));
    expect(shown).not.toContain("stat_row");
    await expectCardsFollowData(b, shown, [b.card("Shopping")]);
    expect((await b.arrange([{ op: "move_to_bottom", section: "Atlas" }])).result).toMatchObject({ applied: true });
    expect((await b.keys()).at(-1)).toBe(b.card("Atlas"));
  });

  it("moving again what he already placed: it goes where the latest move put it, with either tool", async () => {
    const b = await board(3);
    await b.render();
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    await b.arrange([{ op: "move_to_bottom", section: "shopping list" }]);
    expect((await b.keys()).at(-1)).toBe(b.card("Shopping"));
    await b.chatEdit([{ op: "move", section: b.card("Shopping"), to: 2 }]);
    expect((await b.keys())[2]).toBe(b.card("Shopping"));
    await b.arrange([{ op: "move_up", section: "shopping list" }]);
    expect((await b.keys())[1]).toBe(b.card("Shopping"));
    await b.add("Juniper", null);
    expect((await b.keys())[1]).toBe(b.card("Shopping"));
    expect((await b.head()).pinned).toEqual([b.card("Shopping")]);
  });

  it("Undo of a move takes the pin with it: the list is back among the cards, last, and stays last when a project is made", async () => {
    const b = await board(5);
    const before = await b.keys();
    await setPinned(b.id, "stat_row", true); // a pin he made before the move survives the Undo
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    expect((await b.keys())[0]).toBe(b.card("Shopping"));
    expect(await revertPlan(b.id)).toBe(true);
    expect((await b.head()).pinned).toEqual(["stat_row"]);
    expect(await b.keys()).toEqual(before);
    await b.add("Juniper", null);
    const shown = await b.keys();
    await expectCardsFollowData(b, shown, []);
    expect(b.cardsOf(shown).at(-1)).toBe(b.card("Shopping"));
  });

  it("the pin button: a card pinned where it stands holds that place while the others re-sort; unpinned, it follows the data again", async () => {
    const b = await board(5);
    const before = await b.keys();
    const key = b.card("Grove");
    const at = before.indexOf(key);
    expect(await setPinned(b.id, key, true)).toBe(true);
    await b.render();
    await b.newTask("Iris", -40); // goes to the top of the cards, pushing the others down
    const shown = await b.keys();
    expect(shown[at]).toBe(key);
    await expectCardsFollowData(b, shown, [key]);
    await setPinned(b.id, key, false);
    await expectCardsFollowData(b, await b.keys(), []);
  });
});

// No tool answers "applied" to something the next render does not show.
describe("every operation of both tools is on the board at the next render", () => {
  const firstCardAt = (k: string[]) => k.findIndex((x) => x.startsWith("project_card:"));

  it("two things sent to the same place: the later one takes it, the earlier one sits next to it, through new data", async () => {
    const b = await board(3);
    await b.render();
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    await b.arrange([{ op: "move_to_top", section: "needs a date" }]);
    await b.arrange([{ op: "move_to_bottom", section: "Grove" }]);
    await b.chatEdit([{ op: "move", section: b.card("Harbor"), to: 99 }]);
    for (const change of [null, "Iris"]) {
      if (change) {
        await b.nextDay();
        await b.newTask(change, -40);
        await b.add("Juniper", null); // one section more on the board: last is still last
      }
      const shown = await b.keys();
      expect(shown.slice(0, 2)).toEqual(["date_chase", b.card("Shopping")]);
      expect(shown.slice(-2)).toEqual([b.card("Grove"), b.card("Harbor")]);
      await expectCardsFollowData(b, shown, [b.card("Shopping"), b.card("Grove"), b.card("Harbor")]);
    }
  });

  it("arrange_dashboard: to the top, up, down, to the bottom, hide, show", async () => {
    const b = await board(3);
    const start = await b.keys();
    const strip = start.indexOf("timeline");

    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    expect((await b.keys())[0]).toBe(b.card("Shopping"));

    // "Needs a date" up one: it sits inside the card run, one card below it.
    const chase = (await b.keys()).indexOf("date_chase");
    await b.arrange([{ op: "move_up", section: "needs a date" }]);
    const up = await b.keys();
    expect(up[chase - 1]).toBe("date_chase");
    expect(up[chase]).toMatch(/^project_card:/);

    // The strip down one: it sits after the first card.
    await b.arrange([{ op: "move_down", section: "progress" }]);
    const down = await b.keys();
    expect(down[down.indexOf("timeline") - 1]).toMatch(/^project_card:/);
    expect(down.indexOf("timeline")).toBe(strip + 2); // one place down, and the list above it all

    await b.arrange([{ op: "move_to_bottom", section: "Grove" }]);
    expect((await b.keys()).at(-1)).toBe(b.card("Grove"));

    await b.arrange([{ op: "hide", section: "stats" }]);
    expect(await b.keys()).not.toContain("stat_row");
    await b.arrange([{ op: "show", section: "stats" }]);
    expect(await b.keys()).toContain("stat_row");

    // All of it holds the next day, with new data.
    await b.nextDay();
    await b.newTask("Iris", -40);
    const later = await b.keys();
    expect(later[0]).toBe(b.card("Shopping"));
    expect(later.at(-1)).toBe(b.card("Grove"));
    expect(later[chase - 1]).toBe("date_chase");
    await expectCardsFollowData(b, later, [b.card("Shopping"), b.card("Grove")]);
  });

  it("edit_layout_plan: move, remove a card, remove another section, add, set_props", async () => {
    const b = await board(3);
    const start = await b.keys();
    const first = firstCardAt(start);

    // The first card moved up one: it sits between the tiles and the strip.
    const top = start[first];
    expect((await b.chatEdit([{ op: "move", section: top, to: first - 1 }])).result).toMatchObject({ applied: true });
    const moved = await b.keys();
    expect(moved[first - 1]).toBe(top);
    expect(moved[first]).toBe("timeline");
    expect((await b.head()).pinned).toContain(top);

    // remove on a card is a hide: it is gone now, the next day, and "show" brings it back.
    const removed = (await b.chatEdit([{ op: "remove", section: b.card("Iris") }])).result as Record<string, unknown>;
    expect(removed).toMatchObject({ applied: true, hidden: [b.card("Iris")] });
    expect(await b.keys()).not.toContain(b.card("Iris"));
    // remove on a section that is not a card is a hide too.
    expect((await b.chatEdit([{ op: "remove", section: "people_index" }])).result).toMatchObject({ applied: true });
    expect(await b.keys()).not.toContain("people_index");
    expect(await db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, b.id), eq(layoutPreferences.kind, "hide_section")))).toHaveLength(2);

    // add: a placed section, kept though no system plan has it.
    expect((await b.chatEdit([{ op: "add", component: "kanban", at: 1 }])).result).toMatchObject({ applied: true });
    expect((await b.keys())[1]).toBe("kanban");
    expect((await b.head()).pinned).toContain("kanban");
    // Nor is one that is on the board already: it is refused, and nothing is stored.
    const versionBefore = (await b.head()).version;
    expect(((await b.chatEdit([{ op: "add", component: "timeline" }])).result as { error?: string }).error).toMatch(/already on the dashboard/);
    expect((await b.head()).version).toBe(versionBefore);
    // An unknown component is not "applied".
    expect(((await b.chatEdit([{ op: "add", component: "no_such_thing" }])).result as { error?: string }).error).toMatch(/no "no_such_thing"/);

    // set_props: on the board at the next render, and the tool says it is not a lasting setting.
    const sized = (await b.chatEdit([{ op: "set_props", section: b.card("Grove"), props: { variant: "compact" } }])).result as Record<string, unknown>;
    expect(sized.applied).toBe(true);
    expect(String(sized.size_note)).toMatch(/until the user's data next changes/);
    expect((await b.render()).plan.sections.find((s) => s.props?.project_id === b.ids.Grove)?.props?.variant).toBe("compact");

    // The next day, with new data: the move, the hides and the add all stand.
    await b.nextDay();
    await b.newTask("Atlas");
    const later = await b.keys();
    // A place is counted from the top: the card is still third, the added section second.
    expect(later[first - 1]).toBe(top);
    expect(later[1]).toBe("kanban");
    expect(later).not.toContain(b.card("Iris"));
    expect(later).not.toContain("people_index");
    await b.arrange([{ op: "show", section: "Iris" }]);
    expect(await b.keys()).toContain(b.card("Iris"));
  });
});
