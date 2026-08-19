// SPEC §11 fast/slow split + voice modality rule. Transcript failures fixed:
// "A chart I can't draw for you out loud" is now forbidden (paint_canvas is
// how the voice draws), and the mouth carries ONLY thin tools — the store is
// the single truth, written identically from voice and text.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { expectations, tasks, user } from "@/lib/db/schema";
import { VOICE_MODALITY_RULES } from "@/lib/secretary/persona";
import { openAIVoiceToolDefs, VOICE_TOOL_NAMES } from "@/lib/secretary/tool-schemas";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-voice-${crypto.randomUUID()}`, email: `voice-${Date.now()}@p10.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Voice Tester", email: U.email, timezone: ctx.timezone });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("fast/slow split: the mouth is thin", () => {
  it("the realtime session carries ONLY the thin tools — no documents, layout, or project surgery", () => {
    const names = openAIVoiceToolDefs().map((t) => t.name);
    expect(names).toEqual([...VOICE_TOOL_NAMES]);
    for (const heavy of [
      "create_document",
      "edit_document_section",
      "edit_layout_plan",
      "update_project",
      "save_pipeline_template",
      "request_new_component",
    ]) {
      expect(names).not.toContain(heavy);
    }
    expect(names).toContain("paint_canvas"); // the voice's hands for anything visual
  });

  it("create_commitment writes the same store as text (with stakes)", async () => {
    const { result } = await executeTool(ctx, "create_commitment", {
      title: "Update CPO 2073",
      due_at: new Date(Date.now() + 86400000).toISOString(),
      stakes: "miss reconcile → strike from HQ",
    });
    expect((result as { task_id?: string }).task_id).toBeTruthy();
    const [t] = await db.select().from(tasks).where(eq(tasks.userId, U.id));
    expect(t.stakes).toContain("strike");
  });

  it("schedule_checkin creates a real expectation; log_status clears it silently", async () => {
    await executeTool(ctx, "schedule_checkin", {
      commitment: "CPO 2073 updated and Teresa has seen it",
      expected_update_by: new Date(Date.now() + 3600000).toISOString(),
      task: "CPO 2073",
    });
    let [e] = await db.select().from(expectations).where(eq(expectations.userId, U.id));
    expect(e.status).toBe("open");
    expect(e.taskId).toBeTruthy();

    await executeTool(ctx, "log_status", { task: "CPO 2073", signal: "started" });
    [e] = await db.select().from(expectations).where(eq(expectations.userId, U.id));
    expect(e.status).toBe("cleared");
    const [t] = await db.select().from(tasks).where(eq(tasks.userId, U.id));
    expect(t.status).toBe("in_progress");
  });

  it("log_status done completes the task", async () => {
    await executeTool(ctx, "log_status", { task: "CPO 2073", signal: "done" });
    const [t] = await db.select().from(tasks).where(eq(tasks.userId, U.id));
    expect(t.status).toBe("done");
  });
});

describe("voice modality rule", () => {
  it("caps replies, routes visuals to the canvas, and forbids 'I can't draw'", () => {
    expect(VOICE_MODALITY_RULES).toContain("two sentences");
    expect(VOICE_MODALITY_RULES).toContain("ONE question");
    expect(VOICE_MODALITY_RULES).toContain("single next action");
    expect(VOICE_MODALITY_RULES).toContain("paint_canvas");
    expect(VOICE_MODALITY_RULES).toContain("on your screen");
    expect(VOICE_MODALITY_RULES).toContain("FORBIDDEN");
  });

  it("speaks in phone-call register: minimal acks, waits through pauses, no fluff", () => {
    expect(VOICE_MODALITY_RULES).toContain("one word or a short phrase");
    expect(VOICE_MODALITY_RULES).toContain("take your time");
    expect(VOICE_MODALITY_RULES).toContain("do not fill the silence");
    expect(VOICE_MODALITY_RULES).toContain("Not every utterance needs an answer");
    // the exact failure modes from the 2026-08-19 session are named as forbidden
    expect(VOICE_MODALITY_RULES).toContain("It's okay not to know yet");
    expect(VOICE_MODALITY_RULES).toContain("queued a clarification");
  });

  it("outlaws the CPO-call failures: rhetorical screen promises and 'processing' vagueness", () => {
    expect(VOICE_MODALITY_RULES).toContain("SCREEN PROMISES ARE TOOL CALLS");
    expect(VOICE_MODALITY_RULES).toContain("SAME turn");
    expect(VOICE_MODALITY_RULES).toContain("painter reads the recent conversation");
    expect(VOICE_MODALITY_RULES).toContain('"processing"');
    expect(VOICE_MODALITY_RULES).toContain("N tool calls");
    expect(VOICE_MODALITY_RULES).toContain("letter-by-letter");
  });

  it("keeps capture independent of external apps", () => {
    expect(VOICE_MODALITY_RULES).toContain("system of record");
    expect(VOICE_MODALITY_RULES).toContain("cannot fail on someone else's permission");
  });
});
