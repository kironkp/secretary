// SPEC §11 voice modality rule: a status is never spoken as a bare word.
// Transcript failure: "CPO 2073, blocked." — the blocker only ever lived in
// `notes` (overwritten by the next amend, never rendered), so the briefing had
// nothing but the enum to hand the mouth. Now the reason is its own field:
// log_status writes it, any other signal clears it, and the briefing either
// says what the thing is waiting on or tells the mouth to ask at a pause.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ilike } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks, user } from "@/lib/db/schema";
import { buildBriefing } from "@/lib/secretary/briefing";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-blocked-${crypto.randomUUID()}`, email: `blocked-${Date.now()}@p11.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };

beforeAll(async () => {
  await db
    .insert(user)
    .values({ id: U.id, name: "Blocked Tester", email: U.email, timezone: ctx.timezone });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

const taskLike = async (fragment: string) => {
  const [t] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, U.id), ilike(tasks.title, `%${fragment}%`)));
  return t;
};

describe("the blocker is a field, not a note", () => {
  it("log_status blocked stores the reason the user gave", async () => {
    await executeTool(ctx, "create_commitment", { title: "Update CPO 2073 (production monitor)" });
    const { result } = await executeTool(ctx, "log_status", {
      task: "CPO 2073",
      signal: "blocked",
      note: "waiting on Teresa's signature",
    });
    expect((result as { status?: string }).status).toBe("blocked");
    expect((result as { blocked_reason?: string }).blocked_reason).toBe(
      "waiting on Teresa's signature"
    );
    const t = await taskLike("CPO 2073");
    expect(t.blockedReason).toBe("waiting on Teresa's signature");
  });

  it("survives a later amend_task note — the reason is not free-form notes", async () => {
    await executeTool(ctx, "amend_task", {
      task: "CPO 2073",
      note: "form is in the shared drive",
    });
    const t = await taskLike("CPO 2073");
    expect(t.notes).toBe("form is in the shared drive");
    expect(t.blockedReason).toBe("waiting on Teresa's signature");
  });

  it("a later signal clears it — a moving item isn't stuck on what it was", async () => {
    await executeTool(ctx, "log_status", { task: "CPO 2073", signal: "started" });
    const t = await taskLike("CPO 2073");
    expect(t.status).toBe("in_progress");
    expect(t.blockedReason).toBeNull();
  });

  it("completing a task clears it too", async () => {
    await executeTool(ctx, "update_task", {
      task: "CPO 2073",
      status: "blocked",
      blocked_reason: "waiting on the CalCard reconcile",
    });
    expect((await taskLike("CPO 2073")).blockedReason).toBe("waiting on the CalCard reconcile");
    await executeTool(ctx, "log_status", { task: "CPO 2073", signal: "done" });
    const t = await taskLike("CPO 2073");
    expect(t.status).toBe("done");
    expect(t.blockedReason).toBeNull();
  });

  it('update_task clears it on an explicit ""', async () => {
    await executeTool(ctx, "create_task", { title: "Order the replacement monitor" });
    await executeTool(ctx, "update_task", {
      task: "replacement monitor",
      status: "blocked",
      blocked_reason: "vendor hasn't sent the quote",
    });
    expect((await taskLike("replacement monitor")).blockedReason).toBe(
      "vendor hasn't sent the quote"
    );
    await executeTool(ctx, "update_task", { task: "replacement monitor", blocked_reason: "" });
    const t = await taskLike("replacement monitor");
    expect(t.status).toBe("blocked"); // still blocked — just no longer says why
    expect(t.blockedReason).toBeNull();
  });
});

describe("blocked with no reason steers the mouth to ask NOW", () => {
  it("returns the ask-now nudge, and it is explicitly not a queued clarification", async () => {
    await executeTool(ctx, "create_commitment", { title: "Submit the CalCard reconcile" });
    const { result } = await executeTool(ctx, "log_status", {
      task: "CalCard reconcile",
      signal: "blocked",
    });
    const note = (result as { note?: string }).note ?? "";
    expect(note).toContain("Ask right now");
    expect(note).toContain("log_status blocked again");
    expect(note).toContain("Do NOT queue this one");
    // the fence: a hold still wins over the question (SPEC §11)
    expect(note).toContain("asked you to hold");
    expect((await taskLike("CalCard reconcile")).blockedReason).toBeNull();
  });

  it("the answer, logged in the next breath, lands on the task and the nudge stops", async () => {
    const { result } = await executeTool(ctx, "log_status", {
      task: "CalCard reconcile",
      signal: "blocked",
      note: "Walter hasn't confirmed the payment",
    });
    expect((result as { note?: string }).note).toBeUndefined();
    expect((await taskLike("CalCard reconcile")).blockedReason).toBe(
      "Walter hasn't confirmed the payment"
    );
  });

  it("a miss doesn't fake a nudge — an unmatched task still just errors", async () => {
    const { result } = await executeTool(ctx, "log_status", {
      task: "a task that was never logged",
      signal: "blocked",
    });
    expect((result as { error?: string }).error).toContain("No task matching");
    expect((result as { note?: string }).note).toBeUndefined();
  });
});

describe("the briefing hands the mouth a reason, never a bare word", () => {
  it("renders the recorded blocker inline", async () => {
    const { text } = await buildBriefing(U.id, ctx.timezone);
    expect(text).toContain("· blocked: Walter hasn't confirmed the payment");
    expect(text).not.toContain('"Submit the CalCard reconcile" · blocked ·');
  });

  it("marks a reasonless blocker as a pause question, not a mid-flow one", async () => {
    await executeTool(ctx, "create_commitment", { title: "Renew the DTC parking permit" });
    await executeTool(ctx, "log_status", { task: "parking permit", signal: "blocked" });
    const { text } = await buildBriefing(U.id, ctx.timezone);
    expect(text).toContain("· blocked (reason unknown — ask if it comes up)");
  });

  it("an unblocked task carries no blocker text at all", async () => {
    await executeTool(ctx, "log_status", {
      task: "parking permit",
      signal: "started",
    });
    const { text } = await buildBriefing(U.id, ctx.timezone);
    const line = text.split("\n").find((l) => l.includes("Renew the DTC parking permit"))!;
    expect(line).toContain("· in_progress");
    expect(line).not.toContain("reason unknown");
    expect(line).not.toContain("blocked");
  });
});
