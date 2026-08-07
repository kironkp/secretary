// Postgres-backed sliding-window limits over the usage table (F-4).
import { and, count, eq, gt, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { usage } from "@/lib/db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

function envInt(name: string, fallback: number) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function checkVoiceQuota(userId: string): Promise<
  { ok: true } | { ok: false; status: number; message: string }
> {
  if (process.env.VOICE_DISABLED === "true") {
    return {
      ok: false,
      status: 503,
      message: "Voice is briefly down for maintenance. Everything else works.",
    };
  }

  const perDay = envInt("VOICE_SESSIONS_PER_DAY", 30);
  const maxConcurrent = envInt("VOICE_MAX_CONCURRENT", 1);
  const now = Date.now();

  const [daily] = await db
    .select({ n: count() })
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        eq(usage.kind, "voice"),
        gt(usage.createdAt, new Date(now - DAY_MS))
      )
    );
  if ((daily?.n ?? 0) >= perDay) {
    return {
      ok: false,
      status: 429,
      message: `You've used today's ${perDay} voice sessions. Resets over the next 24h — typing still works.`,
    };
  }

  // Active session = seconds still 0 (set by /api/realtime/end). Real calls
  // report their end on disconnect and on pagehide; anything still open after
  // 5 minutes is an orphan (crashed tab, killed server) — close it out here
  // rather than blocking the user until a 30-minute window rolls over.
  const ORPHAN_MS = 5 * 60 * 1000;
  await db
    .update(usage)
    .set({ seconds: 1 })
    .where(
      and(
        eq(usage.userId, userId),
        eq(usage.kind, "voice"),
        eq(usage.seconds, 0),
        lt(usage.createdAt, new Date(now - ORPHAN_MS))
      )
    );
  const [active] = await db
    .select({ n: count() })
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        eq(usage.kind, "voice"),
        eq(usage.seconds, 0),
        gt(usage.createdAt, new Date(now - ORPHAN_MS))
      )
    );
  if ((active?.n ?? 0) >= maxConcurrent) {
    return {
      ok: false,
      status: 429,
      message: "A voice session is already running. End it before starting another.",
    };
  }

  return { ok: true };
}

export async function checkTranscribeQuota(userId: string): Promise<
  { ok: true } | { ok: false; status: number; message: string }
> {
  const perDay = envInt("TRANSCRIBE_REQUESTS_PER_DAY", 300);
  const [daily] = await db
    .select({ n: count() })
    .from(usage)
    .where(
      and(
        eq(usage.userId, userId),
        eq(usage.kind, "transcribe"),
        gt(usage.createdAt, new Date(Date.now() - DAY_MS))
      )
    );
  if ((daily?.n ?? 0) >= perDay) {
    return {
      ok: false,
      status: 429,
      message: "Daily dictation limit reached. Typing still works.",
    };
  }
  return { ok: true };
}
