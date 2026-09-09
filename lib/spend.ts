// Spend reporting: where the money actually went.
//
// Reads the priced `usage` rows and groups them the two ways that answer the
// question — by WHAT the app was doing (kind) and by WHICH model. Costs are
// read from the stored `cost_usd`, priced at the time each call happened, so a
// rate change never rewrites history. Rows written before pricing existed are
// backfilled by scripts/backfill-usage-cost.ts.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";

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

export async function spendReport(userId: string, days = 30): Promise<SpendReport> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select()
    .from(usage)
    .where(and(eq(usage.userId, userId), gte(usage.createdAt, since)))
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
    const day = row.createdAt.toISOString().slice(0, 10);
    daily.set(day, (daily.get(day) ?? 0) + usd);
  }

  const sortByUsd = (a: SpendBucket, b: SpendBucket) => b.usd - a.usd;
  const perDayUsd = totalUsd / Math.max(1, days);

  return {
    days,
    totalUsd,
    calls: rows.length,
    perDayUsd,
    monthlyRunRateUsd: perDayUsd * 30,
    byKind: [...byKind.values()].sort(sortByUsd),
    byModel: [...byModel.values()].sort(sortByUsd),
    daily: [...daily.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, usd]) => ({ day, usd })),
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
