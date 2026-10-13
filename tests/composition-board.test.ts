// SPEC §2 "Composition" (v1.02) through the real paths, against the local
// database: the two tools that arrange the dashboard (arrange_dashboard for
// voice and taps, edit_layout_plan for the chat), the pin button, the plan the
// dashboard renders and stores, and the background planner. Made-up boards in
// the shape that broke the old rules: several late projects, a quiet few, a
// list. What he places stays where he put it; every card he did not place
// follows the data, at the next render, the cached one and the next day; and
// no tool says "applied" to something the next render does not show.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, layoutPreferences, layoutSpecs, messages, projects, tasks, usage, user } from "@/lib/db/schema";
import { defaultPlan, sectionKey, type LayoutPlan } from "@/lib/layout/plan";
import { clearPlanCache, lastPlannerUsage, planWithFallback } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, getPlanHead, persistPlan } from "@/lib/layout/plan-store";
import { nameOfKey } from "@/lib/layout/names";
import { requestBoard } from "@/lib/layout/request";
import { REGISTRY_VERSION } from "@/lib/layout/registry";
import { computeSignals, signalsHash } from "@/lib/layout/signals";
import { buildBriefing } from "@/lib/secretary/briefing";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

/** The pin button: on, the section is his where it stands; off, it goes where the system has it. */
const pin = async (userId: string, key: string, on: boolean) => (await requestBoard(userId, { ops: [{ op: on ? "pin" : "unpin", key }] })).ok;
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
    /** What the model reads when it asks for the board. */
    readPlan: async () => (await executeTool(ctx, "get_current_plan", {})).result as { sections: { position: number; key: string }[]; pinned: string[] },
    /** The planner answers this render's situation with the default plus a banner, and its answer is stored. */
    landBanner: async () => {
      const bundle = await computeCurrentPlan(id);
      await persistPlan(id, bundle, {
        call: async () => {
          lastPlannerUsage.model = "claude-sonnet-5";
          lastPlannerUsage.input = 4_000;
          lastPlannerUsage.output = 800;
          const plan = defaultPlan(bundle.signals);
          return JSON.stringify({ ...plan, plan_id: "p", reason_summary: "A busy week", sections: [{ component: "focus_banner", props: { text: "Five things are late", tone: "serious" } }, ...plan.sections] });
        },
      });
      return bundle.plan.sections.map(sectionKey);
    },
    head: async () => (await getPlanHead(id))!,
    /** Something changes in his data, so the next render is a new situation. */
    newTask: (project: string, due: number | null = null) =>
      db.insert(tasks).values({ userId: id, projectId: ids[project], title: `${project}: another task ${crypto.randomUUID().slice(0, 4)}`, status: "todo", source: "spoken", dueAt: due === null ? null : day(due) }),
    /** The stored plans are a day or more old: the rationing clock has moved on. */
    nextDay: () => db.update(layoutSpecs).set({ createdAt: day(-2) }).where(eq(layoutSpecs.userId, id)),
    archive: (project: string) => db.update(projects).set({ status: "archived" }).where(eq(projects.id, ids[project])),
    /** He says the same thing several times today (a question about dates makes rule 3 fire). */
    say: async (text: string, times: number) => {
      const [conv] = await db.insert(conversations).values({ userId: id, mode: "text" }).returning();
      await db.insert(messages).values(Array.from({ length: times }, (_, i) => ({ userId: id, conversationId: conv.id, role: "user" as const, content: `${text} (${i})`, mode: "text" as const })));
    },
    /** What he said is days old now. */
    talkStops: () => db.update(messages).set({ createdAt: day(-3) }).where(eq(messages.userId, id)),
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
    await pin(b.id, "stat_row", true); // a pin he made before the move survives the Undo
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    expect((await b.keys())[0]).toBe(b.card("Shopping"));
    expect((await requestBoard(b.id, { revert: true })).ok).toBe(true);
    expect((await b.head()).pinned).toEqual(["stat_row"]);
    expect(await b.keys()).toEqual(before);
    await b.add("Juniper", null);
    const shown = await b.keys();
    await expectCardsFollowData(b, shown, []);
    expect(b.cardsOf(shown).at(-1)).toBe(b.card("Shopping"));
  });

  it("a pin kept as a preference before r5: given its place at the first open, the row marked and left; taken off with the button, the card follows the data", async () => {
    // The Reviewer's first cause of "cards not by the data" on round 4: the
    // pin lived in two places. Taken off the row by the button, the
    // preference still pinned, the route said ok, and the card stayed put.
    const b = await board(5);
    const key = b.card("Grove");
    await b.render();
    const at = (await b.keys()).indexOf(key);
    await db.insert(layoutPreferences).values({ userId: b.id, kind: "pin_section", value: { section: key } });
    await b.newTask("Iris", -40); // the others re-sort around it
    const held = await b.keys();
    expect(held[at]).toBe(key);
    // One home now: the place on the board. The preference row is marked, not deleted, and not read again.
    expect((await b.head()).pinned).toEqual([key]);
    const rows = await db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, b.id), eq(layoutPreferences.kind, "pin_section")));
    expect(rows.map((r) => r.value)).toEqual([{ section: key, migrated: "1" }]);
    // Off with the button: it is off, whatever the old row says.
    expect(await pin(b.id, key, false)).toBe(true);
    expect((await b.head()).pinned).toEqual([]);
    await b.newTask("Harbor", -60);
    await expectCardsFollowData(b, await b.keys(), []);
  });

  it("a place goes with its section: a card he placed whose project is archived and brought back follows the data", async () => {
    // The Reviewer's second cause: the pin's key stayed on the row while the
    // project was away, and when it came back the card was held, from the
    // second open on, at an index he never chose.
    const b = await board(5);
    await b.render();
    await b.arrange([{ op: "move_to_top", section: "Grove" }]);
    expect((await b.keys())[0]).toBe(b.card("Grove"));
    await b.archive("Grove");
    expect(await b.keys()).not.toContain(b.card("Grove"));
    expect((await b.head()).pinned).toEqual([]); // gone for good with the first board worked out without it
    await db.update(projects).set({ status: "active" }).where(eq(projects.id, b.ids.Grove));
    for (let open = 0; open < 3; open++) {
      const shown = await b.keys();
      expect(shown).toContain(b.card("Grove"));
      expect(shown[0]).not.toBe(b.card("Grove"));
      await expectCardsFollowData(b, shown, []);
    }
    expect((await b.head()).pinned).toEqual([]);
  });

  it("the pin button: a card pinned where it stands holds that place while the others re-sort; unpinned, it follows the data again", async () => {
    const b = await board(5);
    const before = await b.keys();
    const key = b.card("Grove");
    const at = before.indexOf(key);
    expect(await pin(b.id, key, true)).toBe(true);
    await b.render();
    await b.newTask("Iris", -40); // goes to the top of the cards, pushing the others down
    const shown = await b.keys();
    expect(shown[at]).toBe(key);
    await expectCardsFollowData(b, shown, [key]);
    await pin(b.id, key, false);
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

    // All of it holds the next day, with new data: everything he placed is
    // where the board he was last told had it. (Round 3 kept a NUMBER from
    // the top, so "Needs a date" stayed at the index it had before the
    // later requests. A place is read again from the board after every
    // request now: it is where he last saw it.)
    const told = await b.keys();
    await b.nextDay();
    await b.newTask("Iris", -40);
    const later = await b.keys();
    expect(later[0]).toBe(b.card("Shopping"));
    expect(later.at(-1)).toBe(b.card("Grove"));
    for (const key of [b.card("Shopping"), b.card("Grove"), "date_chase", "timeline"]) expect(later.indexOf(key), key).toBe(told.indexOf(key));
    expect(later).toHaveLength(told.length);
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

    // The next day, with new data: the move, the hides and the add all stand,
    // each where the board he was last told had it (the section added at the
    // second place moved the card he had placed down by one, and that is
    // where it stays).
    const told = await b.keys();
    expect(told.indexOf(top)).toBe(first);
    await b.nextDay();
    await b.newTask("Atlas");
    const later = await b.keys();
    expect(later.indexOf(top)).toBe(told.indexOf(top));
    expect(later[1]).toBe("kanban");
    expect(later).not.toContain(b.card("Iris"));
    expect(later).not.toContain("people_index");
    await b.arrange([{ op: "show", section: "Iris" }]);
    expect(await b.keys()).toContain(b.card("Iris"));
  });
});

// r4. The held path: the rules plan is refused (a removal or a move of the
// system's own is rationed) and the stored sections are kept. In r3 his list
// pinned on top was taken there for "the first card", and the whole board
// went under the cards. These are the Reviewer's two boards.
describe("a held plan keeps his list on top and the board the right way up", () => {
  it("a planner's answer with a banner lands; at the next open: the banner, his list, the system's sections, the cards", async () => {
    const b = await board(5);
    await b.render();
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    await b.nextDay();
    await b.newTask("Atlas");
    const bundle = await computeCurrentPlan(b.id);
    await persistPlan(b.id, bundle, {
      call: async () => {
        lastPlannerUsage.model = "claude-sonnet-5";
        lastPlannerUsage.input = 4_000;
        lastPlannerUsage.output = 800;
        const plan = defaultPlan(bundle.signals);
        return JSON.stringify({ ...plan, plan_id: "p", reason_summary: "A busy week", sections: [{ component: "focus_banner", props: { text: "Five things are late", tone: "serious" } }, ...plan.sections] });
      },
    });
    expect(((await b.head()).spec as LayoutPlan).sections[0].component).toBe("focus_banner");

    // The next open, with no change in his data. The banner has just changed
    // the layout, so taking it away is rationed and the stored plan is held.
    for (let open = 0; open < 2; open++) {
      const shown = await b.keys();
      expect(shown.slice(0, 5)).toEqual(["focus_banner", b.card("Shopping"), "hero_next_up", "stat_row", "timeline"]);
      expect(shown.slice(-2)).toEqual(["date_chase", "people_index"]);
      expect(b.cardsOf(shown.slice(5, -2))).toHaveLength(9);
      await expectCardsFollowData(b, shown, [b.card("Shopping")]);
    }
    // And with a project going late meanwhile.
    await b.newTask("Iris", -40);
    const later = await b.keys();
    expect(later.slice(0, 6)).toEqual(["focus_banner", b.card("Shopping"), "hero_next_up", "stat_row", "timeline", b.card("Iris")]);
  });

  it("rule 3 sent the strip up, under his list; the talk stops: the strip stays (a stated limit), and nothing is turned over", async () => {
    const b = await board(5);
    await b.render();
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    await b.nextDay();
    await b.say("when is the deadline?", 4);
    const talking = await b.keys();
    expect(talking.slice(0, 4)).toEqual([b.card("Shopping"), "timeline", "hero_next_up", "stat_row"]);

    await b.talkStops();
    await b.nextDay();
    for (let open = 0; open < 2; open++) {
      const shown = await b.keys();
      expect(shown.slice(0, 4)).toEqual([b.card("Shopping"), "timeline", "hero_next_up", "stat_row"]);
      expect(shown.slice(-2)).toEqual(["date_chase", "people_index"]);
      await expectCardsFollowData(b, shown, [b.card("Shopping")]);
    }
  });

  it("the same two held boards with the first card moved up and Needs a date moved into the cards", async () => {
    const b = await board(5);
    const start = await b.keys();
    const firstCard = start.find((k) => k.startsWith("project_card:"))!;
    await b.chatEdit([{ op: "move", section: firstCard, to: start.indexOf(firstCard) - 1 }]);
    await b.arrange([{ op: "move_up", section: "needs a date" }]);
    const arranged = await b.keys();
    await b.nextDay();
    await b.say("when is the deadline?", 4);
    await b.keys();
    await b.talkStops();
    await b.nextDay();
    const held = await b.keys();
    // The strip went up and stays; his two sections are at their places; the rest is as he arranged it.
    expect(held.indexOf(firstCard)).toBe(arranged.indexOf(firstCard));
    expect(held.indexOf("date_chase")).toBe(arranged.indexOf("date_chase"));
    expect(held[0]).toBe("timeline");
    await expectCardsFollowData(b, held, [firstCard]);
    expect(held.filter((k) => !k.startsWith("project_card:") && k !== "date_chase")).toEqual(["timeline", "hero_next_up", "stat_row", "people_index"]);
  });
});

// r4. The cache is keyed by days_left, which ticks at the hour a task is due;
// the chip counts calendar days, which tick at midnight. A plan stored in the
// evening was served the next morning still saying "Due tomorrow".
describe("the chip under a deadline is today's from the cache too, and costs no planner call", () => {
  afterEach(() => vi.useRealTimers());

  it("21:54, due 17:00 tomorrow; 09:00 the next morning, nothing else changed; 17:01, it is late", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T04:54:00Z")); // Oct 20, 21:54 in Los Angeles
    const id = `test-compose-${crypto.randomUUID()}`;
    users.push(id);
    await db.insert(user).values({ id, name: "Board", email: `${id}@v102.test`, timezone: TZ });
    const [report] = await db.insert(projects).values({ userId: id, name: "Report", status: "active" }).returning();
    const [quiet] = await db.insert(projects).values({ userId: id, name: "Garden", status: "active" }).returning();
    await db.insert(tasks).values({ userId: id, projectId: report.id, title: "Send the report", status: "todo", source: "spoken", dueAt: new Date("2026-10-22T00:00:00Z") }); // Oct 21, 17:00
    await db.insert(tasks).values({ userId: id, projectId: quiet.id, title: "Order seeds", status: "todo", source: "spoken" });

    let calls = 0;
    const open = async () => {
      const bundle = await computeCurrentPlan(id);
      await persistPlan(id, bundle, {
        call: async () => {
          calls++;
          lastPlannerUsage.model = "claude-sonnet-5";
          lastPlannerUsage.input = 4_000;
          lastPlannerUsage.output = 800;
          // The planner agrees with the rules, so what is stored is the rules' plan, chip and all.
          return JSON.stringify(bundle.plan);
        },
      });
      const card = bundle.plan.sections.find((s) => s.props?.project_id === report.id);
      const signal = bundle.signals.projects.find((p) => p.id === report.id)!;
      return { why: card?.why, fromCache: !bundle.wantsLlmRefinement, days_left: signal.days_left, soonest_days: signal.soonest_days, hash: signalsHash(bundle.signals, REGISTRY_VERSION) };
    };

    const evening = await open();
    expect(evening).toMatchObject({ why: "Due tomorrow", fromCache: false, days_left: 0, soonest_days: 1 });
    expect(calls).toBe(1);
    expect(await open()).toMatchObject({ why: "Due tomorrow", fromCache: true });

    vi.setSystemTime(new Date("2026-10-21T16:00:00Z")); // Oct 21, 09:00
    const morning = await open();
    // Nothing the cache is keyed by has moved: this is the stored plan, and it says today.
    expect(morning).toMatchObject({ why: "Due today", fromCache: true, days_left: 0, soonest_days: 0, hash: evening.hash });
    expect(await open()).toMatchObject({ why: "Due today", fromCache: true });
    expect(calls).toBe(1);

    vi.setSystemTime(new Date("2026-10-22T00:01:00Z")); // Oct 21, 17:01: late now, a new situation
    const late = await open();
    expect(late).toMatchObject({ fromCache: false, days_left: null, soonest_days: 0 });
    expect(late.why ?? "").not.toMatch(/^Due /);
    // One dated task, a day and a half, nothing else changing: the evening's call and this one.
    expect(calls).toBe(2);
    expect(await db.select().from(usage).where(and(eq(usage.userId, id), eq(usage.kind, "layout")))).toHaveLength(2);
  });
});

// r4. No tool says "applied" to what the next render will not show: the two
// cases that slipped past r3, and the check both tools now make before
// writing anything.
describe("what a tool says it did is on the composed board, or nothing is changed", () => {
  const hides = (userId: string) => db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, userId), eq(layoutPreferences.kind, "hide_section")));

  it("adding back a card he had hidden is a show: on the board at the next render and the next day, by the data, not pinned", async () => {
    const b = await board(3);
    await b.render();
    await b.chatEdit([{ op: "remove", section: b.card("Iris") }]);
    expect(await b.keys()).not.toContain(b.card("Iris"));
    const res = (await b.chatEdit([{ op: "add", component: "project_card", props: { project_id: b.ids.Iris }, at: 0 }])).result as Record<string, unknown>;
    expect(res).toMatchObject({ applied: true, shown: [b.card("Iris")] });
    expect(String(res.shown_note)).toMatch(/not placed/);
    expect(await hides(b.id)).toHaveLength(0);
    expect((await b.head()).pinned).not.toContain(b.card("Iris"));
    const shown = await b.keys();
    expect(shown).toContain(b.card("Iris"));
    await expectCardsFollowData(b, shown, []);
    await b.nextDay();
    await b.newTask("Atlas");
    await expectCardsFollowData(b, await b.keys(), []);
    expect(await b.keys()).toContain(b.card("Iris"));
  });

  it("adding back a section of the default board he had hidden: back where it was, not pinned; with arrange_dashboard's hide too", async () => {
    const b = await board(3);
    const start = await b.keys();
    await b.chatEdit([{ op: "remove", section: "stat_row" }]);
    await b.arrange([{ op: "hide", section: "needs a date" }]);
    expect(await hides(b.id)).toHaveLength(2);
    expect((await b.chatEdit([{ op: "add", component: "stat_row" }, { op: "add", component: "date_chase" }])).result).toMatchObject({ applied: true, shown: ["stat_row", "date_chase"] });
    expect(await hides(b.id)).toHaveLength(0);
    expect((await b.head()).pinned).toEqual([]);
    expect(await b.keys()).toEqual(start);
    await b.nextDay();
    await b.newTask("Iris", -40);
    const later = await b.keys();
    expect(later.filter((k) => !k.startsWith("project_card:"))).toEqual(start.filter((k) => !k.startsWith("project_card:")));

    // A hide from before the place was recorded with it: the section still comes back at its own place, not at the end.
    await db.insert(layoutPreferences).values({ userId: b.id, kind: "hide_section", value: { section: "stat_row" } });
    expect(await b.keys()).not.toContain("stat_row");
    expect((await b.chatEdit([{ op: "add", component: "stat_row" }])).result).toMatchObject({ applied: true, shown: ["stat_row"] });
    expect((await b.keys()).filter((k) => !k.startsWith("project_card:"))).toEqual(start.filter((k) => !k.startsWith("project_card:")));
  });

  it("adding back a section the board does not have by itself: its hide is lifted and it is placed, like any add", async () => {
    const b = await board(3);
    await b.render();
    await b.chatEdit([{ op: "add", component: "kanban", at: 1 }]);
    await b.chatEdit([{ op: "remove", section: "kanban" }]);
    expect(await b.keys()).not.toContain("kanban");
    expect((await b.head()).pinned).not.toContain("kanban");
    const res = (await b.chatEdit([{ op: "add", component: "kanban", at: 2 }])).result as Record<string, unknown>;
    expect(res.applied).toBe(true);
    expect(res.shown).toBeUndefined();
    expect(await hides(b.id)).toHaveLength(0);
    expect((await b.head()).pinned).toContain("kanban");
    expect((await b.keys())[2]).toBe("kanban");
    await b.nextDay();
    await b.newTask("Iris", -40);
    expect((await b.keys())[2]).toBe("kanban");
  });

  it("a card for a project that is not on the board is not 'applied': the tool says so and stores nothing", async () => {
    const b = await board(3);
    await b.render();
    const before = (await b.head()).version;
    await b.archive("Grove");
    for (const project_id of [b.ids.Grove, "00000000-0000-4000-8000-000000000000"]) {
      const res = (await b.chatEdit([{ op: "add", component: "project_card", props: { project_id }, at: 0 }])).result as { applied?: boolean; error?: string };
      expect(res.applied).toBeUndefined();
      expect(res.error).toMatch(/has no card on the dashboard.*Nothing was changed/);
      expect(res.error).not.toMatch(/project_card:|[0-9a-f]{8}-[0-9a-f]{4}/); // by name, never by key
    }
    expect((await b.head()).version).toBe(before);
  });

  it("showing a card the board cannot have (a subproject's) is not 'applied' either: the voice tool says so and stores nothing", async () => {
    const b = await board(3);
    await b.render();
    const before = (await b.head()).version;
    await db.insert(projects).values({ userId: b.id, name: "Paperwork", status: "active", parentId: b.ids.Atlas });
    const res = (await b.arrange([{ op: "show", section: "Paperwork" }])).result as { applied?: boolean; error?: string };
    expect(res.applied).not.toBe(true);
    expect(res.error).toMatch(/Paperwork has no card on the dashboard.*Nothing was changed/);
    expect((await b.head()).version).toBe(before);
  });

  it("in one request the last word about a section wins: hidden and shown again is shown, at its own place, and no hide is kept", async () => {
    const b = await board(3);
    const start = await b.keys();
    expect((await b.arrange([{ op: "hide", section: "stats" }, { op: "show", section: "stats" }])).result).toMatchObject({ applied: true });
    expect(await hides(b.id)).toHaveLength(0);
    expect(await b.keys()).toEqual(start);
    // Shown and then hidden is hidden.
    await b.arrange([{ op: "hide", section: "stats" }]);
    expect((await b.arrange([{ op: "show", section: "stats" }, { op: "hide", section: "stats" }])).result).toMatchObject({ applied: true });
    expect(await hides(b.id)).toHaveLength(1);
    expect(await b.keys()).not.toContain("stat_row");
  });

  it("the check itself: a request the board would not bear out changes nothing and says why, by name", async () => {
    // The claims are presence only (round 4 also demanded the exact place,
    // and refused an honest move down): what is said to be on the board is
    // on it, what is said to be off it is off. Reached through the request
    // function, since the check is no longer a function of its own.
    const b = await board(3);
    await b.render();
    const before = await b.head();
    // A card for a project that has none (a subproject, an archived one, an unknown id).
    const noCard = await requestBoard(b.id, { ops: [{ op: "show", key: "project_card:no-such-project" }] });
    expect(noCard).toMatchObject({ ok: false });
    expect(JSON.stringify(noCard)).not.toMatch(/project_card:/);
    // A component he banned cannot be brought back by a show.
    await requestBoard(b.id, { ban: "kanban" });
    const banned = await requestBoard(b.id, { ops: [{ op: "add", section: { component: "kanban" } }] });
    expect(banned).toMatchObject({ ok: false, error: expect.stringContaining("never to be shown kanban") });
    // Nothing was written by either.
    expect((await b.head()).version).toBe(before.version);
    expect(await hides(b.id)).toHaveLength(0);
  });
});

describe("with a planner that answers at every open", () => {
  it("his list on top, six opens, his data changing before the fourth: every one is the right way up", async () => {
    const b = await board(5);
    await b.render();
    await b.arrange([{ op: "move_to_top", section: "shopping list" }]);
    await b.nextDay();
    await b.newTask("Atlas");
    for (let open = 1; open <= 6; open++) {
      if (open === 4) await b.newTask("Iris", -40);
      const shown = await b.landBanner();
      const body = shown.filter((k) => k !== "focus_banner");
      expect(body.slice(0, 4), `open ${open}`).toEqual([b.card("Shopping"), "hero_next_up", "stat_row", "timeline"]);
      expect(body.slice(-2), `open ${open}`).toEqual(["date_chase", "people_index"]);
      expect(shown.indexOf("focus_banner"), `open ${open}`).toBeLessThanOrEqual(0);
      await expectCardsFollowData(b, shown, [b.card("Shopping")]);
    }
    // And a card he put between the tiles and the strip does not push the strip under the cards.
    const c = await board(5);
    const start = await c.keys();
    const firstCard = start.find((k) => k.startsWith("project_card:"))!;
    await c.chatEdit([{ op: "move", section: firstCard, to: start.indexOf("timeline") }]);
    await c.nextDay();
    await c.newTask("Atlas");
    for (let open = 1; open <= 4; open++) {
      if (open === 3) await c.newTask("Iris", -40);
      const body = (await c.landBanner()).filter((k) => k !== "focus_banner");
      expect(body.slice(0, 4), `open ${open}`).toEqual(["hero_next_up", "stat_row", firstCard, "timeline"]);
      expect(body[4], `open ${open}`).toMatch(/^project_card:/);
    }
  });
});

describe("'the top' is under the banner for both tools", () => {
  it("with a banner on the board: a card moved to position 0 in the chat, a section sent to the top by voice and a section added at 0 are each just below it, and the banner is still there", async () => {
    const b = await board(5);
    await b.render();
    await b.nextDay();
    await b.newTask("Atlas");
    await b.landBanner();
    expect((await b.keys())[0]).toBe("focus_banner");

    const moved = (await b.chatEdit([{ op: "move", section: b.card("Iris"), to: 0 }])).result as { applied?: boolean; sections: string[] };
    expect(moved.applied).toBe(true);
    expect(moved.sections.slice(0, 2)).toEqual(["focus_banner", b.card("Iris")]);
    expect((await b.keys()).slice(0, 2)).toEqual(["focus_banner", b.card("Iris")]);

    expect((await b.arrange([{ op: "move_to_top", section: "needs a date" }])).result).toMatchObject({ applied: true });
    expect((await b.keys()).slice(0, 3)).toEqual(["focus_banner", "date_chase", b.card("Iris")]);

    expect((await b.chatEdit([{ op: "add", component: "kanban", at: 0 }])).result).toMatchObject({ applied: true });
    const shown = await b.keys();
    expect(shown.slice(0, 2)).toEqual(["focus_banner", "kanban"]);
    expect(shown.filter((k) => k === "focus_banner")).toHaveLength(1);
  });
});

describe("the model is told the board as it renders now, not as it was last stored", () => {
  it("his data changes and the Dashboard is not opened: the briefing and get_current_plan have today's order, and a move by position lands where it was meant", async () => {
    const b = await board(3);
    await b.render();
    const stored = ((await b.head()).spec as LayoutPlan).sections.map(sectionKey);
    // A quiet project goes late. Nobody opens the Dashboard.
    await b.newTask("Iris", -40);
    expect(((await b.head()).spec as LayoutPlan).sections.map(sectionKey)).toEqual(stored);
    expect(b.cardsOf(stored)[0]).not.toBe(b.card("Iris"));

    const briefing = await buildBriefing(b.id, TZ, { consumeNudges: false });
    const line = briefing.text.split("\n").find((l) => l.startsWith("DASHBOARD"))!;
    const named = NAMES.filter((n) => line.includes(n)).toSorted((x, y) => line.indexOf(x) - line.indexOf(y));
    expect(named[0]).toBe("Iris");

    const plan = await b.readPlan();
    const cards = plan.sections.filter((s) => s.key.startsWith("project_card:"));
    expect(cards[0].key).toBe(b.card("Iris"));
    expect(plan.sections.map((s) => s.position)).toEqual(plan.sections.map((_, i) => i));

    // "Put Harbor above Iris": the position the model just read for Iris.
    const iris = plan.sections.find((s) => s.key === b.card("Iris"))!;
    expect((await b.chatEdit([{ op: "move", section: b.card("Harbor"), to: iris.position }])).result).toMatchObject({ applied: true });
    const shown = await b.keys();
    expect(shown.indexOf(b.card("Harbor"))).toBe(shown.indexOf(b.card("Iris")) - 1);
    expect(shown.indexOf(b.card("Harbor"))).toBe(iris.position);
  });
});

// r5. Behaviours the walk reaches only on a long run, each pinned down by an
// example after a mutant of it survived the suite's small walk.
describe("the request function, case by case", { timeout: 30_000 }, () => {
  const hideRows = (userId: string) => db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, userId), eq(layoutPreferences.kind, "hide_section")));
  const tools = (userId: string) => liveTurnContext({ userId, timezone: TZ, attachmentCount: 0 });

  it("a section he added: unpin is refused in words; hidden and shown again it is back at the end, placed, and still there the next day", async () => {
    const b = await board(3);
    await b.render();
    await b.chatEdit([{ op: "add", component: "kanban", at: 2 }]);
    const refused = await requestBoard(b.id, { ops: [{ op: "unpin", key: "kanban" }] });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("kanban stays where you put it") });
    expect((await b.head()).pinned).toContain("kanban");
    await b.arrange([{ op: "hide", section: "kanban" }]);
    expect(await b.keys()).not.toContain("kanban");
    expect((await b.arrange([{ op: "show", section: "kanban" }])).result).toMatchObject({ applied: true });
    expect((await b.keys()).at(-1)).toBe("kanban");
    expect((await b.head()).pinned).toContain("kanban");
    await b.nextDay();
    await b.newTask("Iris", -40);
    expect((await b.keys()).at(-1)).toBe("kanban");
  });

  it("the last word wins for a section he added as well: hidden and shown, or hidden and moved, in one request by voice", async () => {
    // The voice tool's own picture of the board lost the section at the hide,
    // and its list of what can be brought back did not have a section he
    // had added and hidden a moment ago: "there is no kanban on the
    // dashboard", while it was on the board.
    const b = await board(3);
    await b.render();
    await b.chatEdit([{ op: "add", component: "kanban", at: 2 }]);
    const start = await b.keys();
    expect((await b.arrange([{ op: "hide", section: "kanban" }, { op: "show", section: "kanban" }])).result).toMatchObject({ applied: true });
    const shown = await b.keys();
    expect(shown.at(-1)).toBe("kanban"); // hidden and shown again, a section he added is back at the end, placed
    expect(shown.slice(0, -1)).toEqual(start.filter((k) => k !== "kanban"));
    expect((await b.head()).pinned).toContain("kanban");
    expect(await hideRows(b.id)).toHaveLength(0);
    expect((await b.arrange([{ op: "hide", section: "kanban" }, { op: "move_to_top", section: "kanban" }])).result).toMatchObject({ applied: true });
    expect((await b.keys())[0]).toBe("kanban");
    expect(await hideRows(b.id)).toHaveLength(0);
  });

  it("a hide of a card whose project has since been archived, or deleted, can be lifted: the row goes, and the name is an honest one", async () => {
    // On 393de92 the lift asked for a show, the show was refused (the project
    // has no card) and the row stayed in Settings for good. main deletes it.
    const b = await board(3);
    await b.render();
    await b.arrange([{ op: "hide", section: "Iris" }, { op: "hide", section: "Harbor" }]);
    const before = await b.keys();
    await b.archive("Iris");
    const gone = b.card("Harbor");
    await db.delete(projects).where(eq(projects.id, b.ids.Harbor));
    const rows = await hideRows(b.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(await requestBoard(b.id, { liftPreference: row.id })).toMatchObject({ ok: true });
    expect(await hideRows(b.id)).toHaveLength(0);
    expect(await b.keys()).toEqual(before);
    // A project that is deleted has no name left to show.
    expect(nameOfKey(gone, new Map())).toBe("a project that is no longer there");
    // And a hide of a component retired since is lifted the same way.
    const [retired] = await db.insert(layoutPreferences).values({ userId: b.id, kind: "hide_section", value: { section: "open_loops" } }).returning();
    expect(await requestBoard(b.id, { liftPreference: retired.id })).toMatchObject({ ok: true });
    expect(await hideRows(b.id)).toHaveLength(0);
  });

  it("a ban works like a hide, nothing brings the section back while it stands, and lifting it brings back a section he had added, at the end", async () => {
    const b = await board(3);
    await b.render();
    await b.chatEdit([{ op: "add", component: "kanban", at: 1 }]);
    const start = await b.keys();
    await executeTool(tools(b.id), "set_layout_preference", { kind: "ban_component", component: "kanban" });
    expect(await b.keys()).toEqual(start.filter((k) => k !== "kanban"));
    expect(((await b.chatEdit([{ op: "add", component: "kanban" }])).result as { error?: string }).error).toMatch(/never to be shown kanban/);
    expect((await executeTool(tools(b.id), "set_layout_preference", { kind: "ban_component", component: "kanban", remove: true })).result).toMatchObject({ removed: true });
    const back = await b.keys();
    expect(back.at(-1)).toBe("kanban");
    expect(back.slice(0, -1)).toEqual(start.filter((k) => k !== "kanban"));
    expect((await b.head()).pinned).toContain("kanban");
  });

  it("a size asked for in calm mode is refused in those words, and nothing is stored", async () => {
    const b = await board(3);
    await db.update(user).set({ calmMode: true }).where(eq(user.id, b.id));
    await b.render();
    const before = (await b.head()).version;
    const res = (await b.chatEdit([{ op: "set_props", section: b.card("Grove"), props: { variant: "compact" } }])).result as { applied?: boolean; error?: string };
    expect(res.applied).toBeUndefined();
    expect(res.error).toMatch(/calm mode/);
    expect((await b.head()).version).toBe(before);
  });

  it("a move by index is for what is on the board: it does not bring back what he hid", async () => {
    const b = await board(3);
    await b.render();
    await b.chatEdit([{ op: "remove", section: "people_index" }]);
    const res = (await b.chatEdit([{ op: "move", section: "people_index", to: 0 }])).result as { applied?: boolean; error?: string };
    expect(res.applied).toBeUndefined();
    expect(res.error).toMatch(/There's no people on the dashboard/);
    expect(await b.keys()).not.toContain("people_index");
    expect(await hideRows(b.id)).toHaveLength(1);
  });

  it("showing something the board cannot draw is refused: the claim is checked on the board, and the hide stays", async () => {
    const b = await board(3);
    await b.render();
    const before = (await b.head()).version;
    // A hide left from before the component was retired.
    await db.insert(layoutPreferences).values({ userId: b.id, kind: "hide_section", value: { section: "open_loops" } });
    const res = await requestBoard(b.id, { ops: [{ op: "show", key: "open_loops" }] });
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/would not show on the dashboard.*Nothing was changed/) });
    expect((await b.head()).version).toBe(before);
    expect(await hideRows(b.id)).toHaveLength(1);
  });

  it("a preference pin from before r5 is given its place by his next request as well, and marked", async () => {
    const b = await board(5);
    await b.render();
    const key = b.card("Grove");
    const at = (await b.keys()).indexOf(key);
    await db.insert(layoutPreferences).values({ userId: b.id, kind: "pin_section", value: { section: key } });
    // A request, with no open in between.
    expect((await b.arrange([{ op: "move_to_top", section: "shopping list" }])).result).toMatchObject({ applied: true });
    const rows = await db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, b.id), eq(layoutPreferences.kind, "pin_section")));
    expect(rows.map((r) => r.value)).toEqual([{ section: key, migrated: "1" }]);
    expect((await b.head()).pinned).toContain(key);
    expect((await b.keys()).indexOf(key)).toBe(at + 1); // the list went in above it; everything else as he saw it
  });

  it("a section that comes back goes where today's system order has it: with the strip sent up by a rule, the tiles come back under the strip", async () => {
    const b = await board(3);
    await b.render();
    await b.nextDay();
    await b.say("when is the deadline?", 6);
    expect((await b.keys())[0]).toBe("timeline"); // rule 3
    // A day on, and he is still asking: the rules plan has the strip first today as well.
    await b.nextDay();
    expect((await b.keys())[0]).toBe("timeline");
    expect(await pin(b.id, "hero_next_up", true)).toBe(true); // next up is his: it is not a neighbour the tiles can follow
    await b.arrange([{ op: "hide", section: "stats" }]);
    expect((await b.arrange([{ op: "show", section: "stats" }])).result).toMatchObject({ applied: true });
    const shown = await b.keys();
    expect(shown.indexOf("stat_row")).toBe(shown.indexOf("timeline") + 1);
    // And the board he was told is one the rules plan is not refused against (round 4 held the plan here).
    const signals = await computeSignals(b.id);
    const head = await b.head();
    expect((await planWithFallback(signals, { previousPlan: head.spec as LayoutPlan, preferences: [], pinnedSections: head.pinned, llmEnabled: false })).source).toBe("rules");
  });

  it("Put it back puts what he had placed at the place the earlier board wrote, on today's data", async () => {
    const b = await board(5);
    await b.render();
    await b.arrange([{ op: "move_up", section: "needs a date" }]);
    const at = (await b.keys()).indexOf("date_chase");
    const away = NAMES.slice(2, 8);
    for (const name of away) await b.archive(name);
    expect((await b.keys()).indexOf("date_chase")).toBeLessThan(at); // a short board: it stands at the end of what is left
    for (const name of away) await db.update(projects).set({ status: "active" }).where(eq(projects.id, b.ids[name]));
    expect((await b.keys()).indexOf("date_chase")).toBe(at); // they are back, and so is it
    // The version before this one is the short board. Put back on today's data, Needs a date is where he was told.
    expect((await requestBoard(b.id, { revert: true })).ok).toBe(true);
    expect((await b.keys()).indexOf("date_chase")).toBe(at);
  });

  it("Put it back is a request: every place is read again from the board he is told", async () => {
    const b = await board(5);
    await b.render();
    await b.arrange([{ op: "move_up", section: "needs a date" }]);
    const at = (await b.keys()).indexOf("date_chase");
    for (const name of NAMES.slice(2, 8)) await b.archive(name);
    const short = await b.keys(); // stored: Needs a date at the end, its place still the one he was told
    const placeOf = async () => ((await b.head()).spec as LayoutPlan).sections.find((s) => s.component === "date_chase")?.place;
    expect(await placeOf()).toEqual({ from: "top", n: at });
    expect(await pin(b.id, "stat_row", true)).toBe(true); // any request, so there is something to put back
    expect((await requestBoard(b.id, { revert: true })).ok).toBe(true);
    expect(await b.keys()).toEqual(short);
    // The known cost, accepted: past the end of a board grown short, the place is where it stands when he next speaks.
    expect(await placeOf()).not.toEqual({ from: "top", n: at });
    const stood = short.length - 1 - short.indexOf("date_chase");
    expect(await placeOf()).toEqual({ from: "bottom", n: stood });
  });
});

