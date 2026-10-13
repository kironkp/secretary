// Commitments (the nag engine's ledger): shared by every done-path — chat and
// voice tools, and the tasks PATCH route — so checking a task off on any
// surface stops the nags for it.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { expectations } from "@/lib/db/schema";

/** SPEC §11: a user report clears open expectations for the task — silently. */
export async function clearExpectationsFor(userId: string, taskId: string): Promise<void> {
  await db
    .update(expectations)
    .set({ status: "cleared", clearedAt: new Date() })
    .where(
      and(
        eq(expectations.userId, userId),
        eq(expectations.taskId, taskId),
        eq(expectations.status, "open")
      )
    );
}

/**
 * SPEC §11 (v1.03): the follow-ups a briefing raised have been asked, because
 * that briefing reached the model. They become `missed` and are not raised
 * again. Called by whoever handed the briefing over, AFTER the hand-over
 * succeeded; buildBriefing itself never settles anything, so a briefing built
 * for a page load, a card or a consultation cancels no promise. Only rows
 * still open are touched: a report that cleared one in the meantime stands.
 */
export async function settleFollowUps(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(expectations)
    .set({ status: "missed" })
    .where(and(eq(expectations.userId, userId), inArray(expectations.id, ids), eq(expectations.status, "open")));
}
