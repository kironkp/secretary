// SPEC §2 (v1.02 r5): Put it back onto a board that lacks a section of the
// usual board, on every kind of system order. The Reviewer's grid, which
// found the composition putting a missing section in AFTER the place for the
// cards had been worked out (7 of 225 wrong on 472c2a7, all with Needs a date
// raised above next up): a planner's answer, one section hidden before it,
// one section pinned by him after it; he brings the hidden section back with
// a move and presses Put it back. The request must say the board the next
// open shows, store one version, and leave a board that composes to itself;
// a second Put it back redoes his move.
//
// PUT_IT_BACK_GRID=all runs every answer (225 cases, about a minute and a
// half); the suite runs the three with Needs a date raised, where every
// wrong board was (75 cases). On 472c2a7's code the full grid has 9 wrong
// states; here none.
process.env.TZ = "UTC";

import { afterAll, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs, projects, tasks, user } from "@/lib/db/schema";
import { composePlan } from "@/lib/layout/compose";
import { defaultPlan, sectionKey, type LayoutPlan, type PlanSection } from "@/lib/layout/plan";
import { clearPlanCache, lastPlannerUsage } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, getPlanHead, getPreferences, persistPlan } from "@/lib/layout/plan-store";
import { requestBoard } from "@/lib/layout/request";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const FIVE = ["hero_next_up", "stat_row", "timeline", "date_chase", "people_index"];
const SAID: Record<string, string> = { hero_next_up: "next up", stat_row: "stats", timeline: "project progress", date_chase: "needs a date", people_index: "people" };
const MARK = "[grid]";
const isCard = (k: string) => k.startsWith("project_card:");
const keys = (plan: LayoutPlan) => plan.sections.map(sectionKey);

type Answer = { name: string; sections: (plan: LayoutPlan) => PlanSection[] };
const cardsOf = (plan: LayoutPlan) => plan.sections.filter((s) => s.component === "project_card");
const arranged = (others: PlanSection[], cards: PlanSection[], where: "first" | "where they were" | "last") =>
  where === "first" ? [...cards, ...others] : where === "last" ? [...others, ...cards] : [...others.slice(0, others.findIndex((s) => s.component === "timeline") + 1), ...cards, ...others.slice(others.findIndex((s) => s.component === "timeline") + 1)];
const ORDERS: [string, (others: PlanSection[]) => PlanSection[]][] = [
  ["the usual order", (others) => others],
  ["Needs a date raised above next up", (others) => [{ component: "date_chase", props: { item_ids: [] }, why: "Several things have no date" }, ...others.filter((s) => s.component !== "date_chase")]],
  ["the tiles sunk to the bottom", (others) => [...others.filter((s) => s.component !== "stat_row"), { component: "stat_row", props: { tiles: [{ value: "3", label: "late" }] }, why: "The numbers matter less today" }]],
];
const ALL: Answer[] = ORDERS.flatMap(([order, cross]) =>
  (["first", "where they were", "last"] as const).map((where) => ({
    name: `${order}, the cards ${where}`,
    sections: (plan: LayoutPlan) => arranged(cross(plan.sections.filter((s) => s.component !== "project_card")), cardsOf(plan), where),
  }))
);
const ANSWERS = process.env.PUT_IT_BACK_GRID === "all" ? ALL : ALL.filter((a) => a.name.startsWith("Needs a date raised"));

const id = `test-grid-${crypto.randomUUID()}`;
afterAll(async () => {
  await db.delete(user).where(eq(user.id, id));
});

describe("Put it back onto a board that lacks a section of the usual board", () => {
  it(`${ANSWERS.length} planner answers x a section hidden before x a section pinned after: one version, the board the request says, and it composes to itself`, { timeout: 900_000 }, async () => {
    await db.insert(user).values({ id, name: "Grid", email: `${id}@v102.test`, timezone: TZ });
    for (const [i, name] of ["Atlas", "Birch", "Cedar", "Shopping"].entries()) {
      const [p] = await db.insert(projects).values({ userId: id, name, kind: name === "Shopping" ? "list" : "project", status: "active" }).returning();
      await db.insert(tasks).values({ userId: id, projectId: p.id, title: `${name}: a task`, status: "todo", source: "spoken", dueAt: i < 2 ? new Date(Date.now() - (i + 2) * 86_400_000) : null });
    }
    const [anyProject] = await db.select().from(projects).where(eq(projects.userId, id)).limit(1);
    const ctx = liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 });
    const open = async () => {
      const bundle = await computeCurrentPlan(id);
      await persistPlan(id, bundle);
      return keys(bundle.plan);
    };
    const versions = async () => (await db.select({ v: layoutSpecs.version }).from(layoutSpecs).where(eq(layoutSpecs.userId, id))).length;
    const say = (operations: { op: string; section: string }[]) => executeTool(ctx, "arrange_dashboard", { operations });
    const wrong: string[] = [];
    let cases = 0;
    let crossed = 0;
    for (const answer of ANSWERS) {
      for (const gone of FIVE) {
        for (const his of [null, ...FIVE.filter((k) => k !== gone)]) {
          cases++;
          const what = `${answer.name}; ${gone} hidden before; ${his ?? "nothing"} pinned after`;
          const fail = (reason: string) => wrong.push(`${what}: ${reason}`);
          await db.delete(layoutSpecs).where(eq(layoutSpecs.userId, id));
          await db.delete(layoutPreferences).where(eq(layoutPreferences.userId, id));
          await db.delete(tasks).where(and(eq(tasks.userId, id), like(tasks.title, `%${MARK}%`)));
          clearPlanCache();
          await open();
          await say([{ op: "hide", section: SAID[gone] }]);
          // The next day, a new situation, and the planner's answer.
          await db.update(layoutSpecs).set({ createdAt: sql`${layoutSpecs.createdAt} - interval '49 hours'` }).where(eq(layoutSpecs.userId, id));
          clearPlanCache();
          await db.insert(tasks).values({ userId: id, projectId: anyProject.id, title: `One more thing ${MARK}`, status: "todo", source: "spoken" });
          const bundle = await computeCurrentPlan(id);
          await persistPlan(id, bundle, {
            call: async () => {
              lastPlannerUsage.model = "claude-sonnet-5";
              lastPlannerUsage.input = 4_000;
              lastPlannerUsage.output = 800;
              const plan = defaultPlan(bundle.signals);
              return JSON.stringify({ plan_id: "p", reason_summary: "A busy week", sections: answer.sections(plan) });
            },
          });
          await open();
          if (his && (await open()).includes(his)) await requestBoard(id, { ops: [{ op: "pin", key: his }] });
          // He brings the hidden section back with a move: it is his now.
          const moved = (await say([{ op: "move_down", section: SAID[gone] }])).result as { applied?: boolean; error?: string };
          if (!moved.applied) {
            fail(`the move was refused: ${moved.error}`);
            continue;
          }
          const asked = await open();
          const before = await versions();
          const reply = await requestBoard(id, { revert: true });
          if (!reply.ok) {
            fail(`Put it back was refused: ${reply.error}`);
            continue;
          }
          const told = keys(reply.plan);
          if ((await versions()) !== before + 1) fail(`Put it back stored ${(await versions()) - before} versions`);
          const next = await open();
          if (next.join() !== told.join()) fail(`the request said ${told.map((k) => (isCard(k) ? "card" : k)).join(" ")} and the next open shows ${next.map((k) => (isCard(k) ? "card" : k)).join(" ")}`);
          await open();
          if ((await versions()) !== before + 1) fail("an open after it stored another version");
          // The stored board composes to itself, and the cards stand where the fewest of the system's sections are on the wrong side.
          const head = (await getPlanHead(id))!;
          const stored = head.spec as LayoutPlan;
          const again = composePlan(stored, { signals: (await computeCurrentPlan(id)).signals, stored, pinned: head.pinned, preferences: await getPreferences(id) });
          if (keys(again).join() !== keys(stored).join()) fail("the stored board does not compose to itself");
          const rest = keys(stored).filter((k) => k !== "focus_banner" && !head.pinned.includes(k));
          const system = rest.filter((k) => !isCard(k));
          const count = (at: number) => system.filter((k, i) => (["hero_next_up", "stat_row"].includes(k) && i >= at) || (["date_chase", "people_index"].includes(k) && i < at)).length;
          const fewest = Math.min(...Array.from({ length: system.length + 1 }, (_, at) => count(at)));
          const run = rest.findIndex(isCard);
          if (run !== -1 && count(run) !== fewest) fail(`${count(run)} of the system's sections are on the wrong side of the cards where ${fewest} would do`);
          if (fewest > 0) crossed++;
          if (told.includes("open_loops") || new Set(told).size !== told.length) fail("a section twice, or a retired one");
          if (!told.includes(gone)) fail(`${gone} is not hidden today and is not on the board`);
          // The second Put it back redoes his move.
          const redo = await requestBoard(id, { revert: true });
          if (!redo.ok) fail(`the second Put it back was refused: ${redo.error}`);
          else if ((await open()).join() !== asked.join()) fail("the second Put it back did not bring his move back");
        }
      }
    }
    expect(cases).toBe(ANSWERS.length * 25);
    // The grid is about crossed boards: enough of them have to be reached for it to mean anything.
    expect(crossed).toBeGreaterThan(cases / 5);
    expect(wrong).toEqual([]);
  });
});
