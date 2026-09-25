// The spend fail-safe (lib/spend-guard.ts): Kiron, 2026-09-25 — "If an app
// spends so much we need a fail safe. And a way to notify me."
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { pushLog, usage, user } from "@/lib/db/schema";
import { backgroundAllowed, checkSpendAlert, isOutOfCredit, spentLastDay } from "@/lib/spend-guard";

const U = { id: `test-spend-${crypto.randomUUID()}`, email: `spend-${Date.now()}@p7.test` };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Spend Tester", email: U.email });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

const spend = (kind: "understanding" | "voice", usd: number, hoursAgo = 1) =>
  db.insert(usage).values({
    userId: U.id,
    kind,
    model: "test",
    costUsd: usd.toFixed(6),
    createdAt: new Date(Date.now() - hoursAgo * 3600_000),
  });

describe("spend guard", () => {
  it("counts only the last 24 hours, by kind or in total", async () => {
    await spend("understanding", 2);
    await spend("voice", 1);
    await spend("understanding", 50, 30); // yesterday: rolled off
    expect(await spentLastDay(U.id, "understanding")).toBeCloseTo(2);
    expect(await spentLastDay(U.id)).toBeCloseTo(3);
  });

  it("lets background reading run under the cap and stops it at the cap, alerting once", async () => {
    expect((await backgroundAllowed(U.id)).ok).toBe(true);
    await spend("understanding", 4); // 6 in the day, over the default $5
    const first = await backgroundAllowed(U.id);
    expect(first.ok).toBe(false);
    expect(first.spent).toBeCloseTo(6);
    await backgroundAllowed(U.id);
    const claimed = await db
      .select()
      .from(pushLog)
      .where(and(eq(pushLog.userId, U.id), like(pushLog.key, "understanding-cap:%")));
    expect(claimed).toHaveLength(1);
  });

  it("claims the total-spend alert once a day when it crosses the line", async () => {
    await spend("voice", 3); // 9 total, over the default $8 alert line
    await checkSpendAlert(U.id);
    await checkSpendAlert(U.id);
    const claimed = await db
      .select()
      .from(pushLog)
      .where(and(eq(pushLog.userId, U.id), like(pushLog.key, "spend-alert:%")));
    expect(claimed).toHaveLength(1);
  });

  it("recognises a provider refusing for money", () => {
    expect(isOutOfCredit("openai: 429 You have no credits remaining.")).toBe(true);
    expect(isOutOfCredit("You have reached your specified API usage limits.")).toBe(true);
    expect(isOutOfCredit("record.unknowns[4]: unknown memory id")).toBe(false);
  });
});
