// SPEC §2 (v1.02 r5): the day this version lands. A stored row written by the
// version before it (main) is read by every path that reads one: an open, an
// open that holds the row, the model's read of the board, the briefing, and
// Put it back. The walker never meets such a row, so the four shapes the
// Reviewer's upgrade probe used are written here by hand, as main wrote them:
// main's own order (next up, the tiles, the cards, the strip, a section
// retired since, Needs a date, People), no place on anything, pins as keys.
process.env.TZ = "UTC";

import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs, projects, tasks, user } from "@/lib/db/schema";
import { sectionKey, type LayoutPlan, type PlanSection } from "@/lib/layout/plan";
import { computeCurrentPlan, getPlanHead, persistPlan } from "@/lib/layout/plan-store";
import { requestBoard } from "@/lib/layout/request";
import { buildBriefing } from "@/lib/secretary/briefing";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const users: string[] = [];
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
const RETIRED = "open_loops";
const NAMES = ["Atlas", "Birch", "Cedar", "Dune"];

type Preference = { kind: "pin_section" | "hide_section" | "ban_component"; value: Record<string, string> };
type Shape = {
  plan_id: string;
  /** main's sections, from the cards by name. */
  sections: (card: (name: string) => PlanSection) => PlanSection[];
  pinned?: (key: (name: string) => string) => string[];
  preferences?: (key: (name: string) => string) => Preference[];
  /** The row is hours old (a planner's banner on it is still today's). */
  today?: boolean;
};
const strip: PlanSection = { component: "timeline", props: { span_days: 21, expanded: false } };
const mainsOrder = (cards: PlanSection[]): PlanSection[] => [{ component: "hero_next_up" }, { component: "stat_row" }, ...cards, strip, { component: RETIRED }, { component: "date_chase" }, { component: "people_index" }];

async function landed(shape: Shape) {
  const id = `test-from-main-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Upgrade", email: `${id}@v102.test`, timezone: TZ });
  const ids: Record<string, string> = {};
  for (const [i, name] of [...NAMES, "Shopping"].entries()) {
    const [p] = await db.insert(projects).values({ userId: id, name, kind: name === "Shopping" ? "list" : "project", status: "active" }).returning();
    ids[name] = p.id;
    await db.insert(tasks).values({ userId: id, projectId: p.id, title: `${name}: a task`, status: "todo", source: "spoken", dueAt: i < 2 ? day(-(i + 2)) : null });
  }
  const key = (name: string) => `project_card:${ids[name]}`;
  const card = (name: string): PlanSection => ({ component: "project_card", props: { project_id: ids[name], variant: "full" } });
  const spec = { plan_id: shape.plan_id, reason_summary: null, sections: shape.sections(card) };
  await db.insert(layoutSpecs).values({ userId: id, version: 7, spec, pinned: shape.pinned?.(key) ?? [], kind: "plan", signalsHash: "from-main", outcome: "accepted", createdAt: shape.today ? day(-0.1) : day(-3) });
  for (const p of shape.preferences?.(key) ?? []) await db.insert(layoutPreferences).values({ userId: id, kind: p.kind, value: p.value });
  const ctx = liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 });
  const open = async () => {
    const bundle = await computeCurrentPlan(id);
    await persistPlan(id, bundle);
    return bundle.plan.sections.map(sectionKey);
  };
  const versions = async () => (await db.select({ v: layoutSpecs.version }).from(layoutSpecs).where(eq(layoutSpecs.userId, id))).length;
  return { id, ids, key, ctx, open, versions, head: async () => (await getPlanHead(id))! };
}
const allCards = (card: (name: string) => PlanSection) => [...NAMES, "Shopping"].map(card);
const isCard = (k: string) => k.startsWith("project_card:");
/** The right way up on the usual order: next up and the tiles above every card the system places, Needs a date and People below. */
function rightWayUp(shown: string[], his: string[] = []) {
  const systems = shown.filter((k) => !his.includes(k));
  const cards = systems.map((k, i) => (isCard(k) ? i : -1)).filter((i) => i >= 0);
  for (const above of ["hero_next_up", "stat_row"]) if (systems.includes(above)) expect(systems.indexOf(above), above).toBeLessThan(cards[0]);
  for (const below of ["date_chase", "people_index"]) if (systems.includes(below)) expect(systems.indexOf(below), below).toBeGreaterThan(cards.at(-1)!);
}

afterAll(async () => {
  if (users.length) await db.delete(user).where(inArray(user.id, users));
});

const SHAPES: [string, Shape, { his: (key: (name: string) => string) => string[] }][] = [
  [
    "a pin main kept as a preference",
    { plan_id: "plan-old", sections: (card) => mainsOrder(allCards(card)), preferences: (key): Preference[] => [{ kind: "pin_section", value: { section: key("Cedar") } }] },
    { his: (key) => [key("Cedar")] },
  ],
  [
    "a board he arranged by voice (a user- plan, the list on top, pinned)",
    { plan_id: "user-old", sections: (card) => [card("Shopping"), ...mainsOrder(NAMES.map(card))], pinned: (key) => [key("Shopping")] },
    { his: (key) => [key("Shopping")] },
  ],
  [
    "a board he arranged in the chat (a chat- plan, a card moved above next up, never pinned on main)",
    { plan_id: "chat-old", sections: (card) => [card("Dune"), ...mainsOrder([...NAMES.filter((n) => n !== "Dune"), "Shopping"].map(card))] },
    { his: () => [] },
  ],
  [
    "hides and a ban",
    {
      plan_id: "plan-old",
      sections: (card) => mainsOrder(allCards(card).filter((s) => s.props?.project_id !== undefined)).filter((s) => s.component !== "stat_row" && s.component !== "people_index"),
      preferences: (key): Preference[] => [
        { kind: "hide_section", value: { section: "stat_row" } },
        { kind: "hide_section", value: { section: key("Dune") } },
        { kind: "ban_component", value: { component: "people_index" } },
      ],
    },
    { his: () => [] },
  ],
];

describe.each(SHAPES)("a row main wrote, the day this version lands: %s", (_name, shape, expected) => {
  it("every path that reads it: the retired section is on no board and told to nobody; the board is the right way up; what he placed is his", { timeout: 30_000 }, async () => {
    const b = await landed(shape);
    const his = expected.his(b.key);
    // The model's read of the board, and the briefing, before any open.
    const read = ((await executeTool(b.ctx, "get_current_plan", {})).result as { sections: { key: string }[] }).sections.map((s) => s.key);
    expect(read).not.toContain(RETIRED);
    const briefing = (await buildBriefing(b.id, TZ)).text;
    expect(briefing).toMatch(/DASHBOARD \(top to bottom\)/);
    expect(briefing).not.toMatch(/open loops|open_loops/i);
    // The first open.
    const first = await b.open();
    expect(first).toEqual(read);
    expect(first).not.toContain(RETIRED);
    expect(new Set(first).size).toBe(first.length);
    rightWayUp(first, his);
    for (const key of his) expect(first, "what he placed is on the board").toContain(key);
    for (const p of shape.preferences?.(b.key) ?? []) {
      if (p.kind === "hide_section" && !(isCard(p.value.section) && first.includes(p.value.section))) expect(first).not.toContain(p.value.section);
      if (p.kind === "ban_component") expect(first).not.toContain(p.value.component);
    }
    // It writes one row, marked, with his places on it and nothing retired; three more opens write nothing.
    const head = await b.head();
    expect((head.spec as LayoutPlan).composed).toBe(true);
    expect((head.spec as LayoutPlan).sections.map((s) => s.component)).not.toContain(RETIRED);
    expect(head.pinned.toSorted()).toEqual(his.toSorted());
    const stored = await b.versions();
    expect(stored).toBe(2);
    for (let again = 0; again < 3; again++) expect(await b.open()).toEqual(first);
    expect(await b.versions()).toBe(stored);
    // A pin main kept as a preference is marked, not deleted.
    const pins = await db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, b.id), eq(layoutPreferences.kind, "pin_section")));
    for (const row of pins) expect((row.value as Record<string, string>).migrated).toBe("1");

    // Put it back does not step behind that first open: refused in plain words, nothing written, his pin kept.
    const back = await requestBoard(b.id, { revert: true });
    expect(back).toMatchObject({ ok: false, error: expect.stringContaining("from before the last update") });
    expect(JSON.stringify(back)).not.toMatch(/project_card:|open_loops/);
    expect(await b.versions()).toBe(stored);
    expect((await b.head()).pinned.toSorted()).toEqual(his.toSorted());
    expect(await b.open()).toEqual(first);

    // After a request of his there is a board of this version to put back to.
    expect((await executeTool(b.ctx, "arrange_dashboard", { operations: [{ op: "move_to_bottom", section: "next up" }] })).result).toMatchObject({ applied: true });
    expect((await b.open()).at(-1)).toBe("hero_next_up");
    expect(await requestBoard(b.id, { revert: true })).toMatchObject({ ok: true });
    expect(await b.open()).toEqual(first);
    expect((await b.head()).pinned.toSorted()).toEqual(his.toSorted());
  });
});

describe("a row main wrote that is held on the landing day", () => {
  it("a planner's plan from main with a banner written hours ago and cards above next up: the banner stays today, and the board is the right way up", async () => {
    const b = await landed({
      plan_id: "llm-old",
      today: true,
      sections: (card) => [{ component: "focus_banner", props: { text: "Two things are late", tone: "serious" } }, card("Atlas"), card("Birch"), ...mainsOrder(["Cedar", "Dune", "Shopping"].map(card))],
    });
    const shown = await b.open();
    expect(shown[0]).toBe("focus_banner");
    expect(shown).not.toContain(RETIRED);
    expect(shown.slice(1, 3)).toEqual(["hero_next_up", "stat_row"]);
    rightWayUp(shown.slice(1));
    // Bounded, the run is right under the tiles, the strip under the cards: main's own look, until the next rules plan.
    expect(shown.indexOf("timeline")).toBeGreaterThan(shown.findLastIndex(isCard));
    expect(await b.open()).toEqual(shown);
  });

  it("on that board he hides Needs a date and shows it, then People: each comes back under the strip, and two days on the rules plan lands (a seed of the Reviewer's, 16180339)", { timeout: 30_000 }, async () => {
    // The strip stands under the cards on the board he sees. On 472c2a7 a section that came back went under the
    // nearest section above it in today's order, cards counted: under the last card, ABOVE the strip. The rules
    // plan has the strip above both, so from then on it was refused, and main's banner stayed for good.
    const b = await landed({
      plan_id: "llm-old",
      today: true,
      sections: (card) => [{ component: "focus_banner", props: { text: "Two things are late", tone: "serious" } }, card("Atlas"), card("Birch"), ...mainsOrder(["Cedar", "Dune", "Shopping"].map(card))],
    });
    // An older row behind it, as on his board.
    await db.insert(layoutSpecs).values({ userId: b.id, version: 6, spec: { plan_id: "plan-older", reason_summary: null, sections: mainsOrder(allCards((name) => ({ component: "project_card", props: { project_id: b.ids[name], variant: "full" } }))) }, pinned: [], kind: "plan", signalsHash: "from-main-older", outcome: "accepted", createdAt: day(-4) });
    const say = async (operations: { op: string; section: string }[]) => ((await executeTool(b.ctx, "arrange_dashboard", { operations })).result as { applied?: boolean }).applied;
    const first = await b.open();
    const cards = first.filter(isCard);
    expect(first).toEqual(["focus_banner", "hero_next_up", "stat_row", ...cards, "timeline", "date_chase", "people_index"]);
    expect(await say([{ op: "hide", section: "needs a date" }])).toBe(true);
    expect(await say([{ op: "show", section: "needs a date" }])).toBe(true);
    expect(await b.open()).toEqual(first);
    expect(await say([{ op: "hide", section: "people" }])).toBe(true);
    expect(await say([{ op: "show", section: "people" }])).toBe(true);
    expect(await b.open()).toEqual(first);
    // Both in one request, and by the pin button (pinned, then let go).
    expect(await say([{ op: "hide", section: "needs a date" }, { op: "show", section: "needs a date" }])).toBe(true);
    expect((await requestBoard(b.id, { ops: [{ op: "pin", key: "people_index" }] })).ok).toBe(true);
    expect((await requestBoard(b.id, { ops: [{ op: "unpin", key: "people_index" }] })).ok).toBe(true);
    expect(await b.open()).toEqual(first);
    // Two days on, something changes in his data: the banner goes and the rules plan is the board, the strip above the cards.
    await db.update(layoutSpecs).set({ createdAt: sql`${layoutSpecs.createdAt} - interval '49 hours'` }).where(eq(layoutSpecs.userId, b.id));
    await db.insert(tasks).values({ userId: b.id, projectId: b.ids.Cedar, title: "Cedar: one more", status: "todo", source: "spoken" });
    const later = await b.open();
    expect(later).toEqual(["hero_next_up", "stat_row", "timeline", ...later.filter(isCard), "date_chase", "people_index"]);
  });
});

describe("where he had placed something on a row main wrote, the retired section is not counted", () => {
  it("the strip pinned under the last card, and Needs a date moved up one: each is where he had it, not one place higher", async () => {
    const strip = await landed({ plan_id: "user-old", sections: (card) => mainsOrder(allCards(card)), pinned: () => ["timeline"] });
    const withStrip = await strip.open();
    expect(withStrip.slice(-3)).toEqual(["timeline", "date_chase", "people_index"]);
    const chase = await landed({
      plan_id: "user-old",
      sections: (card) => [{ component: "hero_next_up" }, { component: "stat_row" }, ...allCards(card), { component: "timeline", props: { span_days: 21, expanded: false } }, { component: "date_chase" }, { component: RETIRED }, { component: "people_index" }],
      pinned: () => ["date_chase"],
    });
    const withChase = await chase.open();
    expect(withChase.slice(-2)).toEqual(["date_chase", "people_index"]);
  });
});
