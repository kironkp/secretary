// docs/understanding/SPEC.md §4 (the run), §5 (questions) and §8 (the hash
// sweep), against the local database with a fake model. No test here ever
// calls a live model: runProject takes an injected ModelCall and every test
// hands it one built by tests/fixtures/understanding.ts.
//
// The tests are a sequence on one seeded user: a first run, the same data
// again, a forced re-run, a rejected-then-fixed output, a run that fails
// twice, a change in the data, a resolved question, a dry run, and the sweep.
// Each step asserts on what the previous ones left behind, so the order is
// the point, not an accident.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  clarifications,
  projects,
  records,
  tasks,
  understandingRuns,
  usage,
  user,
} from "@/lib/db/schema";
import { gatherProject, hashBundle } from "@/lib/understanding/gather";
import { questionIdentity } from "@/lib/understanding/questions";
import { runAll, runProject } from "@/lib/understanding/run";
import { QUESTION_KINDS, runOutputSchema, type RunOutput } from "@/lib/understanding/types";
import {
  CPO_NOW,
  CPO_TZ,
  fakeModel,
  minimalOutputFor,
  seedCpoScenario,
  validOutputFor,
  type CpoIds,
} from "./fixtures/understanding";

const U = {
  id: `test-understanding-run-${crypto.randomUUID()}`,
  email: `understanding-run-${Date.now()}@p11.test`,
};
const NOW = CPO_NOW;
const TZ = CPO_TZ;
let ids: CpoIds;

beforeAll(async () => {
  await db
    .insert(user)
    .values({ id: U.id, name: "Understanding Run Tester", email: U.email, timezone: TZ });
  ids = await seedCpoScenario(U.id, NOW);
});

afterAll(async () => {
  // records, clarifications, usage and understanding_runs all cascade from
  // the user.
  await db.delete(user).where(eq(user.id, U.id));
});

const run = (opts: Partial<Parameters<typeof runProject>[2]> = {}) =>
  runProject(U.id, ids.caltrans, { timezone: TZ, now: NOW, ...opts });

const gather = () => gatherProject(U.id, ids.caltrans, { now: NOW, timezone: TZ });

const recordRow = async () => {
  const [row] = await db
    .select()
    .from(records)
    .where(and(eq(records.userId, U.id), eq(records.projectId, ids.caltrans)));
  return row;
};

/** The rows of the three new kinds this user has, whatever their status. */
const questionRows = () =>
  db
    .select()
    .from(clarifications)
    .where(and(eq(clarifications.userId, U.id), inArray(clarifications.kind, [...QUESTION_KINDS])))
    .orderBy(clarifications.createdAt);

const usageRows = () =>
  db
    .select()
    .from(usage)
    .where(and(eq(usage.userId, U.id), eq(usage.kind, "understanding")));

const runRows = () =>
  db
    .select()
    .from(understandingRuns)
    .where(eq(understandingRuns.userId, U.id))
    .orderBy(understandingRuns.startedAt);

describe("runProject on the duplicate-CPO scenario", () => {
  // The output the first run's fake built, so later assertions can compare
  // stored rows against exactly what the model said.
  let firstOutput: RunOutput;
  const first = fakeModel((bundle) => {
    firstOutput = validOutputFor(bundle, ids);
    return firstOutput;
  });
  let firstHash = "";
  let needToKnowId = "";
  let doesntAddUpId = "";

  it("(1) the first run stores version 1 with the bundle's hash, the words, and an empty asked list", async () => {
    const result = await run({ model: first });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(first.calls).toHaveLength(1);
    expect(result.version).toBe(1);
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);

    const row = await recordRow();
    expect(row).toBeDefined();
    expect(row.id).toBe(result.recordId);
    expect(row.version).toBe(1);
    // The hash is of the bundle the model saw...
    firstHash = hashBundle(first.calls[0].bundle);
    expect(row.inputsHash).toBe(firstHash);
    // ...and a fresh gather of unchanged data hashes the same, which is what
    // test (4) relies on. The record's own things widen the terms; none of
    // them may pull a new row into the bundle.
    const again = await gather();
    expect(hashBundle(again!)).toBe(firstHash);

    // The code owns `asked`, not the model (§4, §5).
    expect(row.body.asked).toEqual([]);
    expect(row.body.things.map((t) => t.name)).toEqual(["Production monitor"]);
    expect(row.body.contradictions).toHaveLength(1);

    // The words are stored beside the body, keyed by widget id.
    expect(row.words.ledes).toEqual(firstOutput.words.ledes);
    expect(Object.keys(row.words.ledes).length).toBeGreaterThan(0);
    expect(row.words.todayLine).toBe(firstOutput.words.todayLine);
    expect(result.ledes).toEqual(firstOutput.words.ledes);
    expect(result.todayLine).toBe(firstOutput.words.todayLine);
  });

  it("(2) the model was given every seeded row by its bracketed id and the previous record", async () => {
    const { user: message, system } = first.calls[0];
    for (const id of [ids.doneCpo, ids.blockedCpo, ids.checkCpo, ids.statement]) {
      expect(message).toContain(`[task:${id}]`);
    }
    expect(message).toContain(`[memory:${ids.memStatement}]`);
    expect(message).toContain(`[memory:${ids.memMonthly}]`);
    expect(message).toContain(`[message:${ids.msgFinished}]`);
    expect(message).toContain(`[message:${ids.msgCpo}]`);
    expect(message).toContain(`[expectation:${ids.expectation}]`);
    expect(message).toContain(`[event:${ids.eventLinked}]`);
    expect(message).toContain(`[event:${ids.eventTerm}]`);
    expect(message).toContain(`[document:${ids.document}]`);
    // The other project's rows and the milk message are not this project's.
    expect(message).not.toContain(`[task:${ids.albumOverdue}]`);
    expect(message).not.toContain(`[message:${ids.msgMilk}]`);
    expect(message).not.toContain(`[event:${ids.eventDentist}]`);
    expect(message).toContain("PREVIOUS RECORD");
    expect(message).toContain("none (first run)");
    expect(message).toContain("Caltrans");
    expect(message).toContain(TZ);
    // The system prompt is the understanding prompt, not the extraction one.
    expect(system).toContain("need_to_know");
    expect(system).toContain("doesnt_add_up");
    expect(system).toContain("done_yet");
  });

  it("(3) both questions were created with identity, rank, context = why and their answers", async () => {
    const rows = await questionRows();
    expect(rows).toHaveLength(2);
    const ntk = rows.find((r) => r.kind === "need_to_know")!;
    const dau = rows.find((r) => r.kind === "doesnt_add_up")!;
    expect(ntk).toBeDefined();
    expect(dau).toBeDefined();
    needToKnowId = ntk.id;
    doesntAddUpId = dau.id;

    const ntkDraft = firstOutput.questions.find((q) => q.kind === "need_to_know")!;
    const dauDraft = firstOutput.questions.find((q) => q.kind === "doesnt_add_up")!;

    for (const [row, draft] of [
      [ntk, ntkDraft],
      [dau, dauDraft],
    ] as const) {
      expect(row.status).toBe("open");
      expect(row.projectId).toBe(ids.caltrans);
      expect(row.question).toBe(draft.question);
      expect(row.context).toBe(draft.why);
      expect(row.identity).toBe(questionIdentity(draft));
      expect(row.evidence.map((e) => e.id).sort()).toEqual(
        draft.evidence.map((e) => e.id).sort()
      );
      expect(row.answers.map((a) => a.label)).toEqual(draft.answers.map((a) => a.label));
      expect(row.answers.map((a) => a.writes)).toEqual(draft.answers.map((a) => a.writes));
    }
    // SPEC §5 ranking: the need_to_know with the statement due tomorrow is
    // the hero; the doesnt_add_up sits in the 200s.
    expect(ntk.rank).toBeGreaterThanOrEqual(0);
    expect(ntk.rank).toBeLessThan(100);
    expect(dau.rank).toBeGreaterThanOrEqual(200);
    expect(dau.rank).toBeLessThan(300);
    expect(ntk.rank).toBeLessThan(dau.rank);
  });

  it("(4) the same data again is skipped on the hash with no model call", async () => {
    const result = await run({ model: first });
    expect(result).toEqual({ status: "skipped", reason: "unchanged" });
    expect(first.calls).toHaveLength(1);
    expect((await recordRow()).version).toBe(1);
  });

  it("(5) force runs it anyway and bumps the version; the questions are updated, not re-created", async () => {
    const result = await run({ model: first, force: true });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(first.calls).toHaveLength(2);
    expect(result.version).toBe(2);
    expect(result.questions.created).toEqual([]);
    expect(result.questions.updated.sort()).toEqual([needToKnowId, doesntAddUpId].sort());
    expect(result.questions.dismissed).toEqual([]);
    const row = await recordRow();
    expect(row.version).toBe(2);
    expect(row.inputsHash).toBe(firstHash);
    expect(row.body.asked).toEqual([]);
    expect(await questionRows()).toHaveLength(2);
  });

  it("(6) an unsourced claim is rejected once, the errors are quoted back, and the retry succeeds", async () => {
    const flaky = fakeModel((bundle, call) => {
      const out = validOutputFor(bundle, ids);
      if (call.attempt > 0) return out;
      const thing = out.record.things[0];
      return {
        ...out,
        record: {
          ...out.record,
          things: [{ ...thing, state: { ...thing.state, sources: [] } }],
        },
      };
    });
    const result = await run({ model: flaky, force: true });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.version).toBe(3);
    expect(flaky.calls).toHaveLength(2);
    expect(flaky.calls[0].attempt).toBe(0);
    expect(flaky.calls[0].previousErrors).toEqual([]);
    expect(flaky.calls[1].attempt).toBe(1);
    const errors = flaky.calls[1].previousErrors;
    expect(errors.length).toBeGreaterThan(0);
    // The validator names the path of the empty sources array.
    expect(errors.join("\n")).toContain("things");
    expect(errors.join("\n")).toContain("sources");
    expect((await recordRow()).version).toBe(3);
  });

  it("(7) a model that fails twice leaves the record untouched and logs the failure", async () => {
    const before = await recordRow();
    const broken = fakeModel((bundle) => {
      const out = validOutputFor(bundle, ids);
      return {
        ...out,
        record: {
          ...out.record,
          rules: [
            {
              text: "A rule about a task that does not exist.",
              sources: [{ type: "task", id: "not-a-real-task" }],
              confidence: "high",
            },
          ],
        },
      };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof runProject>>;
    let logged = 0;
    try {
      result = await run({ model: broken, force: true });
      // Read before mockRestore, which clears the spy's calls.
      logged = errorSpy.mock.calls.length;
    } finally {
      errorSpy.mockRestore();
    }
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.join("\n")).toContain("not-a-real-task");
    expect(broken.calls).toHaveLength(2);
    expect(broken.calls[1].previousErrors.join("\n")).toContain("not-a-real-task");
    // SPEC §4: second failure -> keep the previous record, log ONE line, move on.
    expect(logged).toBe(1);

    const after = await recordRow();
    expect(after.version).toBe(before.version);
    expect(after.inputsHash).toBe(before.inputsHash);
    expect(after.body).toEqual(before.body);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());

    const failed = (await runRows()).filter((r) => r.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].projectId).toBe(ids.caltrans);
    expect(failed[0].model).toBe("fake");
    expect(failed[0].errors.join("\n")).toContain("not-a-real-task");
    expect(failed[0].finishedAt.getTime()).toBeGreaterThanOrEqual(failed[0].startedAt.getTime());
  });

  it("(8) every successful run recorded its usage under kind understanding, model fake", async () => {
    const rows = await usageRows();
    // Runs (1), (5) and (6) succeeded.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.model).toBe("fake");
      expect(row.inputTokens).toBeGreaterThanOrEqual(10);
      expect(row.outputTokens).toBeGreaterThanOrEqual(5);
    }
    // And every run so far, ok or failed, left an understanding_runs row.
    const all = await runRows();
    expect(all.filter((r) => r.status === "ok").length).toBeGreaterThanOrEqual(3);
    for (const row of all.filter((r) => r.status === "ok")) {
      expect(row.inputsHash).toBe(firstHash);
      expect(row.model).toBe("fake");
      expect(row.inputTokens).toBeGreaterThanOrEqual(10);
    }
  });

  it("(9) finishing the blocked copy dismisses the duplicate question; a forgotten question with unchanged evidence stays open", async () => {
    // Finished on the database's clock, not the fixture's: the question rows
    // were created at wall-clock time, and syncQuestions dismisses a
    // forgotten question only for a task finished AFTER the row was created.
    // The duplicate question already cited the done copy when it was asked;
    // that copy must not count, this one must.
    const finished = new Date();
    await db
      .update(tasks)
      .set({ status: "done", completedAt: finished, updatedAt: finished, blockedReason: null })
      .where(and(eq(tasks.userId, U.id), eq(tasks.id, ids.blockedCpo)));

    const quiet = fakeModel((bundle) => ({ ...validOutputFor(bundle, ids), questions: [] }));
    // No force: the task's status and updated_at changed, so the hash did.
    const result = await run({ model: quiet });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    expect(quiet.calls).toHaveLength(1);
    expect(quiet.calls[0].bundle.tasksDone.map((t) => t.id)).toContain(ids.blockedCpo);
    expect(result.questions.created).toEqual([]);
    expect(result.questions.updated).toEqual([]);
    expect(result.questions.dismissed).toEqual([doesntAddUpId]);

    const rows = await questionRows();
    const dau = rows.find((r) => r.id === doesntAddUpId)!;
    expect(dau.status).toBe("dismissed");
    expect(dau.resolution).toBe("resolved by a change in the data");
    // The statement is still open and the message is still there: the model
    // merely did not repeat itself, and a question must not flap.
    const ntk = rows.find((r) => r.id === needToKnowId)!;
    expect(ntk.status).toBe("open");
    expect(ntk.resolution).toBeNull();

    const row = await recordRow();
    expect(row.version).toBe(4);
    expect(row.inputsHash).not.toBe(firstHash);
  });

  it("(10) a resolved or dismissed identity is never re-created", async () => {
    await db
      .update(clarifications)
      .set({ status: "resolved", resolution: "Yes, last step" })
      .where(and(eq(clarifications.userId, U.id), eq(clarifications.id, needToKnowId)));

    const again = fakeModel((bundle) => validOutputFor(bundle, ids));
    const result = await run({ model: again, force: true });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    if (result.status !== "ok") return;
    // Both identities closed and every row they rest on is as it was when
    // they closed: the settled guard reports them, in the drafts' order.
    expect(result.questions).toEqual({
      created: [],
      updated: [],
      dismissed: [],
      skippedDuplicates: [],
      skippedSettled: [
        "CPO 2073 is on your list twice?",
        "Is the US Bank statement the last step before CPO 2073 is reconciled?",
      ],
      reopened: [],
    });

    const rows = await questionRows();
    expect(rows).toHaveLength(2);
    const ntk = rows.find((r) => r.id === needToKnowId)!;
    const dau = rows.find((r) => r.id === doesntAddUpId)!;
    expect(ntk.status).toBe("resolved");
    expect(ntk.resolution).toBe("Yes, last step");
    expect(dau.status).toBe("dismissed");
    // The same identities, exactly one row each.
    const drafts = validOutputFor(again.calls[0].bundle, ids).questions;
    for (const [draft, id] of [
      [drafts.find((q) => q.kind === "need_to_know")!, needToKnowId],
      [drafts.find((q) => q.kind === "doesnt_add_up")!, doesntAddUpId],
    ] as const) {
      expect(rows.filter((r) => r.identity === questionIdentity(draft)).map((r) => r.id)).toEqual([id]);
    }
  });

  it("(11) a dry run returns the validated output and writes nothing", async () => {
    const [scratch] = await db
      .insert(projects)
      .values({ userId: U.id, name: "Scratch", status: "active" })
      .returning();
    const [scratchTask] = await db
      .insert(tasks)
      .values({
        userId: U.id,
        projectId: scratch.id,
        title: "Scratch task",
        status: "todo",
        createdAt: new Date(NOW.getTime() - 30 * 86_400_000),
        updatedAt: new Date(NOW.getTime() - 30 * 86_400_000),
      })
      .returning();
    const usageBefore = (await usageRows()).length;
    const runsBefore = (await runRows()).length;
    try {
      const dry = fakeModel((bundle) => ({
        ...minimalOutputFor(bundle),
        questions: [
          {
            kind: "done_yet",
            question: "Is the scratch task done?",
            why: '"Scratch task" has been open for 30 days.',
            evidence: [{ type: "task", id: scratchTask.id }],
            answers: [
              {
                id: "yes-done",
                label: "Yes, done",
                writes: [{ op: "complete_task", taskId: scratchTask.id }, { op: "resolve" }],
              },
              { id: "not-yet", label: "Not yet", writes: [{ op: "resolve" }] },
            ],
          },
        ],
      }));
      const result = await runProject(U.id, scratch.id, {
        timezone: TZ,
        now: NOW,
        model: dry,
        dryRun: true,
      });
      expect(dry.calls).toHaveLength(1);
      expect(result.status, JSON.stringify(result)).toBe("dry");
      if (result.status !== "dry") return;
      // The validated output rides on the result; nothing else changed.
      const output = runOutputSchema.parse(result.output);
      expect(output.questions.map((q) => q.question)).toEqual(["Is the scratch task done?"]);
      expect(output.record.asked).toEqual([]);
      expect(result.model).toBe("fake");
      expect(result.inputsHash).toBe(hashBundle(dry.calls[0].bundle));

      const [record] = await db
        .select({ id: records.id })
        .from(records)
        .where(and(eq(records.userId, U.id), eq(records.projectId, scratch.id)));
      expect(record).toBeUndefined();
      const asked = await db
        .select({ id: clarifications.id })
        .from(clarifications)
        .where(and(eq(clarifications.userId, U.id), eq(clarifications.projectId, scratch.id)));
      expect(asked).toEqual([]);
      expect((await usageRows()).length).toBe(usageBefore);
      expect((await runRows()).length).toBe(runsBefore);
    } finally {
      await db.delete(projects).where(and(eq(projects.userId, U.id), eq(projects.id, scratch.id)));
    }
  });

  it("(12) runAll runs every active project once, retires confirmed ASR rows, and never overlaps itself", async () => {
    // An ASR-kind row whose subject the user has since used in three
    // messages: SPEC §5's "confirmed by use".
    const [asr] = await db
      .insert(clarifications)
      .values({
        userId: U.id,
        kind: "asr_span",
        subject: "CPO",
        question: "I heard CPO — is that CPS, or someone new?",
        status: "open",
      })
      .returning();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const enteredOnce = new Promise<void>((resolve) => (entered = resolve));
    const slow = fakeModel(async (bundle) => {
      entered();
      await gate;
      return bundle.project.id === ids.caltrans
        ? validOutputFor(bundle, ids)
        : minimalOutputFor(bundle);
    });

    const inFlight = runAll(U.id, { timezone: TZ, now: NOW, model: slow, force: true });
    await enteredOnce;
    // The latch: a second sweep for the same user while one is running does
    // nothing and says so.
    const second = await runAll(U.id, { timezone: TZ, now: NOW, model: slow, force: true });
    expect(second).toEqual({ results: {}, retiredAsr: 0, busy: true });
    expect(slow.calls).toHaveLength(1);

    release();
    const done = await inFlight;
    expect(Object.keys(done.results).sort()).toEqual([ids.album, ids.caltrans].sort());
    expect(done.results[ids.caltrans].status, JSON.stringify(done.results)).toBe("ok");
    expect(done.results[ids.album].status, JSON.stringify(done.results)).toBe("ok");
    expect(slow.calls).toHaveLength(2);
    expect(done.retiredAsr).toBe(1);
    const [retired] = await db
      .select({ status: clarifications.status })
      .from(clarifications)
      .where(eq(clarifications.id, asr.id));
    expect(retired.status).toBe("dismissed");

    // The latch released: a third sweep runs, and with nothing changed it
    // skips both projects on the hash.
    const third = await runAll(U.id, { timezone: TZ, now: NOW, model: slow });
    expect(Object.keys(third.results).sort()).toEqual([ids.album, ids.caltrans].sort());
    expect(third.results[ids.caltrans]).toEqual({ status: "skipped", reason: "unchanged" });
    expect(third.results[ids.album]).toEqual({ status: "skipped", reason: "unchanged" });
    expect(slow.calls).toHaveLength(2);

    const [albumRecord] = await db
      .select({ version: records.version })
      .from(records)
      .where(and(eq(records.userId, U.id), eq(records.projectId, ids.album)));
    expect(albumRecord.version).toBe(1);
  });

  it("(13) with no model available the run is skipped and says so, without touching the record", async () => {
    // Both guards at once, so this can never reach a live endpoint whichever
    // one the implementation checks first.
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedDisabled = process.env.UNDERSTANDING_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.UNDERSTANDING_DISABLED = "true";
    const before = await recordRow();
    const runsBefore = (await runRows()).length;
    try {
      const result = await run({ force: true });
      expect(result.status).toBe("skipped");
      if (result.status !== "skipped") return;
      expect(["no-model", "disabled"]).toContain(result.reason);
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedDisabled === undefined) delete process.env.UNDERSTANDING_DISABLED;
      else process.env.UNDERSTANDING_DISABLED = savedDisabled;
    }
    const after = await recordRow();
    expect(after.version).toBe(before.version);
    // A skip for want of a model is logged; a skip on the hash is not.
    const rows = await runRows();
    expect(rows.length).toBe(runsBefore + 1);
    const last = rows[rows.length - 1];
    expect(last.status).toBe("skipped");
    expect(["no-model", "disabled"]).toContain(last.reason);
  });

  it("(14) a dry run with no model available is skipped and writes no run row either", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedDisabled = process.env.UNDERSTANDING_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.UNDERSTANDING_DISABLED = "true";
    const runsBefore = (await runRows()).length;
    try {
      const result = await run({ force: true, dryRun: true });
      expect(result.status).toBe("skipped");
      if (result.status !== "skipped") return;
      expect(["no-model", "disabled"]).toContain(result.reason);
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedDisabled === undefined) delete process.env.UNDERSTANDING_DISABLED;
      else process.env.UNDERSTANDING_DISABLED = savedDisabled;
    }
    // "--dry writes nothing" includes the run log (SPEC §11 phase 2).
    expect((await runRows()).length).toBe(runsBefore);
  });

  it("(15) a database error inside the run is reported as failed, never thrown", async () => {
    // A bundle whose project does not exist: the model answers, validation
    // passes (the rows are real), and the records upsert fails on the
    // project foreign key. That must come back as a result, not a rejection,
    // or one project would end a whole sweep.
    const real = (await gather())!;
    const ghost = { ...real, project: { ...real.project, id: "no-such-project" } };
    const model = fakeModel((bundle) => validOutputFor(bundle, ids));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result: Awaited<ReturnType<typeof runProject>>;
    try {
      result = await runProject(U.id, "no-such-project", {
        timezone: TZ,
        now: NOW,
        model,
        bundle: ghost,
        force: true,
      });
    } finally {
      errorSpy.mockRestore();
    }
    expect(model.calls).toHaveLength(1);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/project|foreign key|violates/i);
  });
});

describe("the backoff after a failed run is for the validator's failures only", () => {
  // Its own project, so the failed rows here never change what the sequence
  // above counted, and the backoff's "last run on these inputs" is this
  // describe's own.
  let projectId = "";
  const runRowsHere = () =>
    db
      .select()
      .from(understandingRuns)
      .where(and(eq(understandingRuns.userId, U.id), eq(understandingRuns.projectId, projectId)))
      .orderBy(understandingRuns.startedAt);
  const sweepRun = (model: Parameters<typeof runProject>[2]["model"]) =>
    runProject(U.id, projectId, { timezone: TZ, now: NOW, model, backoffAfterFailure: true });

  beforeAll(async () => {
    const [project] = await db
      .insert(projects)
      .values({ userId: U.id, name: "Backoff", status: "active" })
      .returning({ id: projects.id });
    projectId = project.id;
    await db.insert(tasks).values({
      userId: U.id,
      projectId,
      title: "Backoff task",
      status: "todo",
      createdAt: new Date(NOW.getTime() - 30 * 86_400_000),
      updatedAt: new Date(NOW.getTime() - 30 * 86_400_000),
    });
  });

  afterAll(async () => {
    await db.delete(projects).where(and(eq(projects.userId, U.id), eq(projects.id, projectId)));
  });

  it("a model that throws (a 429, a cap, a timeout) is tried again on the next sweep", async () => {
    const throwing = fakeModel(() => {
      throw new Error("429 no credits");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await sweepRun(throwing);
      expect(first.status).toBe("failed");
      if (first.status !== "failed") return;
      // Marked as the provider's, apart from the validator's.
      expect(first.errors).toEqual(["model: 429 no credits"]);
      expect(throwing.calls).toHaveLength(2);

      const second = await sweepRun(throwing);
      expect(second.status).toBe("failed");
      expect(throwing.calls).toHaveLength(4);
    } finally {
      errorSpy.mockRestore();
    }
    const rows = await runRowsHere();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "failed")).toBe(true);
    expect(rows[1].errors).toEqual(["model: 429 no credits"]);
  });

  it("a model whose output fails validation twice is not called again on the same inputs within six hours", async () => {
    const broken = fakeModel((bundle) => {
      const out = minimalOutputFor(bundle);
      return {
        ...out,
        record: {
          ...out.record,
          rules: [
            {
              text: "A rule about a task that does not exist.",
              sources: [{ type: "task", id: "not-a-real-task" }],
              confidence: "high",
            },
          ],
        },
      };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await sweepRun(broken);
      expect(first.status).toBe("failed");
      if (first.status !== "failed") return;
      expect(first.errors.join("\n")).toContain("not-a-real-task");
      expect(first.errors.some((e) => e.startsWith("model: "))).toBe(false);
      expect(broken.calls).toHaveLength(2);

      // The sweep again: same inputs, same rejection expected, no call.
      const second = await sweepRun(broken);
      expect(second).toEqual({ status: "skipped", reason: "backoff" });
      expect(broken.calls).toHaveLength(2);

      // A person pressing "Understand now" is asking to try now.
      const forced = await runProject(U.id, projectId, {
        timezone: TZ,
        now: NOW,
        model: broken,
        backoffAfterFailure: true,
        force: true,
      });
      expect(forced.status).toBe("failed");
      expect(broken.calls).toHaveLength(4);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
