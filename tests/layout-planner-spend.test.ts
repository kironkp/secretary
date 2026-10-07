// SEC-A004: the dashboard planner is called once per situation, not once per
// render or per process. The planner here is a counting fake handed to
// persistPlan; no model is reached.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutSpecs, projects, user } from "@/lib/db/schema";
import { clearPlanCache, lastPlannerUsage } from "@/lib/layout/plan-from-llm";
import { usage } from "@/lib/db/schema";
import { and } from "drizzle-orm";
import { computeCurrentPlan, getPlanHead, persistPlan } from "@/lib/layout/plan-store";

const users: string[] = [];
let calls = 0;
/** The planner proposes the board it was shown, unchanged: the common case. */
const samePlan = (plan: unknown) => async () => {
  calls++;
  return JSON.stringify(plan);
};

async function newUser(): Promise<string> {
  const id = `test-planner-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Planner", email: `${id}@sec-a004.test`, timezone: "America/Los_Angeles" });
  await db.insert(projects).values({ userId: id, name: "Caltrans" });
  return id;
}
/** One render of /dashboard and its background persist, with the fake planner. */
async function render(userId: string) {
  const bundle = await computeCurrentPlan(userId);
  await persistPlan(userId, bundle, { call: samePlan(bundle.plan) });
  return bundle;
}

beforeEach(() => {
  calls = 0;
  clearPlanCache();
});
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("the layout planner runs once per situation", () => {
  it("first render plans; the same situation again, even after a restart, calls nothing", async () => {
    const userId = await newUser();
    await render(userId);
    expect(calls).toBe(1);
    await render(userId);
    clearPlanCache(); // a restart forgets the in-memory cache
    await render(userId);
    expect(calls).toBe(1);
  });

  it("a new situation the planner leaves unchanged is remembered, so the next process doesn't ask again", async () => {
    const userId = await newUser();
    await render(userId);
    // The signals moved but the board didn't: the head is the right plan with
    // an old hash (production's common case).
    const head = (await getPlanHead(userId))!;
    await db.update(layoutSpecs).set({ signalsHash: "an-older-situation" }).where(eq(layoutSpecs.id, head.id));
    clearPlanCache(); // a new process: nothing in memory either
    calls = 0;
    await render(userId);
    expect(calls).toBe(1); // nothing remembered yet: asked once
    expect((await getPlanHead(userId))!.version).toBe(head.version); // nothing new to store
    clearPlanCache();
    await render(userId);
    expect(calls).toBe(1); // remembered across the "restart"
  });
});

describe("a planner answer the validator refuses is still paid for (sec rev, SEC-A007)", () => {
  it("is recorded in usage, priced, so the caps count it", async () => {
    const userId = await newUser();
    const bundle = await computeCurrentPlan(userId);
    // A real call reports its tokens this way (notePlannerUsage), then answers
    // with something that is not a plan.
    const refused = async () => {
      calls++;
      lastPlannerUsage.model = "claude-sonnet-5";
      lastPlannerUsage.input = 4_000;
      lastPlannerUsage.output = 800;
      return "Here is a nicer layout for you!";
    };
    await persistPlan(userId, bundle, { call: refused });
    expect(calls).toBe(1);
    const rows = await db.select().from(usage).where(and(eq(usage.userId, userId), eq(usage.kind, "layout")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "claude-sonnet-5", inputTokens: 4_000, outputTokens: 800 });
    expect(Number(rows[0].costUsd)).toBeGreaterThan(0);
  });
});

