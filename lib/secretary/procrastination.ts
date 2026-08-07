// Procrastination detection (v1 heuristic from the spec board): postpones +
// age + ignored nudges + due-date slippage. The pure scorer is unit-testable;
// refreshProcrastinationScores persists it for open tasks (no model involved,
// cheap enough to run at every session start).
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks } from "@/lib/db/schema";

const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;
const DAY = 86400000;

export type ScoreInput = {
  postponedCount: number;
  createdAt: Date;
  dueAt: Date | null;
  lastNudgedAt: Date | null;
};

/**
 * 0 = fine, ~3+ = worth surfacing, ~6+ = top offender.
 * - each postpone: +2 (the strongest signal — an explicit dodge)
 * - age: +0.25/week open, capped at +2
 * - overdue: +0.5/day late, capped at +3
 * - ignored nudge: +1 if nudged over a day ago and still open
 */
export function procrastinationScore(t: ScoreInput, now: Date = new Date()): number {
  let score = t.postponedCount * 2;
  const ageWeeks = Math.max(0, (now.getTime() - t.createdAt.getTime()) / (7 * DAY));
  score += Math.min(2, ageWeeks * 0.25);
  if (t.dueAt && t.dueAt.getTime() < now.getTime()) {
    const daysLate = (now.getTime() - t.dueAt.getTime()) / DAY;
    score += Math.min(3, daysLate * 0.5);
  }
  if (t.lastNudgedAt && now.getTime() - t.lastNudgedAt.getTime() > DAY) {
    score += 1;
  }
  return Math.round(score * 100) / 100;
}

/** A human-readable "why" for the dashboard zone and briefings. */
export function procrastinationReason(t: ScoreInput, now: Date = new Date()): string {
  const parts: string[] = [];
  if (t.postponedCount > 0) parts.push(`pushed ${t.postponedCount}×`);
  const ageDays = Math.floor((now.getTime() - t.createdAt.getTime()) / DAY);
  if (ageDays >= 14) parts.push(`open ${Math.floor(ageDays / 7)} weeks`);
  if (t.dueAt && t.dueAt.getTime() < now.getTime()) {
    parts.push(`${Math.max(1, Math.floor((now.getTime() - t.dueAt.getTime()) / DAY))}d overdue`);
  }
  if (t.lastNudgedAt && now.getTime() - t.lastNudgedAt.getTime() > DAY) parts.push("nudged, no reply");
  return parts.join(" · ") || "stalling";
}

/** Recompute and persist scores for all open tasks. Returns the top offenders. */
export async function refreshProcrastinationScores(userId: string, now: Date = new Date()) {
  const open = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES])));

  const scored = open.map((t) => ({ task: t, score: procrastinationScore(t, now) }));
  await Promise.all(
    scored
      .filter(({ task, score }) => Math.abs(task.procrastinationScore - score) > 0.01)
      .map(({ task, score }) =>
        db
          .update(tasks)
          .set({ procrastinationScore: score })
          .where(and(eq(tasks.userId, userId), eq(tasks.id, task.id)))
      )
  );
  return scored
    .filter(({ score }) => score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ task, score }) => ({ ...task, procrastinationScore: score }));
}
