// SEC-A004: the dashboard planner is called once per situation, not once per
// render or per process. The planner here is a counting fake handed to
// persistPlan; no model is reached.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutSpecs, projects, user } from "@/lib/db/schema";
import { clearPlanCache } from "@/lib/layout/plan-from-llm";
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
