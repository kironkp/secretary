// SPEC §11 expectations / nag engine. Transcript beat: "Go update
// two-zero-seven-three. When you check back in, tell me plainly whether it's
// updated and whether Tamsin's seen it — I'll be asking either way."
// That promise must be a ROW that fires, clears silently, batches, and
// respects quiet hours — never rhetoric.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { expectations, user } from "@/lib/db/schema";
import { buildBriefing } from "@/lib/secretary/briefing";
import { settleFollowUps } from "@/lib/secretary/expectations";
import { isQuietHours } from "@/lib/secretary/persona";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-expect-${crypto.randomUUID()}`, email: `exp-${Date.now()}@p7.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Expect Tester", email: U.email, timezone: ctx.timezone });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();

describe("expectations lifecycle", () => {
  it("'I'll be asking' writes a row linked to the task", async () => {
    await executeTool(ctx, "create_task", {
      title: "Update CPO 4513 (projection screen)",
      stakes: "miss reconcile → strike from HQ",
    });
    const { result } = await executeTool(ctx, "create_expectation", {
      commitment: "CPO 4513 updated and Tamsin has seen it",
      expected_update_by: hoursAgo(-24), // due tomorrow
      task: "CPO 4513",
      on_miss: "nag",
    });
    expect((result as { expectation_id?: string }).expectation_id).toBeTruthy();
    const [row] = await db.select().from(expectations).where(eq(expectations.userId, U.id));
    expect(row.taskId).toBeTruthy();
    expect(row.status).toBe("open");
  });

  it("a user report clears it silently — no nag ever fires", async () => {
    await executeTool(ctx, "update_task", { task: "CPO 4513", status: "in_progress" });
    const [row] = await db.select().from(expectations).where(eq(expectations.userId, U.id));
    expect(row.status).toBe("cleared");
    const briefing = await buildBriefing(U.id, ctx.timezone, { consumeNudges: true });
    expect(briefing.text).not.toContain("EXPECTATIONS MISSED");
    expect(briefing.followUps).toEqual([]);
  });

  it("misses fire at session start: batched into ONE ping, citing stakes; missed once handed over", async () => {
    await executeTool(ctx, "create_expectation", {
      commitment: "CPO 4513 signed by Tamsin",
      expected_update_by: hoursAgo(3),
      task: "CPO 4513",
      on_miss: "escalate",
    });
    await executeTool(ctx, "create_expectation", {
      commitment: "CalCard payment confirmed with Warren",
      expected_update_by: hoursAgo(1),
    });
    // A briefing that opens no session (a page load, the card, a consultation)
    // neither shows them nor touches them (v1.03).
    const passive = await buildBriefing(U.id, ctx.timezone);
    expect(passive.text).not.toContain("EXPECTATIONS MISSED");
    expect(passive.followUps).toEqual([]);

    const briefing = await buildBriefing(U.id, ctx.timezone, { consumeNudges: true });
    const pingHeaders = briefing.text.match(/EXPECTATIONS MISSED/g) ?? [];
    expect(pingHeaders).toHaveLength(1); // batched — one ping, never a barrage
    expect(briefing.text).toContain("ONE combined question");
    expect(briefing.text).toContain("CPO 4513 signed by Tamsin");
    expect(briefing.text).toContain("CalCard payment confirmed with Warren");
    expect(briefing.text).toContain("STAKES: miss reconcile → strike from HQ");
    expect(briefing.text).toContain("on_miss: escalate");

    // Building it changed nothing: they are missed only once whoever handed
    // the briefing to the model says so.
    const missed = () =>
      db
        .select()
        .from(expectations)
        .where(and(eq(expectations.userId, U.id), eq(expectations.status, "missed")));
    expect(await missed()).toHaveLength(0);
    expect(briefing.followUps).toHaveLength(2);
    await settleFollowUps(U.id, briefing.followUps);
    expect(await missed()).toHaveLength(2);
    // And they are not raised a second time.
    const next = await buildBriefing(U.id, ctx.timezone, { consumeNudges: true });
    expect(next.text).not.toContain("EXPECTATIONS MISSED");
  });

  it("settling leaves alone a follow-up the user cleared in the meantime", async () => {
    const { result } = await executeTool(ctx, "create_expectation", {
      commitment: "settle-after-clear probe",
      expected_update_by: hoursAgo(2),
      task: "CPO 4513",
    });
    const id = (result as { expectation_id: string }).expectation_id;
    const briefing = await buildBriefing(U.id, ctx.timezone, { consumeNudges: true });
    expect(briefing.followUps).toContain(id);
    // The report lands between the build and the hand-over.
    await executeTool(ctx, "update_task", { task: "CPO 4513", status: "in_progress" });
    await settleFollowUps(U.id, briefing.followUps);
    const [row] = await db.select().from(expectations).where(eq(expectations.id, id));
    expect(row.status).toBe("cleared");
  });

  it("quiet hours hold the ping instead of firing it at the user", async () => {
    await executeTool(ctx, "update_persona", {
      quiet_hours_start: "00:00",
      quiet_hours_end: "23:59", // always quiet, so the test is deterministic
    });
    await executeTool(ctx, "create_expectation", {
      commitment: "quiet-hours probe",
      expected_update_by: hoursAgo(1),
    });
    const briefing = await buildBriefing(U.id, ctx.timezone, { consumeNudges: true });
    expect(briefing.text).toContain("quiet hours");
    expect(briefing.text).toContain("do NOT open with these");
  });
});

describe("isQuietHours", () => {
  const tz = "America/Los_Angeles";
  it("handles windows that wrap midnight", () => {
    const persona = { quiet_hours: { start: "22:00", end: "07:30" } };
    const at = (iso: string) => isQuietHours(persona, new Date(iso), tz);
    expect(at("2026-08-19T06:00:00-07:00")).toBe(true); // 6am inside
    expect(at("2026-08-19T23:30:00-07:00")).toBe(true); // 11:30pm inside
    expect(at("2026-08-19T12:00:00-07:00")).toBe(false); // noon outside
    expect(isQuietHours(null, new Date(), tz)).toBe(false);
  });
});
