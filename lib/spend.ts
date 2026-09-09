// Spend reporting: where the money actually went.
//
// Reads the priced `usage` rows and groups them the two ways that answer the
// question — by WHAT the app was doing (kind) and by WHICH model. Costs are
// read from the stored `cost_usd`, priced at the time each call happened, so a
// rate change never rewrites history. Rows written before pricing existed are
// backfilled by scripts/backfill-usage-cost.ts.
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";
import { tzOffsetMs } from "@/lib/time";

/** 1 day, 7 days, 30 days — and the unit you step through when navigating. */
export type SpendPeriod = "day" | "week" | "month";

export type SpendWindow = {
  period: SpendPeriod;
  /** 0 = the current one, -1 = the previous, and so on. Never positive. */
  offset: number;
  start: Date;
  end: Date;
  /** "Today", "This week", "September" — what the user is looking at. */
  label: string;
  /** False for the current period: you cannot step into the future. */
  hasNext: boolean;
  /** Days in the window, for the daily bars and the per-day average. */
  days: number;
};

/** Local calendar parts for an instant, in the user's timezone. */
function localParts(tz: string, at: Date) {
  const local = new Date(at.getTime() + tzOffsetMs(tz, at));
  return {
    y: local.getUTCFullYear(),
    m: local.getUTCMonth(),
    d: local.getUTCDate(),
    dow: local.getUTCDay(),
  };
}

/** A local wall-clock midnight, expressed as the UTC instant it happens at. */
function localMidnight(tz: string, y: number, m: number, d: number): Date {
  const guess = new Date(Date.UTC(y, m, d));
  // Offset is evaluated near the target instant so DST changes land correctly.
  return new Date(guess.getTime() - tzOffsetMs(tz, guess));
}

const DAY_MS = 86_400_000;

/**
 * The window for a period at an offset, in the user's timezone.
 *
 * Boundaries are LOCAL calendar boundaries, not "N × 24h ago": a week starts on
 * Monday where the user lives, and a month is a real month. Doing this in
 * server time would put a late-evening call in the wrong day.
 */
export function spendWindow(
  period: SpendPeriod,
  offset: number,
  tz: string,
  now: Date = new Date()
): SpendWindow {
  const clamped = Math.min(0, Math.round(offset));
  const p = localParts(tz, now);
  let start: Date;
  let end: Date;
  let label: string;

  if (period === "day") {
    start = localMidnight(tz, p.y, p.m, p.d + clamped);
    end = localMidnight(tz, p.y, p.m, p.d + clamped + 1);
    label =
      clamped === 0 ? "Today" : clamped === -1 ? "Yesterday" : fmtDay(tz, start);
  } else if (period === "week") {
    // Monday-start, which is how a working week reads.
    const backToMonday = (p.dow + 6) % 7;
    start = localMidnight(tz, p.y, p.m, p.d - backToMonday + clamped * 7);
    end = new Date(start.getTime() + 7 * DAY_MS);
    label = clamped === 0 ? "This week" : clamped === -1 ? "Last week" : fmtRange(tz, start, end);
  } else {
    start = localMidnight(tz, p.y, p.m + clamped, 1);
    end = localMidnight(tz, p.y, p.m + clamped + 1, 1);
    label = clamped === 0 ? "This month" : fmtMonth(tz, start);
  }

  return {
    period,
    offset: clamped,
    start,
    end,
    label,
    hasNext: clamped < 0,
    days: Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS)),
  };
}

const fmt = (tz: string, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts });

function fmtDay(tz: string, at: Date) {
  return fmt(tz, { weekday: "short", month: "short", day: "numeric" }).format(at);
}
function fmtMonth(tz: string, at: Date) {
  return fmt(tz, { month: "long", year: "numeric" }).format(at);
}
function fmtRange(tz: string, start: Date, end: Date) {
  const last = new Date(end.getTime() - DAY_MS);
  const a = fmt(tz, { month: "short", day: "numeric" }).format(start);
  const b = fmt(tz, { month: "short", day: "numeric" }).format(last);
  return `${a} – ${b}`;
}

export type SpendBucket = {
  key: string;
  calls: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  /** Any row in the bucket whose price rests on an assumption. */
  estimated: boolean;
};

export type SpendReport = {
  window: SpendWindow;
  days: number;
  totalUsd: number;
  calls: number;
  /** Straight-line projection from the window; a hint, not a forecast. */
  perDayUsd: number;
  monthlyRunRateUsd: number;
  byKind: SpendBucket[];
  byModel: SpendBucket[];
  daily: { day: string; usd: number }[];
  /** The individual calls that cost the most — usually the real story. */
  biggest: {
    id: string;
    kind: string;
    model: string | null;
    usd: number;
    inputTokens: number;
    outputTokens: number;
    at: string;
  }[];
  /** True when any priced row is an estimate, so the UI can say so. */
  anyEstimated: boolean;
};

/** Human labels for the internal kind values. */
export const KIND_LABEL: Record<string, string> = {
  voice: "Voice calls",
  transcribe: "Dictation",
  extraction: "Reading your messages",
  layout: "Dashboard planning",
  chat: "Chat",
  consult: "Deep thinking",
  paint: "Canvas painting",
  slow_loop: "Building components",
  email: "Email intake",
  speech: "Speech",
  other: "Other",
};

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function spendReport(userId: string, window: SpendWindow, tz = "UTC"): Promise<SpendReport> {
  const days = window.days;
  const rows = await db
    .select()
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        gte(usage.createdAt, window.start),
        lt(usage.createdAt, window.end)
      )
    )
    .orderBy(desc(usage.createdAt));

  const bucket = (map: Map<string, SpendBucket>, key: string, row: (typeof rows)[number]) => {
    const b = map.get(key) ?? {
      key,
      calls: 0,
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimated: false,
    };
    b.calls++;
    b.usd += num(row.costUsd);
    b.inputTokens += row.inputTokens;
    b.outputTokens += row.outputTokens;
    b.estimated ||= row.costEstimated;
    map.set(key, b);
  };

  const byKind = new Map<string, SpendBucket>();
  const byModel = new Map<string, SpendBucket>();
  const daily = new Map<string, number>();
  let totalUsd = 0;
  let anyEstimated = false;

  for (const row of rows) {
    const usd = num(row.costUsd);
    totalUsd += usd;
    anyEstimated ||= row.costEstimated;
    bucket(byKind, row.kind, row);
    bucket(byModel, row.model ?? "unknown", row);
    // Bucket by LOCAL day, so an 11pm call lands on the day the user had it.
    const local = new Date(row.createdAt.getTime() + tzOffsetMs(tz, row.createdAt));
    daily.set(local.toISOString().slice(0, 10), (daily.get(local.toISOString().slice(0, 10)) ?? 0) + usd);
  }

  // Every day in the window, including the empty ones — a gap is information,
  // and a chart that silently omits quiet days misreads as continuous spend.
  const buckets: { day: string; usd: number }[] = [];
  if (window.period !== "day") {
    for (let i = 0; i < days; i++) {
      const at = new Date(window.start.getTime() + i * DAY_MS);
      const key = new Date(at.getTime() + tzOffsetMs(tz, at)).toISOString().slice(0, 10);
      buckets.push({ day: key, usd: daily.get(key) ?? 0 });
    }
  }

  const sortByUsd = (a: SpendBucket, b: SpendBucket) => b.usd - a.usd;
  const perDayUsd = totalUsd / Math.max(1, days);

  return {
    window,
    days,
    totalUsd,
    calls: rows.length,
    perDayUsd,
    monthlyRunRateUsd: perDayUsd * 30,
    byKind: [...byKind.values()].sort(sortByUsd),
    byModel: [...byModel.values()].sort(sortByUsd),
    daily: buckets,
    biggest: rows
      .slice()
      .sort((a, b) => num(b.costUsd) - num(a.costUsd))
      .slice(0, 8)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        model: r.model,
        usd: num(r.costUsd),
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        at: r.createdAt.toISOString(),
      })),
    anyEstimated,
  };
}

/** All-time total, so the report can say what has been spent overall as well
 *  as inside the window. */
export async function spendAllTime(userId: string): Promise<{ usd: number; calls: number }> {
  const [row] = await db
    .select({
      usd: sql<string>`coalesce(sum(${usage.costUsd}), 0)`,
      calls: sql<number>`count(*)::int`,
    })
    .from(usage)
    .where(eq(usage.userId, userId));
  return { usd: num(row?.usd), calls: row?.calls ?? 0 };
}
