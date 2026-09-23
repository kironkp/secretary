// docs/understanding/SPEC.md §8 (the sweep), against the local database on
// one throwaway user with two active projects and a fake model. The sweep is
// restricted to this user (opts.userIds) because every other test file's
// user, and the developer's own local data, would otherwise be swept too.
//
// The steps are a sequence: the first sweep writes the records the second
// one skips on, so the order is the point.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, entities, records, understandingRuns, user } from "@/lib/db/schema";
import { checkUnderstandNowQuota } from "@/lib/rate-limit";
import {
  describeProvider,
  hasConnectedAnthropic,
  latestRunPerProject,
  openQuestionCount,
  sweepMinutes,
  sweepUnderstanding,
  tallyResults,
} from "@/lib/understanding/sweep";
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
  id: `test-understanding-sweep-${crypto.randomUUID()}`,
  email: `understanding-sweep-${Date.now()}@p11.test`,
};
const NOW = CPO_NOW;
const TZ = CPO_TZ;
let ids: CpoIds;

const recordRows = () => db.select().from(records).where(eq(records.userId, U.id));

beforeAll(async () => {
  await db
    .insert(user)
    .values({ id: U.id, name: "Understanding Sweep Tester", email: U.email, timezone: TZ });
  ids = await seedCpoScenario(U.id, NOW);
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

/** Run the env-dependent function with one variable set, and put it back after. */
async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
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

describe("sweepUnderstanding", () => {
  const model = fakeModel((bundle) =>
    bundle.project.id === ids.caltrans ? validOutputFor(bundle, ids) : minimalOutputFor(bundle)
  );

  it("(1) runs both active projects of the user and writes two records", async () => {
    const result = await sweepUnderstanding({ now: NOW, model, userIds: [U.id] });
    expect(result).toEqual({ users: 1, ran: 2, skipped: 0, failed: 0, retiredAsr: 0, healed: 0 });
    expect(model.calls).toHaveLength(2);
    const rows = await recordRows();
    expect(rows.map((r) => r.projectId).sort()).toEqual([ids.album, ids.caltrans].sort());
    expect(rows.every((r) => r.version === 1)).toBe(true);
  });

  it("(2) the same data again is skipped on the hash and the model is not called", async () => {
    const result = await sweepUnderstanding({ now: NOW, model, userIds: [U.id] });
    expect(result).toEqual({ users: 1, ran: 0, skipped: 2, failed: 0, retiredAsr: 0, healed: 0 });
    expect(model.calls).toHaveLength(2);
    expect((await recordRows()).every((r) => r.version === 1)).toBe(true);
  });

  it("(3) UNDERSTANDING_DISABLED returns zeros without reading anything", async () => {
    const result = await withEnv("UNDERSTANDING_DISABLED", "true", () =>
      sweepUnderstanding({ now: NOW, model, userIds: [U.id] })
    );
    expect(result).toEqual({ users: 0, ran: 0, skipped: 0, failed: 0, retiredAsr: 0, healed: 0 });
    expect(model.calls).toHaveLength(2);
  });

  it("(4) a second sweep while one is in flight returns zeros at once", async () => {
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

    // A day later, so the local date in the hash changes and both run again.
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    const inFlight = sweepUnderstanding({ now: tomorrow, model: slow, userIds: [U.id] });
    await enteredOnce;
    const second = await sweepUnderstanding({ now: tomorrow, model: slow, userIds: [U.id] });
    expect(second).toEqual({ users: 0, ran: 0, skipped: 0, failed: 0, retiredAsr: 0, healed: 0 });
    expect(slow.calls).toHaveLength(1);

    release();
    const first = await inFlight;
    expect(first).toEqual({ users: 1, ran: 2, skipped: 0, failed: 0, retiredAsr: 0, healed: 0 });
    expect(slow.calls).toHaveLength(2);
    expect((await recordRows()).every((r) => r.version === 2)).toBe(true);
  });

  it("(5) the latest run per project is what Settings reads, one row each", async () => {
    const runs = await db.select().from(understandingRuns).where(eq(understandingRuns.userId, U.id));
    // Two sweeps ran the model: four ok rows; the hash-match skips are not logged.
    expect(runs.filter((r) => r.status === "ok")).toHaveLength(4);

    const latest = await latestRunPerProject(U.id);
    expect(latest.map((p) => p.projectName)).toEqual(["Album", "Caltrans"]);
    for (const p of latest) {
      expect(p.lastStatus).toBe("ok");
      expect(p.lastModel).toBe("fake");
      expect(p.lastInputTokens).toBe(10);
      expect(p.lastOutputTokens).toBe(5);
      expect(p.lastErrors).toEqual([]);
      expect(Number.isNaN(Date.parse(p.lastFinishedAt))).toBe(false);
    }
    // The Caltrans output carried two questions; the Album one none.
    expect(await openQuestionCount(U.id)).toBe(2);
  });

  it("(6) a user with no model available still gets the ASR retire, and no run rows", async () => {
    // An asr_span row whose subject is a confirmed entity's alias: retired by
    // use (SPEC §5). No model is passed and modelCallFor is null under
    // vitest, so this is the keyless branch of the sweep.
    await db.insert(entities).values({
      userId: U.id,
      name: "Walter Maiara",
      kind: "person",
      aliases: ["Walter Myala"],
      confirmed: true,
    });
    const [row] = await db
      .insert(clarifications)
      .values({
        userId: U.id,
        kind: "asr_span",
        subject: "Walter Myala",
        question: "I heard Walter Myala — who is that?",
        status: "open",
      })
      .returning({ id: clarifications.id });
    const runsBefore = (
      await db.select().from(understandingRuns).where(eq(understandingRuns.userId, U.id))
    ).length;

    const result = await sweepUnderstanding({ now: NOW, userIds: [U.id] });
    expect(result).toEqual({ users: 1, ran: 0, skipped: 0, failed: 0, retiredAsr: 1, healed: 0 });

    const [after] = await db
      .select({ status: clarifications.status })
      .from(clarifications)
      .where(eq(clarifications.id, row.id));
    expect(after.status).toBe("dismissed");
    // Skipped whole: not a no-model row per project.
    expect(
      (await db.select().from(understandingRuns).where(eq(understandingRuns.userId, U.id))).length
    ).toBe(runsBefore);
  });

  it("(7) tallyResults maps ok, skipped and failed and ignores dry", () => {
    expect(
      tallyResults({
        a: { status: "ok", recordId: "r", version: 1, questions: { created: [], updated: [], dismissed: [], skippedDuplicates: [], skippedSettled: [], reopened: [] }, ledes: {}, inputTokens: 0, outputTokens: 0 },
        b: { status: "skipped", reason: "unchanged" },
        c: { status: "skipped", reason: "no-model" },
        d: { status: "failed", errors: ["x"] },
      })
    ).toEqual({ ran: 1, skipped: 2, failed: 1 });
  });
});

describe("the configuration Settings shows", () => {
  it("sweepMinutes: default 10, never under 2, never over a day, junk ignored", async () => {
    expect(await withEnv("UNDERSTANDING_SWEEP_MINUTES", undefined, sweepMinutes)).toBe(10);
    expect(await withEnv("UNDERSTANDING_SWEEP_MINUTES", "30", sweepMinutes)).toBe(30);
    expect(await withEnv("UNDERSTANDING_SWEEP_MINUTES", "1", sweepMinutes)).toBe(2);
    expect(await withEnv("UNDERSTANDING_SWEEP_MINUTES", "soon", sweepMinutes)).toBe(10);
    // Past 35791 minutes the delay overflows setInterval and Node would run
    // the sweep every millisecond; the ceiling is a day.
    expect(await withEnv("UNDERSTANDING_SWEEP_MINUTES", "1440", sweepMinutes)).toBe(1440);
    expect(await withEnv("UNDERSTANDING_SWEEP_MINUTES", "100000", sweepMinutes)).toBe(1440);
  });

  it("describeProvider follows UNDERSTANDING_PROVIDER and the keys present, calling nothing", async () => {
    const savedA = process.env.ANTHROPIC_API_KEY;
    const savedO = process.env.OPENAI_API_KEY;
    const savedM = process.env.UNDERSTANDING_MODEL;
    try {
      process.env.ANTHROPIC_API_KEY = "test-key";
      process.env.OPENAI_API_KEY = "test-key";
      delete process.env.UNDERSTANDING_MODEL;
      expect(await withEnv("UNDERSTANDING_PROVIDER", undefined, describeProvider)).toEqual({
        provider: "anthropic",
        model: "claude-sonnet-5",
      });
      expect(await withEnv("UNDERSTANDING_PROVIDER", "openai", describeProvider)).toEqual({
        provider: "openai",
        model: "gpt-5.5",
      });
      delete process.env.ANTHROPIC_API_KEY;
      expect(await withEnv("UNDERSTANDING_PROVIDER", "anthropic", describeProvider)).toEqual({
        provider: "none",
        model: null,
      });
      expect(await withEnv("UNDERSTANDING_PROVIDER", undefined, describeProvider)).toEqual({
        provider: "openai",
        model: "gpt-5.5",
      });
      // A connected Claude account stands in for the house key, the way
      // anthropicFor tries it first.
      expect(
        await withEnv("UNDERSTANDING_PROVIDER", undefined, () =>
          describeProvider({ connectedAnthropic: true })
        )
      ).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
      delete process.env.OPENAI_API_KEY;
      expect(await withEnv("UNDERSTANDING_PROVIDER", undefined, describeProvider)).toEqual({
        provider: "none",
        model: null,
      });
      expect(await hasConnectedAnthropic(U.id)).toBe(false);
    } finally {
      if (savedA === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedA;
      if (savedO === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedO;
      if (savedM === undefined) delete process.env.UNDERSTANDING_MODEL;
      else process.env.UNDERSTANDING_MODEL = savedM;
    }
  });

  it("Understand now is one per user per minute", () => {
    const id = `quota-${crypto.randomUUID()}`;
    const t0 = 1_000_000;
    expect(checkUnderstandNowQuota(id, t0)).toEqual({ ok: true });
    const again = checkUnderstandNowQuota(id, t0 + 10_000);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(429);
    expect(checkUnderstandNowQuota(`${id}-other`, t0 + 10_000)).toEqual({ ok: true });
    expect(checkUnderstandNowQuota(id, t0 + 60_000)).toEqual({ ok: true });
  });
});
