// docs/spend/SPEC.md §1.2 (v1.04): a paid call that was sent and did not come
// back is still counted. Here, the dashboard planner: the app's own timeout,
// a dropped connection, a provider's outright refusal, and an answer that
// came back and was thrown away. No model is reached.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { projects, tasks, usage, user } from "@/lib/db/schema";
import { claudePlannerCall, clearPlanCache, lastPlannerUsage, livePlannerCall, plannerPrompt, type PlannerCall } from "@/lib/layout/plan-from-llm";
import { PLANNER_MODEL } from "@/lib/openai";
import { computeCurrentPlan, persistPlan } from "@/lib/layout/plan-store";
import { backgroundSpentLastDay, paidCallAllowed } from "@/lib/spend-guard";
import { estimateSentTokens, mayHaveBeenBilled } from "@/lib/unanswered";

const TZ = "America/Los_Angeles";
const users: string[] = [];
async function board(): Promise<string> {
  const id = `test-unanswered-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Unanswered", email: `${id}@v104.test`, timezone: TZ });
  const [p] = await db.insert(projects).values({ userId: id, name: "Boat" }).returning();
  await db.insert(tasks).values({ userId: id, projectId: p.id, title: "Service the boat", status: "todo", dueAt: new Date(Date.now() + 3 * 86_400_000) });
  return id;
}
const layoutRows = (userId: string) => db.select().from(usage).where(and(eq(usage.userId, userId), eq(usage.kind, "layout")));
/** One dashboard render and the background refinement after it, with this planner. */
async function renderWith(userId: string, call: PlannerCall) {
  clearPlanCache();
  const bundle = await computeCurrentPlan(userId);
  await persistPlan(userId, bundle, { call });
  return bundle;
}
/** What the planner is sent for these signals: the prompt and the signals, as the code builds them. */
const sentFor = (signals: unknown) => [plannerPrompt(), JSON.stringify(signals)];
const named = (model: string, fn: (prompt: string, signals: string, signal?: AbortSignal) => Promise<string>): PlannerCall => Object.assign(fn, { modelName: model });

beforeEach(() => clearPlanCache());
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("the estimate for a call nobody heard back from", () => {
  it("is not below what was sent: one token per two bytes, where this app's requests measure 2.4 to 3.0 characters a token", () => {
    expect(estimateSentTokens(["abcd"])).toBe(2);
    expect(estimateSentTokens(["abc", null, undefined, "de"])).toBe(3);
    expect(estimateSentTokens([])).toBe(0);
    // Counted in bytes, so text that is dense in tokens is not under-counted: three bytes a character here.
    expect(estimateSentTokens(["日本語"])).toBe(5);
    // The densest real ratio measured (the live briefing, 16,043 characters for 6,702 tokens) is covered with room.
    expect(estimateSentTokens(["x".repeat(16_043)])).toBeGreaterThan(6_702);
    expect(estimateSentTokens(["x".repeat(48_451)])).toBeGreaterThan(19_339); // the tool definitions
  });

  it("a provider's outright refusal cost nothing; anything else may have", () => {
    for (const status of [400, 401, 403, 404, 408, 422, 429]) expect(mayHaveBeenBilled(Object.assign(new Error("refused"), { status })), String(status)).toBe(false);
    for (const status of [500, 502, 503, 529]) expect(mayHaveBeenBilled(Object.assign(new Error("server"), { status })), String(status)).toBe(true);
    expect(mayHaveBeenBilled(new Error("planner timeout"))).toBe(true);
    expect(mayHaveBeenBilled(new Error("socket hang up"))).toBe(true);
    expect(mayHaveBeenBilled(null)).toBe(true);
  });
});

describe("the dashboard planner, sent and never answered", { timeout: 30_000 }, () => {
  it("our own timeout: a row at what was sent, priced on the planner's model, marked estimated; and the request is aborted", async () => {
    const userId = await board();
    vi.stubEnv("PLANNER_TIMEOUT_MS", "40");
    let aborted = false;
    let sent: string[] = [];
    const never = named("claude-sonnet-5", (prompt, signals, signal) => {
      sent = [prompt, signals];
      signal?.addEventListener("abort", () => (aborted = true));
      return new Promise<string>(() => {});
    });
    const bundle = await renderWith(userId, never);
    expect(aborted).toBe(true);
    const rows = await layoutRows(userId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({ kind: "layout", model: "claude-sonnet-5", outputTokens: 0, costEstimated: true });
    // Not below what was sent.
    expect(row.inputTokens).toBe(estimateSentTokens(sent));
    expect(sent).toEqual(sentFor(bundle.signals));
    const chars = sent.join("").length;
    expect(row.inputTokens).toBeGreaterThanOrEqual(Math.ceil(chars / 2.39));
    expect(Number(row.costUsd)).toBeCloseTo((row.inputTokens * 2) / 1_000_000, 6);
    expect(Number(row.costUsd)).toBeGreaterThan(0);
  });

  it("a dropped connection is counted the same way", async () => {
    const userId = await board();
    await renderWith(userId, named("gpt-5.4-nano", async () => {
      throw new Error("socket hang up");
    }));
    const [row] = await layoutRows(userId);
    expect(row).toMatchObject({ model: "gpt-5.4-nano", outputTokens: 0, costEstimated: true });
    expect(row.inputTokens).toBeGreaterThan(1_000);
  });

  it("a planner nobody named is priced at the ceiling, like any unknown model", async () => {
    const userId = await board();
    await renderWith(userId, async () => {
      throw Object.assign(new Error("upstream"), { status: 503 });
    });
    const [row] = await layoutRows(userId);
    expect(row).toMatchObject({ model: null, costEstimated: true });
    expect(Number(row.costUsd)).toBeCloseTo((row.inputTokens * 10) / 1_000_000, 6);
  });

  it.each([429, 401, 400])("a refusal before any work (HTTP %i) writes no row", async (status) => {
    const userId = await board();
    await renderWith(userId, named("claude-sonnet-5", async () => {
      throw Object.assign(new Error("refused"), { status });
    }));
    expect(await layoutRows(userId)).toHaveLength(0);
  });

  it("the cap sees it: timeouts on a new situation each time close background work instead of spending unseen", async () => {
    const userId = await board();
    vi.stubEnv("BACKGROUND_DAILY_CAP_USD", "0.05");
    vi.stubEnv("PLANNER_TIMEOUT_MS", "20");
    const never = named("claude-fable-5", () => new Promise<string>(() => {}));
    let renders = 0;
    while ((await paidCallAllowed(userId, "layout")).ok && renders < 12) {
      // A new situation each time, as a busy day is: one more task.
      await db.insert(tasks).values({ userId, title: `Another thing ${renders}`, status: "todo" });
      await renderWith(userId, never);
      renders++;
    }
    expect(renders).toBeGreaterThan(0);
    expect(renders).toBeLessThan(12);
    expect(await backgroundSpentLastDay(userId)).toBeGreaterThanOrEqual(0.05);
    expect((await paidCallAllowed(userId, "layout")).ok).toBe(false);
    expect(await layoutRows(userId)).toHaveLength(renders);
  });
});

describe("the dashboard planner, answered and thrown away", { timeout: 30_000 }, () => {
  it("a refusal from Claude is billed as it reported, not estimated, and once", async () => {
    const userId = await board();
    const client = {
      messages: {
        create: async () => ({ content: [], stop_reason: "refusal", usage: { input_tokens: 4_200, output_tokens: 12 } }),
      },
    } as unknown as Anthropic;
    await renderWith(userId, claudePlannerCall(client, "claude-sonnet-5"));
    const rows = await layoutRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "claude-sonnet-5", inputTokens: 4_200, outputTokens: 12, costEstimated: false });
  });

  it("an answer that does not validate is billed as it reported", async () => {
    const userId = await board();
    await renderWith(userId, named("claude-sonnet-5", async () => {
      lastPlannerUsage.model = "claude-sonnet-5";
      lastPlannerUsage.input = 3_900;
      lastPlannerUsage.output = 700;
      return "this is not a plan";
    }));
    const rows = await layoutRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputTokens: 3_900, outputTokens: 700, costEstimated: false });
  });

  it("figures left over from an earlier call are not billed to a call that never answered", async () => {
    const userId = await board();
    lastPlannerUsage.model = "claude-fable-5";
    lastPlannerUsage.input = 99_999;
    lastPlannerUsage.output = 9_999;
    await renderWith(userId, named("claude-sonnet-5", async () => {
      throw new Error("socket hang up");
    }));
    const [row] = await layoutRows(userId);
    expect(row).toMatchObject({ model: "claude-sonnet-5", outputTokens: 0, costEstimated: true });
    expect(row.inputTokens).not.toBe(99_999);
  });

  it("the Claude planner passes the abort signal to the request and names its model", async () => {
    let options: { signal?: AbortSignal } | undefined;
    const client = {
      messages: {
        create: async (_req: unknown, opts: { signal?: AbortSignal }) => {
          options = opts;
          return { content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    } as unknown as Anthropic;
    const call = claudePlannerCall(client, "claude-sonnet-5");
    expect(call.modelName).toBe("claude-sonnet-5");
    // The OpenAI planner names its model too, so its unanswered calls are priced on it.
    expect(livePlannerCall.modelName).toBe(PLANNER_MODEL);
    const signal = new AbortController().signal;
    await call("p", "{}", signal);
    expect(options?.signal).toBe(signal);
  });
});
