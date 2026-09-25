// The fail-safe on spend (Kiron, 2026-09-25: "If an app spends so much we
// need a fail safe. And a way to notify me." — a night of background reading
// on the most expensive fallback model cost about $40 while no one used the
// app). Two lines, both per user, both over the last 24 hours, both summed
// from the same cost column the Settings spend card shows:
//
// - a CAP on background reading (understanding runs): past it, runs skip
//   until the window rolls on — nothing the user does by hand is blocked;
// - an ALERT on total spend: a push the first time a day crosses it.
//
// Every alert is sent once (push_log keys by UTC day), so a sweep every ten
// minutes cannot turn into a push every ten minutes.
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

const envUsd = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Background reading may spend this much in 24 hours. */
export const backgroundCapUsd = () => envUsd("UNDERSTANDING_DAILY_CAP_USD", 5);
/** A push when all spend in 24 hours crosses this. */
export const alertUsd = () => envUsd("SPEND_ALERT_USD", 8);

/** Dollars spent in the last 24 hours, all kinds or one. */
export async function spentLastDay(userId: string, kind?: string): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const [row] = await db
    .select({ usd: sql<string>`coalesce(sum(${usage.costUsd}), 0)` })
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        gte(usage.createdAt, since),
        kind ? eq(usage.kind, kind as (typeof usage.kind.enumValues)[number]) : undefined
      )
    );
  return Number(row?.usd ?? 0);
}

/**
 * Whether background reading may call a model now. Over the cap, the
 * user hears about it once that day.
 */
export async function backgroundAllowed(userId: string): Promise<{ ok: boolean; spent: number; cap: number }> {
  const cap = backgroundCapUsd();
  const spent = await spentLastDay(userId, "understanding");
  if (spent < cap) return { ok: true, spent, cap };
  await alertOnce(
    userId,
    "understanding-cap",
    "Background reading paused",
    `It spent $${spent.toFixed(2)} in the last 24 hours, over its $${cap.toFixed(2)} cap. It starts again as that spend rolls off. Chat and calls still work.`
  );
  return { ok: false, spent, cap };
}

/** After any spend: one push the first time today's total crosses the alert line. */
export async function checkSpendAlert(userId: string): Promise<void> {
  const line = alertUsd();
  const spent = await spentLastDay(userId);
  if (spent < line) return;
  await alertOnce(
    userId,
    "spend-alert",
    `Secretary spent $${spent.toFixed(2)} today`,
    `That is over your $${line.toFixed(2)} alert line. Settings → API spend shows where it went.`
  );
}

/**
 * A provider refused for money (no credits, a spend limit): say so once a
 * day, since everything that uses it is quietly failing until someone tops
 * it up.
 */
export async function alertProviderOutOfCredit(userId: string, provider: "OpenAI" | "Claude", detail: string) {
  await alertOnce(
    userId,
    `provider-${provider.toLowerCase()}`,
    `${provider} is out of credit`,
    `${detail} Top it up to bring it back.`
  );
}

/** True when an error message is a provider refusing for money. */
export function isOutOfCredit(message: string): boolean {
  return /no credits|insufficient_quota|usage limits|credit balance|billing/i.test(message);
}

/** A push keyed by UTC day, sent at most once per key per day. */
async function alertOnce(userId: string, key: string, title: string, body: string): Promise<void> {
  try {
    const { claimPush, sendPush } = await import("@/lib/push");
    const day = new Date().toISOString().slice(0, 10);
    if (!(await claimPush(userId, `${key}:${day}`))) return;
    console.warn(`spend-guard: ${title} — ${body}`);
    await sendPush(userId, { title, body, url: "/settings" });
  } catch (e) {
    console.error("spend-guard: alert failed:", e instanceof Error ? e.message : e);
  }
}
