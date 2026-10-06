// sec plan F1 and F2 (2026-10-06), against the local database with a fake
// model; no live model is ever called.
//
// F1: a rule about how something reads (an answer label, a question, the
// Today line, a lede) drops the piece instead of costing the whole run. In
// production Caltrans was refused for `questions[0].answers[1].label "Not
// yet, do it Friday"` and the $1.50 ceiling left no second attempt. Every
// factual and evidence rule still rejects.
//
// F2: the sweep reads projects most recently used first, judged only by the
// user's own signals, so the daily cap is not spent alphabetically.
process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, messages, conversations, projects, records, tasks, user } from "@/lib/db/schema";
import { dropUnfitPresentation } from "@/lib/understanding/repair";
import { byRecentUse, lastUserActivity, runAll, runProject } from "@/lib/understanding/run";
import type { Bundle, RunOutput } from "@/lib/understanding/types";
import type { ModelCall } from "@/lib/understanding/run";
import { validateRunOutput } from "@/lib/understanding/validate";
import { gatherProject } from "@/lib/understanding/gather";
import { CPO_NOW, CPO_TZ, fakeModel, minimalOutputFor, seedCpoScenario, validOutputFor, type CpoIds } from "./fixtures/understanding";

const PROD_LABEL = "Not yet, do it Friday";
const users: string[] = [];

afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

async function newUser(tag: string): Promise<string> {
  const id = `test-presentation-${tag}-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Presentation", email: `${id}@f1f2.test`, timezone: CPO_TZ });
  return id;
}

/** Every string anywhere in a value: a repair may only remove them, never add one. */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

describe("F1: a piece that reads wrong is dropped; the run lands on one call", () => {
  let userId: string;
  let ids: CpoIds;
  beforeAll(async () => {
    userId = await newUser("replay");
    ids = await seedCpoScenario(userId, CPO_NOW);
  });

  it("the production label on questions[0].answers[1]: stored, that option gone, one model call", async () => {
    let sent: RunOutput | null = null;
    const model = fakeModel((bundle) => {
      const out = validOutputFor(bundle, ids);
      out.questions[0].answers[1].label = PROD_LABEL;
      sent = out;
      return out;
    });
    const result = await runProject(userId, ids.caltrans, { timezone: CPO_TZ, now: CPO_NOW, model, force: true });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(model.calls).toHaveLength(1);
    // The record is the model's, untouched.
    const [row] = await db.select().from(records).where(and(eq(records.userId, userId), eq(records.projectId, ids.caltrans)));
    expect(row.body).toEqual(sent!.record);
    // The question is stored with the other answers and without that one.
    const stored = await db.select().from(clarifications).where(eq(clarifications.userId, userId));
    const labels = stored.flatMap((q) => ((q.answers ?? []) as { label: string }[]).map((a) => a.label));
    expect(labels).not.toContain(PROD_LABEL);
    const first = stored.find((q) => q.question === sent!.questions[0].question)!;
    expect((first.answers as { label: string }[]).map((a) => a.label)).toEqual(
      sent!.questions[0].answers.filter((_, i) => i !== 1).map((a) => a.label)
    );
  });

  it("a claim citing a task that does not exist still rejects, and the run tries again", async () => {
    const model = fakeModel((bundle) => {
      const out = validOutputFor(bundle, ids);
      out.record.rules[0] = { ...out.record.rules[0], sources: [{ type: "task", id: "00000000-0000-4000-8000-000000000000" }] };
      return out;
    });
    const result = await runProject(userId, ids.caltrans, { timezone: CPO_TZ, now: CPO_NOW, model, force: true });
    expect(result.status).toBe("failed");
    expect(model.calls.length).toBeGreaterThan(1);
    expect(model.calls[1].previousErrors.join(" ")).toMatch(/unknown task id/);
  });

  it("a question whose why names none of its evidence still rejects, and the run tries again", async () => {
    const model = fakeModel((bundle) => {
      const out = validOutputFor(bundle, ids);
      out.questions[0].why = "Something here looks off to me.";
      return out;
    });
    const result = await runProject(userId, ids.caltrans, { timezone: CPO_TZ, now: CPO_NOW, model, force: true });
    expect(result.status).toBe("failed");
    expect(model.calls.length).toBeGreaterThan(1);
    expect(model.calls[1].previousErrors.join(" ")).toMatch(/does not name any of its evidence/);
  });

  it("a banned word in the record's own words still rejects: a sourced fact is never dropped", async () => {
    const model = fakeModel((bundle) => {
      const out = validOutputFor(bundle, ids);
      out.record.rules[0] = { ...out.record.rules[0], text: `${out.record.rules[0].text} It is stale.` };
      return out;
    });
    const result = await runProject(userId, ids.caltrans, { timezone: CPO_TZ, now: CPO_NOW, model, force: true });
    expect(result.status).toBe("failed");
    expect(model.calls[1].previousErrors.join(" ")).toMatch(/record\.rules\[0\]\.text: banned word "stale"/);
  });
});

describe("F1 follow-up: a question dropped for how it reads is still asked, so it stays open", () => {
  /** Run 1 stores the scenario's questions; then their first question's evidence is finished. */
  async function askedThenMoved(tag: string) {
    const userId = await newUser(tag);
    const ids = await seedCpoScenario(userId, CPO_NOW);
    let first: RunOutput | null = null;
    const once = fakeModel((bundle) => (first = validOutputFor(bundle, ids)));
    expect((await runProject(userId, ids.caltrans, { timezone: CPO_TZ, now: CPO_NOW, model: once, force: true })).status).toBe("ok");
    const standing = (await db.select().from(clarifications).where(eq(clarifications.userId, userId))).find(
      (q) => q.question === first!.questions[0].question
    )!;
    expect(standing.status).toBe("open");
    // The evidence moves: every task it rests on is finished now.
    const evidenced = first!.questions[0].evidence.filter((e) => e.type === "task").map((e) => e.id);
    for (const id of evidenced) await db.update(tasks).set({ status: "done", completedAt: new Date() }).where(eq(tasks.id, id));
    return { userId, ids, first: first!, standingId: standing.id };
  }

  it("re-asked but dropped for its wording: the standing question is kept open", async () => {
    const { userId, ids, first, standingId } = await askedThenMoved("keep");
    const again = fakeModel((bundle) => {
      const out = validOutputFor(bundle, ids);
      out.questions = [{ ...first.questions[0], question: `${first.questions[0].question} And is that the whole story for all of these?` }];
      return out;
    });
    expect((await runProject(userId, ids.caltrans, { timezone: CPO_TZ, now: CPO_NOW, model: again, force: true })).status).toBe("ok");
    const [row] = await db.select().from(clarifications).where(eq(clarifications.id, standingId));
    expect(row.status).toBe("open");
  });

  it("not asked at all, with its evidence moved: dismissed as before", async () => {
    const { userId, ids, standingId } = await askedThenMoved("gone");
    const without = fakeModel((bundle) => ({ ...validOutputFor(bundle, ids), questions: [] }));
    expect((await runProject(userId, ids.caltrans, { timezone: CPO_TZ, now: CPO_NOW, model: without, force: true })).status).toBe("ok");
    const [row] = await db.select().from(clarifications).where(eq(clarifications.id, standingId));
    expect(row).toMatchObject({ status: "dismissed", resolution: "resolved by a change in the data" });
  });
});

describe("F1: what is dropped, and that nothing is ever added", () => {
  const base = (): Record<string, unknown> => ({
    record: { objective: { text: "Keep the record", sources: [{ type: "task", id: "t1", quote: "Close the old one" }] } },
    questions: [
      {
        kind: "need_to_know",
        question: "CPO 2073 is on your list twice. Close the old one?",
        why: "Two tasks say the same.",
        evidence: [{ type: "task", id: "t1" }],
        answers: [
          { id: "close", label: "Close the old one", writes: [{ op: "drop_task", taskId: "t1" }] },
          { id: "later", label: PROD_LABEL, writes: [{ op: "set_due", taskId: "t1", dueAt: "2026-10-09" }] },
          { id: "keep", label: "Keep them", writes: [{ op: "resolve" }] },
        ],
      },
    ],
    words: { todayLine: "Two things are due today.", ledes: { w1: "One lede. Short." } },
  });

  it("an over-long label drops that answer, never shortened, never rewritten", () => {
    const input = base();
    const { output, drops } = dropUnfitPresentation(input);
    const q = (output as { questions: { answers: { id: string; label: string }[] }[] }).questions[0];
    expect(q.answers.map((a) => a.id)).toEqual(["close", "keep"]);
    expect(drops).toEqual([{ path: "questions[0].answers[1]", why: expect.stringContaining("at most 4 words") }]);
    // Nothing new anywhere: every string out was a string in; quotes untouched.
    const before = new Set(strings(input));
    for (const s of strings(output)) expect(before.has(s), s).toBe(true);
    expect(strings(output)).not.toContain("Not yet");
    expect(input).toEqual(base()); // the input itself is not touched
  });

  it("a code or slash in a label, or a banned word, drops that answer", () => {
    const input = base();
    const answers = (input.questions as { answers: { label: string }[] }[])[0].answers;
    answers[0].label = "Close CPO2073";
    answers[2].label = "Keep it stale";
    const { output } = dropUnfitPresentation(input);
    expect((output as { questions: unknown[] }).questions).toHaveLength(0); // no answer left: the question goes too
  });

  it("a question that reads wrong (too long, a slash, no ending, a promise, a 3-sentence why) is dropped whole", () => {
    for (const change of [
      (q: Record<string, unknown>) => (q.question = "Should I clean up the old CPO 2073 production monitor tasks that still say they are blocked?"),
      (q: Record<string, unknown>) => (q.question = "Close CPO 2073 / Production monitor?"),
      (q: Record<string, unknown>) => (q.question = "Close the old one"),
      (q: Record<string, unknown>) => (q.why = "Two tasks say the same. I'll clear them for you."),
      (q: Record<string, unknown>) => (q.why = "One. Two. Three."),
    ]) {
      const input = base();
      change((input.questions as Record<string, unknown>[])[0]);
      const { output, drops } = dropUnfitPresentation(input);
      expect((output as { questions: unknown[] }).questions, JSON.stringify(drops)).toHaveLength(0);
      expect(drops[0].path).toBe("questions[0]");
    }
  });

  it("a Today line or a lede that reads wrong is dropped; the rest stays", () => {
    const input = base();
    (input.words as Record<string, unknown>).todayLine = "One. Two. Three.";
    (input.words as { ledes: Record<string, string> }).ledes = { w1: "Fine lede.", w2: "It slipped on Monday." };
    const { output } = dropUnfitPresentation(input);
    const words = (output as { words: { todayLine?: string; ledes: Record<string, string> } }).words;
    expect(words.todayLine).toBeUndefined();
    expect(words.ledes).toEqual({ w1: "Fine lede." });
  });

  it("the record, its claims and their quotes are never dropped or changed", () => {
    const input = base();
    (input.record as { objective: { text: string } }).objective.text = "It is stale.";
    const { output, drops } = dropUnfitPresentation(input);
    expect((output as { record: unknown }).record).toEqual(input.record);
    expect(drops.some((d) => d.path.startsWith("record"))).toBe(false);
  });

  it("writes to unknown tasks are not presentation: the answer stays, for the validator to refuse", () => {
    const input = base();
    const answers = (input.questions as { answers: { writes: { taskId?: string }[] }[] }[])[0].answers;
    answers[0].writes[0].taskId = "no-such-task";
    const { output } = dropUnfitPresentation(input);
    const kept = (output as { questions: { answers: { id: string }[] }[] }).questions[0].answers.map((a) => a.id);
    expect(kept).toContain("close");
    expect(validateRunOutput(output, { tasksOpen: [], tasksDone: [] } as unknown as Bundle).ok).toBe(false);
  });
});

describe("F2: the sweep reads the most recently used project first", () => {
  it("only the user's own signals count: their messages, tasks they asked for, their answers", () => {
    const at = (iso: string) => new Date(iso).getTime();
    const bundle = (over: Partial<Bundle>): Bundle =>
      ({ project: { id: "p", name: "P", status: "active" }, messages: [], tasksOpen: [], tasksDone: [], previousRecord: null, ...over }) as Bundle;
    const t = (source: string, createdAt: string) => ({ source, createdAt }) as Bundle["tasksOpen"][number];
    expect(lastUserActivity(bundle({ messages: [{ id: "m", content: "x", mode: "text", createdAt: "2026-10-05T10:00:00Z" }] }))).toBe(at("2026-10-05T10:00:00Z"));
    expect(lastUserActivity(bundle({ tasksOpen: [t("typed", "2026-10-04T10:00:00Z"), t("inferred", "2026-10-06T10:00:00Z"), t("suggested", "2026-10-06T11:00:00Z")] }))).toBe(at("2026-10-04T10:00:00Z"));
    expect(lastUserActivity(bundle({ tasksDone: [t("spoken", "2026-10-03T10:00:00Z")] }))).toBe(at("2026-10-03T10:00:00Z"));
    expect(
      lastUserActivity(bundle({ previousRecord: { asked: [{ questionId: "q", askedAt: "2026-10-01T00:00:00Z", answeredAt: "2026-10-02T10:00:00Z" }] } as Bundle["previousRecord"] }))
    ).toBe(at("2026-10-02T10:00:00Z"));
    expect(lastUserActivity(bundle({ tasksOpen: [t("inferred", "2026-10-06T10:00:00Z")] }))).toBeNull();

    const named = (name: string, activity?: string) =>
      bundle({ project: { id: name, name, status: "active" }, messages: activity ? [{ id: name, content: name, mode: "text", createdAt: activity }] : [] });
    expect(byRecentUse([named("Alpha"), named("Bravo", "2026-10-01T00:00:00Z"), named("Charlie", "2026-10-05T00:00:00Z"), named("Delta")]).map((b) => b.project.name)).toEqual([
      "Charlie",
      "Bravo",
      "Alpha",
      "Delta",
    ]);
  });

  it("under a cap that allows one run, the project the user touched last is the one read", async () => {
    const userId = await newUser("order");
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const [alpha, bravo, charlie] = await db
      .insert(projects)
      .values(["Alpha", "Bravo", "Charlie"].map((name) => ({ userId, name, status: "active" as const })))
      .returning();
    // Alpha: only the app's own work, the newest of all (an extracted task ten minutes ago).
    await db.insert(tasks).values({ userId, projectId: alpha.id, title: "Alpha follow-up", status: "todo", source: "inferred", createdAt: ago(10 * 60_000) });
    // Bravo: a task the user typed two days ago.
    await db.insert(tasks).values({ userId, projectId: bravo.id, title: "Bravo invoice", status: "todo", source: "typed", createdAt: ago(2 * 86_400_000) });
    // Charlie: the user talked about it an hour ago.
    await db.insert(tasks).values({ userId, projectId: charlie.id, title: "Charlie stems", status: "todo", source: "inferred", createdAt: ago(5 * 86_400_000) });
    const [conv] = await db.insert(conversations).values({ userId, mode: "text" }).returning();
    await db.insert(messages).values({ userId, conversationId: conv.id, role: "user", content: "Charlie needs the stems by Friday", mode: "text", createdAt: ago(60 * 60_000) });

    const order = await Promise.all([alpha, bravo, charlie].map((p) => gatherProject(userId, p.id, { now, timezone: CPO_TZ })));
    expect(byRecentUse(order.filter((b): b is Bundle => b !== null)).map((b) => b.project.name)).toEqual(["Charlie", "Bravo", "Alpha"]);

    // A small Opus run, $0.30, as in understanding-spend: under a $1.60 day the
    // first run's $1.50 hold fits, and after it $0.30 + $1.50 does not.
    const calls: string[] = [];
    const model = Object.assign(
      async (input: Parameters<ModelCall>[0]) => {
        calls.push(input.bundle.project.name);
        return { output: minimalOutputFor(input.bundle), model: "claude-opus-5", inputTokens: 20_000, outputTokens: 8_000 };
      },
      { modelName: "claude-opus-5", provider: "anthropic" as const }
    );
    const saved = { daily: process.env.UNDERSTANDING_DAILY_CAP_USD, run: process.env.UNDERSTANDING_RUN_CAP_USD };
    process.env.UNDERSTANDING_DAILY_CAP_USD = "1.6";
    delete process.env.UNDERSTANDING_RUN_CAP_USD;
    try {
      const { results } = await runAll(userId, { timezone: CPO_TZ, now, model });
      expect(calls).toEqual(["Charlie"]);
      expect(results[charlie.id].status).toBe("ok");
      expect(results[alpha.id]).toEqual({ status: "skipped", reason: "budget" });
      expect(results[bravo.id]).toEqual({ status: "skipped", reason: "budget" });
    } finally {
      if (saved.daily === undefined) delete process.env.UNDERSTANDING_DAILY_CAP_USD;
      else process.env.UNDERSTANDING_DAILY_CAP_USD = saved.daily;
      if (saved.run !== undefined) process.env.UNDERSTANDING_RUN_CAP_USD = saved.run;
    }
  });
});
