// SEC-A001 (2026-10-04): the understanding run's spend, against the local
// database with fake models only. No test here calls a live model; every
// one counts the fake's calls, because a call is what costs money.
//
// From 2026-09-30 to 2026-10-04 production spent about $3 a run, four runs a
// day, all of it Caltrans failing on the same inputs. Kiron: "I am not made
// of money." One describe per cause:
//   - the $5 daily cap never ran for a run handed a model, which every
//     sweep run is;
//   - a failed run was tried again on unchanged inputs every six hours, and
//     after every dyno restart;
//   - a run had no cost ceiling: three attempts cut at 32k output tokens;
//   - the model was told to copy back the asked list the code throws away,
//     and the copy failed the validator.
import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, pushLog, records, tasks, understandingRuns, usage, user } from "@/lib/db/schema";
import { runCapUsd } from "@/lib/spend-guard";
import { gatherProject } from "@/lib/understanding/gather";
import { modelOutputSchema, UNDERSTANDING_SYSTEM } from "@/lib/understanding/prompt";
import { ModelOutputError, runProject, type ModelCall } from "@/lib/understanding/run";
import { sweepUnderstanding } from "@/lib/understanding/sweep";
import { CPO_NOW, CPO_TZ, fakeModel, minimalOutputFor } from "./fixtures/understanding";

const NOW = CPO_NOW;
const TZ = CPO_TZ;
const userIds: string[] = [];

afterAll(async () => {
  // Projects, tasks, records, usage and understanding_runs cascade from the user.
  if (userIds.length > 0) await db.delete(user).where(inArray(user.id, userIds));
});

/** A throwaway user with `n` active projects, each holding one open task. */
async function seedUser(n: number): Promise<{ userId: string; projectIds: string[] }> {
  const userId = `test-understanding-spend-${crypto.randomUUID()}`;
  userIds.push(userId);
  await db
    .insert(user)
    .values({ id: userId, name: "Spend Tester", email: `${userId}@sec-a001.test`, timezone: TZ });
  const projectIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const [p] = await db
      .insert(projects)
      .values({ userId, name: `Spend project ${i + 1}`, status: "active" })
      .returning({ id: projects.id });
    await db.insert(tasks).values({
      userId,
      projectId: p.id,
      title: `Spend task ${i + 1}`,
      status: "todo",
      createdAt: new Date(NOW.getTime() - 30 * 86_400_000),
      updatedAt: new Date(NOW.getTime() - 30 * 86_400_000),
    });
    projectIds.push(p.id);
  }
  return { userId, projectIds };
}

/** Run with one variable set, and put it back after. */
async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/** The "Background reading paused" pushes claimed for this user (one key per UTC day). */
const capPushes = (userId: string) =>
  db
    .select()
    .from(pushLog)
    .where(and(eq(pushLog.userId, userId), like(pushLog.key, "understanding-cap:%")));

const runRowsFor = (userId: string, projectId: string) =>
  db
    .select()
    .from(understandingRuns)
    .where(and(eq(understandingRuns.userId, userId), eq(understandingRuns.projectId, projectId)))
    .orderBy(understandingRuns.startedAt);

/** An output the validator refuses: a rule citing a task that does not exist. */
const refusedOutput = (bundle: Parameters<typeof minimalOutputFor>[0]) => {
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
};

describe("2a: the daily cap holds for every run", () => {
  it("a sweep run, which is handed its model, is refused when the day's spend plus the run's ceiling passes the cap", async () => {
    const { userId, projectIds } = await seedUser(1);
    // $3.50 spent: under the $5 cap on its own, over it with a $2 run on top.
    await db.insert(usage).values({
      userId,
      kind: "understanding",
      model: "claude-opus-5",
      costUsd: "3.500000",
      createdAt: new Date(Date.now() - 3600_000),
    });
    const model = fakeModel((bundle) => minimalOutputFor(bundle));

    const result = await withEnv("UNDERSTANDING_DAILY_CAP_USD", undefined, () =>
      withEnv("UNDERSTANDING_RUN_CAP_USD", undefined, () =>
        sweepUnderstanding({ now: NOW, model, userIds: [userId] })
      )
    );

    expect(model.calls).toHaveLength(0);
    expect(result).toMatchObject({ users: 1, ran: 0, skipped: 1, failed: 0 });
    const rows = await runRowsFor(userId, projectIds[0]);
    expect(rows.map((r) => [r.status, r.reason])).toEqual([["skipped", "budget"]]);
  });

  it("a sweep across four projects spends at most the cap: three $1.50 runs, the fourth refused, and the next sweep calls nothing", async () => {
    const { userId, projectIds } = await seedUser(4);
    const calls: string[] = [];
    // Opus 5: 140k input tokens at $5/M and 32k output at $25/M is $1.50 a run.
    const billing = Object.assign(
      async (input: Parameters<ModelCall>[0]) => {
        calls.push(input.bundle.project.id);
        return {
          output: minimalOutputFor(input.bundle),
          model: "claude-opus-5",
          inputTokens: 140_000,
          outputTokens: 32_000,
        };
      },
      { modelName: "claude-opus-5", provider: "anthropic" as const }
    );

    const sweep = () =>
      withEnv("UNDERSTANDING_DAILY_CAP_USD", undefined, () =>
        withEnv("UNDERSTANDING_RUN_CAP_USD", undefined, () =>
          sweepUnderstanding({ now: NOW, model: billing, userIds: [userId] })
        )
      );

    // $0, $1.50, $3.00 each leave room for a $2 run under $5; $4.50 does not.
    const first = await sweep();
    expect(first).toMatchObject({ users: 1, ran: 3, skipped: 1, failed: 0 });
    expect(calls).toHaveLength(3);
    const spent = await db.select({ usd: usage.costUsd }).from(usage).where(eq(usage.userId, userId));
    expect(spent.reduce((n, r) => n + Number(r.usd), 0)).toBeCloseTo(4.5);

    // Straight after: three unchanged, the fourth still over; no call at all.
    const second = await sweep();
    expect(second).toMatchObject({ users: 1, ran: 0, skipped: 4, failed: 0 });
    expect(calls).toHaveLength(3);
    const refused = projectIds.filter((p) => !calls.includes(p));
    expect(refused).toHaveLength(1);
    // Refused twice, logged once: a sweep every ten minutes over the cap
    // must not write a row per project per sweep.
    const rows = await runRowsFor(userId, refused[0]);
    expect(rows.map((r) => r.reason)).toEqual(["budget"]);
    // Over the cap on what was really spent: the user is told, once.
    expect(await capPushes(userId)).toHaveLength(1);
  });

  it("two runs started in the same tick cannot both start under a cap that holds one", async () => {
    const { userId, projectIds } = await seedUser(2);
    const model = fakeModel((bundle) => minimalOutputFor(bundle));
    // Gathered up front, as runAll hands them down, so neither run's gather
    // lets the other finish first: both reach the cap check together.
    const bundles = await Promise.all(
      projectIds.map((p) => gatherProject(userId, p, { now: NOW, timezone: TZ }))
    );
    const results = await withEnv("UNDERSTANDING_DAILY_CAP_USD", "3", () =>
      withEnv("UNDERSTANDING_RUN_CAP_USD", undefined, () =>
        Promise.all(
          projectIds.map((p, i) =>
            runProject(userId, p, { timezone: TZ, now: NOW, model, bundle: bundles[i] ?? undefined })
          )
        )
      )
    );
    expect(results.map((r) => r.status).sort()).toEqual(["ok", "skipped"]);
    expect(results.find((r) => r.status === "skipped")).toEqual({ status: "skipped", reason: "budget" });
    expect(model.calls).toHaveLength(1);
  });

  it("a daily cap under the run ceiling still reads: the run's ceiling is cut to the cap", async () => {
    const { userId, projectIds } = await seedUser(2);
    const calls: string[] = [];
    // A small Opus run: 20k in, 8k out, $0.30.
    const small = Object.assign(
      async (input: Parameters<ModelCall>[0]) => {
        calls.push(input.bundle.project.id);
        return { output: minimalOutputFor(input.bundle), model: "claude-opus-5", inputTokens: 20_000, outputTokens: 8_000 };
      },
      { modelName: "claude-opus-5", provider: "anthropic" as const }
    );
    await withEnv("UNDERSTANDING_DAILY_CAP_USD", "1", () =>
      withEnv("UNDERSTANDING_RUN_CAP_USD", undefined, async () => {
        expect(runCapUsd()).toBe(1);
        const first = await runProject(userId, projectIds[0], { timezone: TZ, now: NOW, model: small });
        expect(first.status).toBe("ok");
        // $0.30 spent plus a $1 run would pass $1.
        const second = await runProject(userId, projectIds[1], { timezone: TZ, now: NOW, model: small });
        expect(second).toEqual({ status: "skipped", reason: "budget" });
      })
    );
    expect(calls).toEqual([projectIds[0]]);
  });

  it("a cap of 0 turns runs off, daily or per run", async () => {
    const { userId, projectIds } = await seedUser(1);
    const model = fakeModel((bundle) => minimalOutputFor(bundle));
    const run = () => runProject(userId, projectIds[0], { timezone: TZ, now: NOW, model });
    const daily = await withEnv("UNDERSTANDING_DAILY_CAP_USD", "0", run);
    const perRun = await withEnv("UNDERSTANDING_RUN_CAP_USD", "0", run);
    expect(daily).toEqual({ status: "skipped", reason: "budget" });
    expect(perRun).toEqual({ status: "skipped", reason: "budget" });
    expect(model.calls).toHaveLength(0);
  });

  it("two runs that start together are counted together: the second is refused while the first holds its ceiling", async () => {
    const { userId, projectIds } = await seedUser(2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const slow = fakeModel(async (bundle) => {
      entered();
      await gate;
      return minimalOutputFor(bundle);
    });
    const other = fakeModel((bundle) => minimalOutputFor(bundle));

    // A $3 cap holds one $2 run, not two. Nothing spent yet.
    await withEnv("UNDERSTANDING_DAILY_CAP_USD", "3", () =>
      withEnv("UNDERSTANDING_RUN_CAP_USD", undefined, async () => {
        const first = runProject(userId, projectIds[0], { timezone: TZ, now: NOW, model: slow });
        await inside;
        const second = await runProject(userId, projectIds[1], { timezone: TZ, now: NOW, model: other });
        expect(second).toEqual({ status: "skipped", reason: "budget" });
        expect(other.calls).toHaveLength(0);
        // $0 spent: the second run waits on the first, which is a queue,
        // not "Background reading paused".
        expect(await capPushes(userId)).toHaveLength(0);

        release();
        expect((await first).status).toBe("ok");
        expect(slow.calls).toHaveLength(1);

        // The first run gave its hold back: what it really spent is pennies.
        const third = await runProject(userId, projectIds[1], { timezone: TZ, now: NOW, model: other });
        expect(third.status).toBe("ok");
        expect(other.calls).toHaveLength(1);
      })
    );
  });
});

describe("2b: unchanged inputs never pay for a second run", () => {
  const sweepRun = (userId: string, projectId: string, model: ModelCall) =>
    runProject(userId, projectId, { timezone: TZ, now: NOW, model, backoffAfterFailure: true });

  it("a refused run is not tried again on the same inputs: not hours later, not after a restart, not after a budget skip", async () => {
    const { userId, projectIds } = await seedUser(1);
    const projectId = projectIds[0];
    const broken = fakeModel((bundle) => refusedOutput(bundle));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await sweepRun(userId, projectId, broken);
      expect(first.status).toBe("failed");
      expect(broken.calls).toHaveLength(3);

      // Seven hours on: past the old six-hour backoff, and before this
      // process started, which the old backoff also let through.
      const [failed] = await runRowsFor(userId, projectId);
      const earlier = new Date(Date.now() - 7 * 3600_000);
      await db
        .update(understandingRuns)
        .set({ startedAt: earlier, finishedAt: earlier })
        .where(eq(understandingRuns.id, failed.id));
      // And a later row on the same inputs that is not a failure.
      await db.insert(understandingRuns).values({
        userId,
        projectId,
        status: "skipped",
        reason: "budget",
        inputsHash: failed.inputsHash,
      });

      const second = await sweepRun(userId, projectId, broken);
      expect(second).toEqual({ status: "skipped", reason: "backoff" });
      expect(broken.calls).toHaveLength(3);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("a billed run whose last attempt the provider cut off is not tried again on the same inputs", async () => {
    const { userId, projectIds } = await seedUser(1);
    // Production, 2026-10-01 15:27: two answers billed, then the stream was
    // "terminated"; logged as a provider failure, so the next sweep paid
    // $3.11 for the same inputs twenty minutes later.
    const cutOff = fakeModel((_bundle, call) => {
      if (call.attempt < 2) {
        throw new ModelOutputError("claude output is not JSON (stop_reason max_tokens): Unexpected end", {
          model: "fake-cut",
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
        });
      }
      throw new Error("terminated");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await sweepRun(userId, projectIds[0], cutOff);
      expect(first.status).toBe("failed");
      if (first.status !== "failed") return;
      expect(first.errors.every((e) => e.startsWith("model: "))).toBe(true);
      expect(cutOff.calls).toHaveLength(3);

      const second = await sweepRun(userId, projectIds[0], cutOff);
      expect(second).toEqual({ status: "skipped", reason: "backoff" });
      expect(cutOff.calls).toHaveLength(3);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("2c: one run has a cost ceiling", () => {
  /** Claude Opus 5 cut at max_tokens on every attempt, billed like the real thing. */
  function opusCutShort() {
    const calls: number[] = [];
    const fn = async (input: Parameters<ModelCall>[0]): Promise<never> => {
      calls.push(input.attempt);
      throw new ModelOutputError("claude output is not JSON (stop_reason max_tokens): Unterminated string", {
        model: "claude-opus-5",
        // About four characters a token, as Claude counts English and JSON.
        inputTokens: Math.ceil((input.system.length + input.user.length) / 4),
        cachedInputTokens: 0,
        outputTokens: 32_000,
      });
    };
    return Object.assign(fn, { calls, modelName: "claude-opus-5", provider: "anthropic" as const });
  }

  it("attempts stop before one could take the run past UNDERSTANDING_RUN_CAP_USD, and the run's bill stays under it", async () => {
    const { userId, projectIds } = await seedUser(1);
    const model = opusCutShort();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await withEnv("UNDERSTANDING_RUN_CAP_USD", undefined, () =>
        runProject(userId, projectIds[0], { timezone: TZ, now: NOW, model })
      );
      expect(result.status).toBe("failed");
      if (result.status !== "failed") return;
      // About $0.85 an attempt: two fit under $2, a third could not.
      expect(model.calls).toEqual([0, 1]);
      expect(result.errors.some((e) => e.startsWith("run cost ceiling: attempt 3"))).toBe(true);
      const [row] = await db.select().from(usage).where(eq(usage.userId, userId));
      expect(row.outputTokens).toBe(64_000);
      expect(Number(row.costUsd)).toBeLessThanOrEqual(runCapUsd());
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("a run whose first attempt alone could pass the ceiling never calls the model", async () => {
    const { userId, projectIds } = await seedUser(1);
    const model = opusCutShort();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await withEnv("UNDERSTANDING_RUN_CAP_USD", "0.5", () =>
        runProject(userId, projectIds[0], { timezone: TZ, now: NOW, model })
      );
      expect(result.status).toBe("failed");
      expect(model.calls).toEqual([]);
      expect(await db.select().from(usage).where(eq(usage.userId, userId))).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("2c: the asked list is not the model's to write", () => {
  it("the prompt and the schema no longer ask for it", () => {
    expect(UNDERSTANDING_SYSTEM).not.toContain("Copy the previous record's asked list");
    expect("asked" in modelOutputSchema.shape.record.shape).toBe(false);
  });

  it("an asked list the model writes anyway is ignored, even one the validator would refuse", async () => {
    const { userId, projectIds } = await seedUser(1);
    // Caltrans's stored record holds an answer of 1,015 characters, five
    // past the schema's limit; copied back as told, it failed every attempt.
    const copying = fakeModel((bundle) => {
      const out = minimalOutputFor(bundle);
      return {
        ...out,
        record: {
          ...out.record,
          asked: [{ questionId: "q-long", askedAt: "2026-09-20T10:00:00Z", answer: "x".repeat(1015) }],
        },
      };
    });
    const result = await runProject(userId, projectIds[0], { timezone: TZ, now: NOW, model: copying });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(copying.calls).toHaveLength(1);
    const [row] = await db
      .select({ body: records.body })
      .from(records)
      .where(and(eq(records.userId, userId), eq(records.projectId, projectIds[0])));
    expect(row.body.asked).toEqual([]);
  });
});
