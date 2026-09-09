// SPEC §11 fast/slow split + voice modality rule. Transcript failures fixed:
// "A chart I can't draw for you out loud" is now forbidden (paint_canvas is
// how the voice draws), and the mouth carries ONLY thin tools — the store is
// the single truth, written identically from voice and text.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ilike } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, conversations, expectations, memories, tasks, user } from "@/lib/db/schema";
import { applyExtraction } from "@/lib/secretary/extraction";
import { lexiconPrompt } from "@/lib/secretary/lexicon";
import {
  NY_SECRETARY_PERSONA,
  personaDirectives,
  VOICE_MODALITY_RULES,
} from "@/lib/secretary/persona";
import {
  anthropicToolDefs,
  openAIToolDefs,
  openAIVoiceToolDefs,
  VOICE_TOOL_NAMES,
} from "@/lib/secretary/tool-schemas";
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
    expect(names).toContain("show_canvas"); // "open the canvas" without a repaint (§7.6 auto-open)
    expect(names).toContain("consult_brain"); // …and its phone-a-friend for hard questions
    expect(names).toContain("search_history"); // cross-session recall on demand (SPEC §11)
  });

  // Auto-open (SPEC §7.6): the uiAction is shell transport beside the result —
  // the model only ever sees JSON.stringify(outcome.result), so the action
  // must never leak into it.
  it("show_canvas rides all three tool-def builders and its action never reaches the model", async () => {
    expect(VOICE_TOOL_NAMES).toContain("show_canvas");
    expect(openAIToolDefs().some((t) => t.name === "show_canvas")).toBe(true);
    expect(anthropicToolDefs().some((t) => t.name === "show_canvas")).toBe(true);
    const outcome = await executeTool(ctx, "show_canvas", {});
    expect(outcome.uiAction).toEqual({ type: "show_canvas" });
    expect(JSON.stringify(outcome.result)).not.toContain("uiAction");
    expect(JSON.stringify(outcome.result)).not.toContain("show_canvas");
  });

  it("voice search_history carries the time filters for 'what did I say last week?'", () => {
    const def = openAIVoiceToolDefs().find((t) => t.name === "search_history");
    expect(def).toBeTruthy();
    const props = (def?.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(props).toHaveProperty("query");
    expect(props).toHaveProperty("after");
    expect(props).toHaveProperty("before");
  });

  // A change to an existing task ("file that under X") is an amendment, never
  // a second commitment — the thin delegate rides the voice session and both
  // tool-def builders (SPEC §11).
  it("amend_task rides the voice session and both tool-def builders", () => {
    expect(VOICE_TOOL_NAMES).toContain("amend_task");
    const def = openAIVoiceToolDefs().find((t) => t.name === "amend_task");
    expect(def).toBeTruthy();
    expect(def?.description).toContain("EXISTING");
    const params = def?.parameters as { properties?: Record<string, unknown> };
    expect(params.properties).toHaveProperty("task");
    expect(params.properties).toHaveProperty("project");
    expect(openAIToolDefs().some((t) => t.name === "amend_task")).toBe(true);
    expect(anthropicToolDefs().some((t) => t.name === "amend_task")).toBe(true);
    expect(VOICE_MODALITY_RULES).toContain("amend_task");
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

  // Stated facts are fast-path capture (SPEC §11): the mouth saves them live
  // instead of dead-ending with "I can't store that"; the extractor remains
  // the safety net for inferred facts only.
  it("remember_fact rides the voice session with its schema intact", () => {
    expect(VOICE_TOOL_NAMES).toContain("remember_fact");
    const def = openAIVoiceToolDefs().find((t) => t.name === "remember_fact");
    expect(def).toBeTruthy();
    expect(def?.description).toContain("durable fact");
    expect((def?.parameters as { properties?: Record<string, unknown> }).properties).toHaveProperty("fact");
  });

  it("remember_fact inserts a memory and returns the Noted toast", async () => {
    const { result, toast } = await executeTool(ctx, "remember_fact", {
      fact: "My reports go out on Fridays",
      tags: ["work"],
    });
    expect((result as { memory_id?: string }).memory_id).toBeTruthy();
    expect(toast).toEqual({ icon: "◆", text: "Noted: My reports go out on Fridays" });
    const rows = await db.select().from(memories).where(eq(memories.userId, U.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].fact).toBe("My reports go out on Fridays");
    expect(rows[0].tags).toEqual(["work"]);
  });

  it("post-call extraction doesn't duplicate a fact already saved live", async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ userId: U.id, mode: "voice" })
      .returning();
    const summary = await applyExtraction(U.id, conv.id, {
      tasks: [],
      events: [],
      status_updates: [],
      facts: ["The user's reports go out on Fridays"],
      mentions: [],
      ambiguities: [],
    });
    expect(summary.savedFacts).toBe(0);
    const rows = await db.select().from(memories).where(eq(memories.userId, U.id));
    expect(rows).toHaveLength(1); // still just the live-captured row
  });
});

// "That shouldn't be a task" removes it from the checklist on the spot
// (SPEC §11 dropped signal) — paired with remember_fact when it's a rule.
describe("dropped signal: the mouth removes a task the user disowns", () => {
  it("the voice log_status def carries the dropped signal and teaches the remember_fact pairing", () => {
    const def = openAIVoiceToolDefs().find((t) => t.name === "log_status");
    expect(def).toBeTruthy();
    const params = def?.parameters as { properties?: { signal?: { enum?: string[] } } };
    expect(params.properties?.signal?.enum).toContain("dropped");
    expect(def?.description).toContain("dropped");
    expect(def?.description).toContain("remember_fact");
    expect(VOICE_MODALITY_RULES).toContain("signal dropped");
  });

  it("log_status dropped removes the task, writes the audit row, and toasts '✕ Dropped'", async () => {
    await executeTool(ctx, "create_commitment", { title: "Check Caltrans road conditions" });
    const { result, toast } = await executeTool(ctx, "log_status", {
      task: "Caltrans",
      signal: "dropped",
      note: "Not the user's responsibility anymore",
    });
    expect((result as { status?: string }).status).toBe("dropped");
    expect(toast).toEqual({ icon: "✕", text: "Dropped: Check Caltrans road conditions" });
    const [t] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, U.id), ilike(tasks.title, "%Caltrans%")));
    expect(t.status).toBe("dropped");
    const audits = await db
      .select()
      .from(checkins)
      .where(and(eq(checkins.userId, U.id), eq(checkins.taskId, t.id)));
    expect(audits.some((c) => c.note === "Status → dropped")).toBe(true);
  });

  it("drop-then-remember: one memory, and the extractor neither double-writes nor resurrects", async () => {
    // the mouth pairs the drop with the stated rule, live, in the same turn
    await executeTool(ctx, "remember_fact", {
      fact: "Caltrans road checks are not the user's responsibility anymore",
    });
    const before = await db.select().from(memories).where(eq(memories.userId, U.id));

    // the post-call extractor sees the same utterance — nothing may double
    const [conv] = await db
      .insert(conversations)
      .values({ userId: U.id, mode: "voice" })
      .returning();
    const summary = await applyExtraction(U.id, conv.id, {
      tasks: [{ title: "Check Caltrans road conditions", notes: null, due_at: null, project: null }],
      events: [],
      status_updates: [
        { task: "Check Caltrans road conditions", signal: "dropped", new_due_at: null, reason: null },
      ],
      facts: ["The user's Caltrans road checks aren't their responsibility anymore"],
      mentions: [],
      ambiguities: [],
    });
    expect(summary.createdTasks).toBe(0); // the dropped task is not resurrected
    expect(summary.savedFacts).toBe(0); // the live-captured rule is not doubled
    const after = await db.select().from(memories).where(eq(memories.userId, U.id));
    expect(after).toHaveLength(before.length);
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, U.id), ilike(tasks.title, "%Caltrans%")));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("dropped");
  });

  it("a dropped task can be reinstated just by asking", async () => {
    const { result } = await executeTool(ctx, "update_task", { task: "Caltrans", status: "todo" });
    expect((result as { status?: string }).status).toBe("todo");
    const [t] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, U.id), ilike(tasks.title, "%Caltrans%")));
    expect(t.status).toBe("todo");
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

  // The recital failure: "CPO 2073, blocked." A status word is a database row
  // read aloud — the voice names the blocker and what clears it, and asks when
  // it doesn't know. (SPEC §11 voice modality rule.)
  it("outlaws the bare status word and licenses the ONE in-flow question", () => {
    expect(VOICE_MODALITY_RULES).toContain("A STATUS IS NEVER A WORD");
    expect(VOICE_MODALITY_RULES).toContain("stuck ON and what clears it");
    expect(VOICE_MODALITY_RULES).toContain("ASK THEM RIGHT THEN");
    expect(VOICE_MODALITY_RULES).toContain("What's it waiting on?");
    expect(VOICE_MODALITY_RULES).toContain("ONE question that goes in-flow");
  });

  // RISK the plan named: an in-flow licence must not turn pauses into
  // interrogations. The clause has to fence itself.
  it("fences the in-flow licence so it can't erode the silence discipline", () => {
    expect(VOICE_MODALITY_RULES).toContain("This licence changes NOTHING about silence");
    expect(VOICE_MODALITY_RULES).toContain("once per item");
    // everything that is NOT the thing just spoken still goes to the queue
    expect(VOICE_MODALITY_RULES).toContain("still goes to queue_clarification for a natural pause");
    expect(VOICE_MODALITY_RULES).toContain("reason unknown");
  });

  // The contour lives in the character, so the sass<=2 branch stays flat —
  // a robotic register must not start improvising colour about blockers.
  it("puts the human status contour in the character, not the flat registers", () => {
    expect(NY_SECRETARY_PERSONA).toContain("like a person who has been handling it");
    expect(NY_SECRETARY_PERSONA).toContain("what would free it");
    const flat = personaDirectives({ sass: 1 });
    expect(flat).toContain("ROBOTIC");
    expect(flat).not.toContain("what would free it");
  });
});

// A tool schema the Realtime API rejects fails the WHOLE session, and the user
// just sees "Couldn't start the call" with no clue which tool did it. zod
// renders a discriminated union as `oneOf`, which is exactly such a construct —
// this caught it once and exists so it cannot happen silently again.
describe("voice tool schemas stay Realtime-compatible", () => {
  it("uses no construct the Realtime API rejects", () => {
    for (const def of openAIVoiceToolDefs()) {
      const schema = JSON.stringify(def.parameters);
      expect(schema, `${def.name} must not use oneOf`).not.toContain('"oneOf"');
      expect(schema, `${def.name} must not use allOf`).not.toContain('"allOf"');
      expect(schema, `${def.name} must not use $ref`).not.toContain('"$ref"');
    }
  });

  it("bounds every integer, rather than emitting a 2^53 maximum", () => {
    for (const def of openAIVoiceToolDefs()) {
      expect(JSON.stringify(def.parameters), def.name).not.toContain(
        '"maximum":9007199254740991'
      );
    }
  });
});

// The Realtime API caps the transcription prompt at 1024 characters and
// rejects the ENTIRE session request when it is longer. That turned an
// ordinary "the entity store grew" day into "Couldn't start the call" with
// nothing in the UI to explain it — a data-driven outage, not a code change.
describe("the transcription lexicon cannot grow past the API limit", () => {
  it("stays under 1024 characters no matter how many terms exist", () => {
    const many = Array.from({ length: 400 }, (_, i) => `Entity-Name-Number-${i}`);
    const prompt = lexiconPrompt(many);
    expect(prompt).toBeDefined();
    expect(prompt!.length).toBeLessThanOrEqual(1024);
  });

  it("cuts at a whole term rather than mid-word", () => {
    const prompt = lexiconPrompt(Array.from({ length: 400 }, (_, i) => `Term${i}`))!;
    expect(prompt.endsWith(".")).toBe(true);
    const last = prompt.replace(/\.$/, "").split(", ").at(-1)!;
    expect(last).toMatch(/^Term\d+$/);
  });

  it("keeps the most useful terms — the head of the list", () => {
    const prompt = lexiconPrompt(["CPO", "CalCard", ...Array.from({ length: 400 }, (_, i) => `Filler${i}`)])!;
    expect(prompt).toContain("CPO");
    expect(prompt).toContain("CalCard");
  });

  it("still returns nothing when there is no vocabulary", () => {
    expect(lexiconPrompt([])).toBeUndefined();
  });
});
