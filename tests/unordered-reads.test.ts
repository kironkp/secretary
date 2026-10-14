// v1.11 (docs/adaptive-ui/SPEC.md, "Rows read in no order are put in one"):
// where the order rows come back in reaches what he reads, the signals hash or
// a model's prompt, the read has an order of its own. The same rows, read in
// another order, give the same text, the same hash and the same prompt.
//
// Rows are shuffled without changing what they say: each is updated to itself,
// newest first, which writes a new copy of it, so Postgres hands them back in
// another order. The test checks that it did (otherwise it would prove
// nothing), then reads everything again.
process.env.TZ = "UTC";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

import { db } from "@/lib/db";
import { conversations, events, layoutPreferences, messages, projects, tasks, user, wishlist } from "@/lib/db/schema";
import { clearPlanCache, planWithFallback } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, getPreferences } from "@/lib/layout/plan-store";
import { REGISTRY_VERSION } from "@/lib/layout/registry";
import { computeSignals, signalsHash } from "@/lib/layout/signals";
import { listDynamicComponents } from "@/lib/layout/slow-loop";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const users: string[] = [];
const tomorrowAtTen = () => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(17, 0, 0, 0);
  return d;
};

/** Every table read in no order before v1.11, with two or more rows of his in it that the order would show. */
const TABLES = { wishlist: "wishlist", layout_preferences: "layout_preferences", events: "events", tasks: "tasks", messages: "messages" } as const;
const rawOrder = async (table: string, userId: string) =>
  ((await db.execute(sql`select id from ${sql.identifier(table)} where user_id = ${userId}`)).rows as { id: string }[]).map((r) => r.id);
/** Each row updated to itself, newest first: new copies, so the read order turns over. */
async function shuffle(userId: string) {
  for (const table of Object.values(TABLES)) {
    for (const id of (await rawOrder(table, userId)).reverse()) {
      await db.execute(sql`update ${sql.identifier(table)} set user_id = user_id where id = ${id}`);
    }
  }
}

async function his() {
  const id = `test-unordered-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Rows", email: `${id}@v111.test`, timezone: TZ });
  const [shed] = await db.insert(projects).values({ userId: id, name: "Garden shed", status: "active" }).returning();
  const [kitchen] = await db.insert(projects).values({ userId: id, name: "Kitchen repaint", status: "active" }).returning();
  // Three tasks with no date (the planner is handed them as a list).
  for (const title of ["Buy timber", "Pour the base", "Pick a colour"]) {
    await db.insert(tasks).values({ userId: id, projectId: title === "Pick a colour" ? kitchen.id : shed.id, title, status: "todo", source: "spoken" });
  }
  // Two events at the same instant: which one is "the next commitment" is in the signals hash.
  const at = tomorrowAtTen();
  await db.insert(events).values({ userId: id, projectId: shed.id, title: "Timber delivery", startsAt: at });
  await db.insert(events).values({ userId: id, projectId: kitchen.id, title: "Paint shop", startsAt: at });
  // Three questions about dates today (the planner is handed them as a list).
  const [conv] = await db.insert(conversations).values({ userId: id, mode: "text" }).returning();
  for (const content of ["When is the timber due?", "What is due tomorrow?", "When do I paint the kitchen?"]) {
    await db.insert(messages).values({ userId: id, conversationId: conv.id, role: "user", content, mode: "text", origin: "app" });
  }
  // Two preferences (the planner and get_current_plan are handed them as a list).
  await db.insert(layoutPreferences).values({ userId: id, kind: "hide_section", value: { section: "people_index" } });
  await db.insert(layoutPreferences).values({ userId: id, kind: "ban_component", value: { component: "stat_row" } });
  // Two wishes for a view the strip stands in for: whose need is the strip's "why".
  for (const need of ["A Gantt chart — every project on one line", "A calendar of the month — what lands when"]) {
    await db.insert(wishlist).values({ userId: id, need, closestComponent: "timeline", signals: "{}", priority: true, status: "open" });
  }
  return { id, ctx: liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 }) };
}

/** What he reads, the hash, and what the models are handed, read now. */
async function reading(userId: string, ctx: ReturnType<typeof liveTurnContext>) {
  clearPlanCache();
  const bundle = await computeCurrentPlan(userId);
  const signals = await computeSignals(userId);
  let prompt = "";
  await planWithFallback(signals, {
    previousPlan: bundle.plan,
    preferences: await getPreferences(userId),
    pinnedSections: bundle.pinned,
    llmEnabled: true,
    dynamicComponents: await listDynamicComponents(userId),
    call: Object.assign(
      async (system: string, signalsJson: string) => {
        prompt = `${system}\n${signalsJson}`;
        throw new Error("only the prompt is wanted");
      },
      { modelName: "claude-sonnet-5" }
    ),
  });
  return {
    why: bundle.plan.sections.find((s) => s.component === "timeline")?.why ?? null,
    hash: signalsHash(signals, REGISTRY_VERSION),
    next: signals.calendar.next_hard_commitment,
    prompt,
    currentPlan: JSON.stringify((await executeTool(ctx, "get_current_plan", {})).result),
  };
}

beforeEach(() => clearPlanCache());
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("the same rows read in another order", () => {
  it("give the same why, the same hash and the same prompts", async () => {
    const h = await his();
    const before = await reading(h.id, h.ctx);
    expect(before.why).toMatch(/closest I have until the A (Gantt|calendar)/);
    expect(before.prompt).toContain("Pick a colour");
    expect(before.next).not.toBeNull();
    const orders = Object.fromEntries(await Promise.all(Object.values(TABLES).map(async (t) => [t, await rawOrder(t, h.id)])));
    await shuffle(h.id);
    // The shuffle did turn the read order over, table by table; otherwise this test would prove nothing.
    for (const t of Object.values(TABLES)) expect(await rawOrder(t, h.id), t).toEqual([...orders[t]].reverse());
    const after = await reading(h.id, h.ctx);
    expect(after.why).toBe(before.why);
    expect(after.next).toBe(before.next);
    expect(after.hash).toBe(before.hash);
    expect(after.prompt).toBe(before.prompt);
    expect(after.currentPlan).toBe(before.currentPlan);
  });

  it("the fixed orders are the ones the spec names: wishes oldest first (the newer need stands), events at one instant by id", async () => {
    const h = await his();
    const r = await reading(h.id, h.ctx);
    // Wishes are walked oldest first and the last one written stands: the newer need.
    expect(r.why).toMatch(/A calendar of the month/);
    const [first] = await db.select({ id: events.id }).from(events).where(eq(events.userId, h.id)).orderBy(events.startsAt, events.id);
    expect(r.next).toBe(first.id);
  });
});
