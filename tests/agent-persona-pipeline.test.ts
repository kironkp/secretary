// SPEC §11 phase: persona_config, stakes, pipeline templates. Every test is a
// beat from the Aug 18 voice transcript (docs/adaptive-ui/transcript-2026-08-18.md)
// that the session got wrong — or right only by luck of context length.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tasks, user } from "@/lib/db/schema";
import { buildBriefing } from "@/lib/secretary/briefing";
import { buildInstructions, personaDirectives } from "@/lib/secretary/persona";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-agent-${crypto.randomUUID()}`, email: `agent-${Date.now()}@p6.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Kiron Fixture", email: U.email, timezone: ctx.timezone });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("persona_config (transcript: 'stern secretary… keep nagging me')", () => {
  it("stores the persona once and applies it to instructions — never re-requested", async () => {
    const { result } = await executeTool(ctx, "update_persona", {
      strictness: "stern",
      tone: "professional",
      followup_aggressiveness: "high",
    });
    expect((result as { stored?: boolean }).stored).toBe(true);

    // a LATER conversation builds instructions from the stored row
    const [row] = await db.select({ persona: user.persona }).from(user).where(eq(user.id, U.id));
    const instructions = buildInstructions("BRIEFING", { persona: row.persona });
    expect(instructions).toContain("STERN");
    expect(instructions).toContain("never ask again");
    expect(instructions).toContain("proactively ask for status");
  });

  it("defaults are sane when nothing is stored — professional, not chummy", () => {
    expect(personaDirectives(null)).toContain("standard");
    expect(personaDirectives(null)).not.toContain("STERN");
    expect(personaDirectives(null)).toContain("professional");
  });

  it("a given name is stored and lands in the directives + transcript labels", async () => {
    await executeTool(ctx, "update_persona", { name: "Dot" });
    const [row] = await db.select({ persona: user.persona }).from(user).where(eq(user.id, U.id));
    expect(row.persona?.name).toBe("Dot");
    expect(personaDirectives(row.persona)).toContain("Your name is Dot");
  });
});

describe("stakes (transcript: reconcile by Sep 8 'so I don't get a strike')", () => {
  it("captures stakes on create and cites them in the overdue briefing", async () => {
    await executeTool(ctx, "create_task", {
      title: "Reconcile and send documents to Caltrans HQ",
      due_at: new Date(Date.now() - 2 * 86400000).toISOString(), // overdue
      stakes: "miss reconcile → strike from HQ",
    });
    const [t] = await db.select().from(tasks).where(eq(tasks.userId, U.id));
    expect(t.stakes).toBe("miss reconcile → strike from HQ");

    const briefing = await buildBriefing(U.id, ctx.timezone);
    expect(briefing.text).toContain("STAKES");
    expect(briefing.text).toContain("strike from HQ");
  });

  it("update_task can set and clear stakes", async () => {
    await executeTool(ctx, "update_task", { task: "Reconcile", stakes: "" });
    const [t] = await db.select().from(tasks).where(eq(tasks.userId, U.id));
    expect(t.stakes).toBeNull();
  });
});

describe("pipeline templates (transcript: update → sign → pay → reconcile+submit)", () => {
  it("saves the CPO template, applies it to a task with dates + dependencies", async () => {
    const save = await executeTool(ctx, "save_pipeline_template", {
      name: "CPO procurement",
      steps: [
        { name: "Update the CPO" },
        { name: "Get it signed (Teresa Mahers, Walter Maiara)", blocked_by: 0 },
        { name: "Pay on the CalCard", blocked_by: 1 },
        { name: "Reconcile + submit to HQ", blocked_by: 2, offset_days: 20 },
      ],
      recurrence: "monthly",
    });
    expect((save.result as { saved?: boolean }).saved).toBe(true);

    await executeTool(ctx, "create_task", { title: "CPO 2073 — production monitor" });
    const apply = await executeTool(ctx, "apply_pipeline", {
      task: "CPO 2073",
      template: "cpo",
      anchor_date: "2026-08-19",
    });
    const r = apply.result as { applied?: boolean; stages?: { name: string; due_at: string | null; blocked_by: number | null }[] };
    expect(r.applied).toBe(true);
    expect(r.stages).toHaveLength(4);
    expect(r.stages![1].blocked_by).toBe(0);
    expect(r.stages![3].due_at).toBe("2026-09-08"); // statement cycle → reconcile deadline
  });

  it("'where am I' reads pipeline state from the store, not memory", async () => {
    // Advance a stage, then read the task fresh — DB is the only truth.
    await executeTool(ctx, "update_task", { task: "CPO 2073", stage_done: "update" });
    const [t] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.userId, U.id))
      .then((rows) => rows.filter((x) => x.title.includes("CPO 2073")));
    const current = t.stages.find((s) => !s.done);
    expect(t.stages[0].done).toBe(true);
    expect(current?.name).toContain("signed");
    expect(current?.blocked_by).toBe(0); // and its blocker is complete
  });

  it("rejects a template whose step is blocked by a later step", async () => {
    const { result } = await executeTool(ctx, "save_pipeline_template", {
      name: "broken",
      steps: [{ name: "a", blocked_by: 1 }, { name: "b" }],
    });
    expect((result as { error?: string }).error).toContain("EARLIER");
  });
});
