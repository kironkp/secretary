// Spend shapes and labels — CLIENT-SAFE.
//
// This file exists because of a bundler boundary, not a taste preference. The
// spend panel is a client component, and it needs the types and the human
// labels. If those live alongside the queries in lib/spend.ts, importing one
// value from there drags `@/lib/db` → `pg` → node:dns into the browser bundle
// and the build fails with "Can't resolve 'dns'". Types alone would be fine
// (erased at compile time); KIND_LABEL is a real value, so it has to live
// somewhere with no server imports.
//
// Rule: nothing in this file may import the database, drizzle, or anything
// under lib/db.

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
  understanding: "Understanding",
  email: "Email intake",
  speech: "Speech",
  other: "Other",
};
