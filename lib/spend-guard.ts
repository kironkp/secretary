// The fail-safe on spend (Kiron, 2026-09-25: "If an app spends so much we
// need a fail safe. And a way to notify me." — a night of background reading
// on the most expensive fallback model cost about $40 while no one used the
// app). Two lines, both per user, both over the last 24 hours, both summed
// from the same cost column the Settings spend card shows:
//
// - a CAP on understanding runs (the sweep, "Understand now", the
//   interview's "ask me more", an answer's re-read): past it, runs skip
//   until the window rolls on. Chat, calls and answering itself are never
//   blocked; only the re-read an answer starts waits;
// - an ALERT on total spend: a push the first time a day crosses it.
//
// Every alert is sent once (push_log keys by user and UTC day), so a sweep every ten
// minutes cannot turn into a push every ten minutes.
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A dollar amount from the environment; unset, junk or negative is the fallback. 0 only where `zeroOk`. */
const envUsd = (name: string, fallback: number, zeroOk = false): number => {
  const raw = process.env[name];
  const v = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(v) && (v > 0 || (zeroOk && v === 0)) ? v : fallback;
};

/** Understanding runs may spend this much in 24 hours ($3 since SEC-A004; it was $5). 0 turns them off. */
export const backgroundCapUsd = () => envUsd("UNDERSTANDING_DAILY_CAP_USD", 3, true);
/**
 * One understanding run may spend this much, every attempt included
 * (run.ts stops before an attempt that could pass it), and never more than
 * the daily cap. It is also what the daily cap counts a run as before it
 * starts: a Caltrans run that failed three times at 32k output tokens each
 * cost about $3 on Opus. 0 turns runs off.
 */
export const runCapUsd = () =>
  Math.min(envUsd("UNDERSTANDING_RUN_CAP_USD", 1.5, true), backgroundCapUsd());
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
 * Whether an understanding run may call a model now: what the last 24 hours
 * spent, plus `nextUsd` (what the run about to start may cost) and
 * `inFlightUsd` (what runs still reading may), must not pass the cap.
 * Checking the spend alone let a run that started just under the cap land a
 * dollar over it. Over the cap, the user hears about it once that day; a
 * run that only has to wait for the others in flight is a queue, not a
 * pause, and says nothing.
 */
export async function backgroundAllowed(
  userId: string,
  nextUsd = 0,
  inFlightUsd = 0
): Promise<{ ok: boolean; spent: number; cap: number }> {
  const cap = backgroundCapUsd();
  // Turned off on purpose: nothing to read, nothing to tell.
  if (cap <= 0) return { ok: false, spent: 0, cap };
  const spent = await spentLastDay(userId, "understanding");
  if (spent < cap && spent + inFlightUsd + nextUsd <= cap) return { ok: true, spent, cap };
  if (spent < cap && spent + nextUsd <= cap) return { ok: false, spent, cap };
  await alertOnce(
    userId,
    "understanding-cap",
    "Background reading paused",
    `It spent $${spent.toFixed(2)} in the last 24 hours, and another read could take it past its $${cap.toFixed(2)} cap. It starts again as that spend rolls off. Chat and calls still work.`
  );
  return { ok: false, spent, cap };
}

// --------------------------------------------------------------------------
// The global safety net (SEC-A004, 2026-10-06)
// --------------------------------------------------------------------------

/**
 * What runs with no one asking: understanding, extraction, the dashboard
 * planner, the slow loop, inbound email, and suggestions (kind "other" on
 * TEXT_MODEL; search_web is "other" too, on its own model, and is not
 * background).
 */
const BACKGROUND_KINDS = ["understanding", "extraction", "layout", "slow_loop", "email"] as const;
const SUGGESTIONS_MODEL = () => process.env.TEXT_MODEL ?? "gpt-5.5";

/** Every kind of paid call, as the guard sorts them. */
export type PaidKind =
  | (typeof BACKGROUND_KINDS)[number]
  | "suggestions"
  | "consult"
  | "paint"
  | "search"
  | "interpret"
  | "chat"
  | "voice"
  | "transcribe"
  | "speech";

/** The user's own turn: what SPEND_KILL still lets through. */
const USER_TURN: readonly PaidKind[] = ["chat", "voice", "transcribe", "speech"];

/** All background work may spend this much in 24 hours. 0 turns it off. */
export const backgroundDailyCapUsd = () => envUsd("BACKGROUND_DAILY_CAP_USD", 4, true);
/** SPEND_KILL=true: no paid call but the user's own chat or voice turn. */
export const spendKill = () => process.env.SPEND_KILL === "true";

/** Dollars all background work spent in the last 24 hours, from the same cost column. */
export async function backgroundSpentLastDay(userId: string): Promise<number> {
  const since = new Date(Date.now() - DAY_MS);
  const [row] = await db
    .select({ usd: sql<string>`coalesce(sum(${usage.costUsd}), 0)` })
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        gte(usage.createdAt, since),
        sql`(${usage.kind} in (${sql.join(
          BACKGROUND_KINDS.map((k) => sql`${k}`),
          sql`, `
        )}) or (${usage.kind} = 'other' and ${usage.model} = ${SUGGESTIONS_MODEL()}))`
      )
    );
  return Number(row?.usd ?? 0);
}

/**
 * Whether a paid call of `kind` may run now. SPEND_KILL refuses everything
 * but the user's own chat or voice turn; background work also stops once
 * the last 24 hours of it passed BACKGROUND_DAILY_CAP_USD. Either refusal
 * pushes once that day. `line` is what to tell the user.
 */
export async function paidCallAllowed(
  userId: string,
  kind: PaidKind
): Promise<{ ok: true } | { ok: false; line: string }> {
  if (spendKill() && !USER_TURN.includes(kind)) {
    await alertOnce(
      userId,
      "spend-kill",
      "Paid work is switched off",
      "SPEND_KILL is on: only your own chat and calls run. Background reading, drawing and look-ups wait.",
      "spend-guard"
    );
    return { ok: false, line: "That's switched off right now (SPEND_KILL): only chat and calls run." };
  }
  if (!(BACKGROUND_KINDS as readonly string[]).includes(kind) && kind !== "suggestions") return { ok: true };
  const cap = backgroundDailyCapUsd();
  const spent = cap > 0 ? await backgroundSpentLastDay(userId) : 0;
  if (cap > 0 && spent < cap) return { ok: true };
  if (cap > 0) {
    await alertOnce(
      userId,
      "background-cap",
      "Background work paused",
      `It spent $${spent.toFixed(2)} in the last 24 hours, its $${cap.toFixed(2)} cap. It starts again as that spend rolls off. Chat and calls still work.`
    );
  }
  return { ok: false, line: "Background work is paused for today (its spending cap)." };
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

/** A push keyed by UTC day, sent at most once per key per day; `tag` names the sender in the log. */
export async function alertOnce(
  userId: string,
  key: string,
  title: string,
  body: string,
  tag = "spend-guard"
): Promise<void> {
  try {
    const { claimPush, sendPush } = await import("@/lib/push");
    const day = new Date().toISOString().slice(0, 10);
    // push_log.key is unique across users, so the user is part of it: keyed
    // by day alone, the first user over a line silenced it for everyone else.
    if (!(await claimPush(userId, `${key}:${day}:${userId}`))) return;
    console.warn(`${tag}: ${title} — ${body}`);
    await sendPush(userId, { title, body, url: "/settings" });
  } catch (e) {
    console.error(`${tag}: alert failed:`, e instanceof Error ? e.message : e);
  }
}
