// Commitments (the nag engine's ledger): shared by every done-path — chat and
// voice tools, and the tasks PATCH route — so checking a task off on any
// surface stops the nags for it.
import { and, eq } from "drizzle-orm";
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
