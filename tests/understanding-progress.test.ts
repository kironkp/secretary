// docs/understanding/SPEC.md §8: the progress channel a run publishes to
// (lib/understanding/progress.ts), the provider memory the calls write and
// the routes read (lib/understanding/provider-health.ts), and the GET that
// hands both to the screen. Against the local database on one throwaway
// user seeded with the duplicate-CPO scenario, with fake models that throw
// what the real providers said on 2026-09-23. No live model, ever.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { understandingRuns, user } from "@/lib/db/schema";
import {
  RECENT_MAX,
  RECENT_MS,
  displayModelName,
  failedLines,
  finish,
  okLines,
  resetProgress,
  setProgressClock,
  snapshot,
  subscribeProgress,
  type ProgressEvent,
} from "@/lib/understanding/progress";
import {
  MODEL_ERROR_PREFIX,
  PROVIDER_ACTION,
  classifyProviderError,
  describeHealth,
  noteProviderFailure,
  noteProviderOk,
  outageLine,
  providerHealth,
  providerLine,
  resetProviderMemory,
} from "@/lib/understanding/provider-health";
import { runProject, type ModelCall } from "@/lib/understanding/run";
import {
  CPO_NOW,
  CPO_TZ,
  fakeModel,
  seedCpoScenario,
  validOutputFor,
  type CpoIds,
} from "./fixtures/understanding";

// Session guard mocked for the route (no request scope in tests); auth
// stubbed so the real betterAuth instance never builds inside vitest.
const sessionUser = vi.hoisted(() => ({ id: "", email: "", name: "Progress Tester", timezone: "America/Los_Angeles" }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, requireSession: vi.fn(async () => sessionUser) };
});

const U = {
  id: `test-understanding-progress-${crypto.randomUUID()}`,
  email: `understanding-progress-${Date.now()}@p11.test`,
};
const NOW = CPO_NOW;
const TZ = CPO_TZ;
let ids: CpoIds;

/** Both SDKs put the status first; these are the messages seen on 2026-09-23. */
const OPENAI_NO_CREDITS = "429 You have no credits remaining.";
const CLAUDE_CAPPED =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC."}}';

beforeAll(async () => {
  sessionUser.id = U.id;
  sessionUser.email = U.email;
  await db
    .insert(user)
    .values({ id: U.id, name: "Understanding Progress Tester", email: U.email, timezone: TZ });
  ids = await seedCpoScenario(U.id, NOW);
});

afterAll(async () => {
  setProgressClock(null);
  await db.delete(user).where(eq(user.id, U.id));
});

/** Run the env-dependent code with these variables set (undefined deletes), and put them back after. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every event the channel emits while `fn` runs. */
async function eventsDuring(fn: () => Promise<unknown>): Promise<ProgressEvent[]> {
  const events: ProgressEvent[] = [];
  const stop = subscribeProgress((e) => {
    if (e.userId === U.id) events.push(e);
  });
  try {
    await fn();
  } finally {
    stop();
  }
  return events;
}

const run = (opts: Partial<Parameters<typeof runProject>[2]> = {}) =>
  runProject(U.id, ids.caltrans, { timezone: TZ, now: NOW, ...opts });

const runRows = () =>
  db
    .select()
    .from(understandingRuns)
    .where(eq(understandingRuns.userId, U.id))
    .orderBy(understandingRuns.startedAt);

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

// --------------------------------------------------------------------------
// The phases a run publishes
// --------------------------------------------------------------------------

describe("the phases a run publishes", () => {
  it("(1) gathering, reading, checking, storing, then ok with the questions it made, in that order", async () => {
    resetProgress();
    const model = fakeModel((bundle) => validOutputFor(bundle, ids));
    const events = await eventsDuring(async () => {
      const result = await run({ model });
      expect(result.status, JSON.stringify(result)).toBe("ok");
    });

    expect(events.map((e) => (e.kind === "active" ? e.entry.phase : e.kind))).toEqual([
      "gathering",
      "reading",
      "checking",
      "storing",
      "finished",
    ]);
    for (const e of events) expect(e.projectId).toBe(ids.caltrans);

    const [gathering, reading, checking, storing, finished] = events;
    if (gathering.kind !== "active" || reading.kind !== "active" || checking.kind !== "active" || storing.kind !== "active" || finished.kind !== "finished") {
      throw new Error("unexpected event kinds");
    }
    expect(gathering.entry.projectName).toBe("Caltrans");
    expect(gathering.entry.line).toBe("Reading Caltrans");
    // The counts are the bundle's: 4 tasks (3 open, 1 done), the 4 CPO
    // messages, 2 memories, 2 events, 1 expectation in the seeded scenario.
    const b = model.calls[0].bundle;
    const word = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const parts = [
      word(b.tasksOpen.length + b.tasksDone.length, "task", "tasks"),
      word(b.messages.length, "message", "messages"),
      word(b.memories.length, "memory", "memories"),
    ];
    if (b.events.length) parts.push(word(b.events.length, "event", "events"));
    if (b.expectations.length) parts.push(word(b.expectations.length, "expectation", "expectations"));
    expect(gathering.entry.detail).toBe(parts.join(", "));
    expect(gathering.entry.detail).toContain("4 tasks");
    expect(gathering.entry.detail).toContain("2 memories");
    expect(gathering.entry.detail).toContain("1 expectation");

    // A fake names no model, so the line is the bare one; no retry, so the
    // detail is the gather's counts alone.
    expect(reading.entry).toMatchObject({ phase: "reading", line: "Thinking", detail: gathering.entry.detail });
    expect(checking.entry).toMatchObject({ phase: "checking", line: "Checking what it wrote", detail: null });
    expect(storing.entry).toMatchObject({ phase: "storing", line: "Writing the record", detail: null });
    // startedAt is the first publish of the run; updatedAt moves with each phase.
    expect(storing.entry.startedAt).toBe(gathering.entry.startedAt);
    expect(Date.parse(storing.entry.updatedAt)).toBeGreaterThanOrEqual(Date.parse(gathering.entry.updatedAt));

    expect(finished.entry).toMatchObject({
      projectName: "Caltrans",
      status: "ok",
      line: "Read Caltrans",
      detail: "2 new questions",
      reason: null,
    });

    // The snapshot afterwards: nothing in flight, the finish in recent.
    const snap = snapshot(U.id);
    expect(snap.active).toEqual([]);
    expect(snap.recent).toHaveLength(1);
    expect(snap.recent[0]).toEqual(finished.entry);
  });

  it("(2) a call that names its model is 'Thinking with Claude Sonnet 5'; a retry says which attempt; an update counts as updated", async () => {
    const flaky = fakeModel((bundle, call) => {
      const out = validOutputFor(bundle, ids);
      if (call.attempt > 0) return out;
      const thing = out.record.things[0];
      return { ...out, record: { ...out.record, things: [{ ...thing, state: { ...thing.state, sources: [] } }] } };
    });
    const named: ModelCall = Object.assign(flaky, { modelName: "claude-sonnet-5" });
    const events = await eventsDuring(async () => {
      const result = await run({ model: named, force: true });
      expect(result.status, JSON.stringify(result)).toBe("ok");
    });
    const readings = events.flatMap((e) => (e.kind === "active" && e.entry.phase === "reading" ? [e.entry] : []));
    // The counts from the gather ride on every reading line (the screen
    // sees this line for a minute, the gathering one for a blink); a retry
    // says which attempt first. "attempt 2 of N": N is run.ts MAX_ATTEMPTS,
    // which this test does not fix.
    expect(readings.map((r) => [r.line, r.detail])).toEqual([
      ["Thinking with Claude Sonnet 5", expect.stringMatching(/^\d+ tasks?, \d+ messages?, \d+ memor/)],
      ["Thinking with Claude Sonnet 5", expect.stringMatching(/^attempt 2 of \d+ · \d+ tasks?, /)],
    ]);
    const finished = events.find((e) => e.kind === "finished");
    expect(finished?.kind === "finished" && finished.entry).toMatchObject({
      status: "ok",
      line: "Read Caltrans",
      detail: "2 updated",
    });
  });

  it("(3) a model with no credits: the run fails as no-credits, the row says which provider, and reading is paused", async () => {
    resetProviderMemory();
    const broke = fakeModel(() => {
      throw new Error(OPENAI_NO_CREDITS);
    });
    const spy = quiet();
    let events: ProgressEvent[];
    try {
      events = await eventsDuring(async () => {
        const result = await run({ model: broke, force: true });
        expect(result.status).toBe("failed");
      });
    } finally {
      spy.mockRestore();
    }
    // Every attempt (run.ts MAX_ATTEMPTS) was spent at the provider.
    expect(broke.calls.length).toBeGreaterThanOrEqual(2);
    const finished = events.find((e) => e.kind === "finished");
    expect(finished?.kind === "finished" && finished.entry).toMatchObject({
      status: "failed",
      line: "Could not read Caltrans",
      detail: "the model has no credits",
      reason: "no-credits",
    });
    expect(snapshot(U.id).active).toEqual([]);
    expect(snapshot(U.id).recent[0]).toMatchObject({ status: "failed", reason: "no-credits" });

    // The row names the provider the wording implies, after the prefix the
    // backoff reads, once (both attempts said the same thing).
    const failed = (await runRows()).filter((r) => r.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].errors).toEqual([`${MODEL_ERROR_PREFIX}openai: ${OPENAI_NO_CREDITS}`]);

    // With only an OpenAI key, the provider object says so in one clause.
    const health = await withEnv(
      { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: "test-key", UNDERSTANDING_PROVIDER: undefined },
      () => providerHealth(U.id)
    );
    expect(health.openai).toEqual({ state: "no-credits", until: null, connected: false });
    expect(health.anthropic).toEqual({ state: "missing", until: null, connected: false });
    expect(health.ok).toBe(false);
    expect(health.line).toBe("Reading is paused: the model has no credits.");
    expect(health.action).toBe("Add credits, raise the limit, or connect your own key in Settings.");
    expect(health.action).toBe(PROVIDER_ACTION);
  });

  it("(4) the Claude cap is capped until the day it names, and with both keys the line names both", async () => {
    // The literal message from 2026-09-23 parses to the day it names, UTC.
    expect(classifyProviderError(CLAUDE_CAPPED)).toEqual({
      state: "capped",
      until: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(classifyProviderError("400 You have reached your specified API usage limits.")).toEqual({
      state: "capped",
      until: null,
    });

    // The memory ages a cap out on its day, so the health check uses one
    // thirty days ahead of whenever this runs.
    const ahead = new Date(Date.now() + 30 * 86_400_000);
    const day = ahead.toISOString().slice(0, 10);
    const message = CLAUDE_CAPPED.replace("2026-10-01", day);
    expect(noteProviderFailure("anthropic", message)).toEqual({
      state: "capped",
      until: new Date(`${day}T00:00:00.000Z`),
    });

    const both = { ANTHROPIC_API_KEY: "test-key", OPENAI_API_KEY: "test-key", UNDERSTANDING_PROVIDER: undefined };
    const health = await withEnv(both, () => providerHealth(U.id));
    expect(health.anthropic).toEqual({ state: "capped", until: `${day}T00:00:00.000Z`, connected: false });
    expect(health.openai.state).toBe("no-credits");
    expect(health.ok).toBe(false);
    const resets = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(ahead);
    expect(health.line).toBe(`Reading is paused: the Claude limit resets on ${resets} and OpenAI has no credits.`);
    expect(await withEnv(both, () => providerLine(U.id))).toBe(health.line);

    // A key the setting rules out does not count: with only OpenAI allowed,
    // the line is about the model, singular.
    const only = await withEnv({ ...both, UNDERSTANDING_PROVIDER: "openai" }, () => providerHealth(U.id));
    expect(only.line).toBe("Reading is paused: the model has no credits.");

    // One success and the note is gone.
    noteProviderOk("openai");
    const after = await withEnv(both, () => providerHealth(U.id));
    expect(after.openai.state).toBe("ok");
    expect(after).toMatchObject({ ok: true, line: null, action: null });
  });

  it("(5) a fresh process reads the provider's state back from the run rows", async () => {
    resetProviderMemory();
    const both = { ANTHROPIC_API_KEY: "test-key", OPENAI_API_KEY: "test-key", UNDERSTANDING_PROVIDER: undefined };
    // The failed row (3) logged: "model: openai: 429 …". Nothing is known
    // about Claude, which is usable until it says otherwise.
    let health = await withEnv(both, () => providerHealth(U.id));
    expect(health.openai.state).toBe("no-credits");
    expect(health.anthropic.state).toBe("unknown");
    expect(health.ok).toBe(true);

    // An older row in the format runs logged before failures were tagged
    // is read by its wording; a newer ok row on a model names the provider
    // that answered, and wins over both.
    const legacy = await db
      .insert(understandingRuns)
      .values({
        userId: U.id,
        projectId: ids.album,
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 60_000),
        status: "failed",
        errors: [
          "model call failed: 429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
        ],
      })
      .returning({ id: understandingRuns.id });
    expect(legacy).toHaveLength(1);
    health = await withEnv(both, () => providerHealth(U.id));
    expect(health.openai.state).toBe("no-credits");

    await db.insert(understandingRuns).values({
      userId: U.id,
      projectId: ids.album,
      startedAt: new Date(),
      finishedAt: new Date(),
      status: "ok",
      model: "gpt-5.5",
    });
    health = await withEnv(both, () => providerHealth(U.id));
    expect(health.openai.state).toBe("ok");
    expect(health.ok).toBe(true);
  });

  it("(6) a run queued behind another says so until it starts, and a skip drops it", async () => {
    resetProgress();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const enteredOnce = new Promise<void>((resolve) => (entered = resolve));
    const slow = fakeModel(async (bundle) => {
      entered();
      await gate;
      return validOutputFor(bundle, ids);
    });

    const events = await eventsDuring(async () => {
      const first = run({ model: slow, force: true });
      await enteredOnce;
      // The channel shows the run in flight, not the one waiting.
      expect(snapshot(U.id).active.map((a) => a.phase)).toEqual(["reading"]);
      // No force: the follow-up gathers, finds the hash unchanged, and skips.
      await expect(run({ model: slow })).resolves.toEqual({ status: "skipped", reason: "queued" });
      release();
      expect((await first).status).toBe("ok");
      // The follow-up is not awaited by anyone; wait for it to clear.
      for (let i = 0; i < 100 && snapshot(U.id).active.length > 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    const kinds = events.map((e) => (e.kind === "active" ? e.entry.phase : e.kind));
    expect(kinds).toEqual(["gathering", "reading", "checking", "storing", "finished", "queued", "dropped"]);
    const queued = events.find((e) => e.kind === "active" && e.entry.phase === "queued");
    expect(queued?.kind === "active" && queued.entry.line).toBe("Waiting to read Caltrans");
    expect(snapshot(U.id).active).toEqual([]);
    expect(slow.calls).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// The snapshot's memory
// --------------------------------------------------------------------------

describe("snapshot", () => {
  it("keeps a finished run five minutes and at most twenty per user, newest first", () => {
    resetProgress();
    const t0 = Date.parse("2026-09-23T12:00:00.000Z");
    let now = t0;
    setProgressClock(() => now);
    try {
      finish(U.id, "p-old", "Old", "ok", "Read Old", "nothing new to ask", null);
      now = t0 + RECENT_MS - 1;
      expect(snapshot(U.id).recent.map((r) => r.projectId)).toEqual(["p-old"]);
      expect(snapshot(U.id).recent[0].finishedAt).toBe(new Date(t0).toISOString());
      now = t0 + RECENT_MS;
      expect(snapshot(U.id).recent).toEqual([]);

      for (let i = 0; i < RECENT_MAX + 5; i++) {
        now = t0 + RECENT_MS + i;
        finish(U.id, `p-${i}`, `P ${i}`, i % 2 ? "failed" : "ok", "line", null, i % 2 ? "other" : null);
      }
      const recent = snapshot(U.id).recent;
      expect(recent).toHaveLength(RECENT_MAX);
      expect(recent[0].projectId).toBe(`p-${RECENT_MAX + 4}`);
      expect(recent[RECENT_MAX - 1].projectId).toBe("p-5");
      // reason only rides on a failure.
      expect(recent.find((r) => r.status === "ok")?.reason).toBeNull();
      expect(recent.find((r) => r.status === "failed")?.reason).toBe("other");
      // Another user sees none of it.
      expect(snapshot("someone-else")).toEqual({ active: [], recent: [] });
    } finally {
      setProgressClock(null);
      resetProgress();
    }
  });
});

// --------------------------------------------------------------------------
// The words, and what a message from a provider means
// --------------------------------------------------------------------------

describe("the lines", () => {
  it("classifyProviderError reads a refused key, no credits, a cap, and nothing from a rate limit", () => {
    expect(classifyProviderError("401 Incorrect API key provided: sk-abc").state).toBe("auth");
    expect(classifyProviderError('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}').state).toBe("auth");
    expect(classifyProviderError("429 You have no credits remaining. Add credits to continue.").state).toBe("no-credits");
    expect(classifyProviderError('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}').state).toBe("no-credits");
    expect(classifyProviderError("429 Rate limit reached for gpt-5.5. Please try again in 20s.").state).toBe("other");
    expect(classifyProviderError("claude refusal").state).toBe("other");
    expect(classifyProviderError("openai returned no text").state).toBe("other");
  });

  it("failedLines: provider failures name each provider, one alone is 'the model', the validator's are a rejection", () => {
    expect(
      failedLines("Caltrans", [
        `${MODEL_ERROR_PREFIX}openai: ${OPENAI_NO_CREDITS}`,
        `${MODEL_ERROR_PREFIX}anthropic: ${CLAUDE_CAPPED}`,
      ])
    ).toEqual({
      line: "Could not read Caltrans",
      detail: "the Claude limit resets on October 1 and OpenAI has no credits",
      reason: "no-credits",
    });
    expect(failedLines("Caltrans", [`${MODEL_ERROR_PREFIX}anthropic: ${CLAUDE_CAPPED}`])).toEqual({
      line: "Could not read Caltrans",
      detail: "the model's limit resets on October 1",
      reason: "capped",
    });
    expect(failedLines("Caltrans", [`${MODEL_ERROR_PREFIX}openai: 401 Incorrect API key provided`])).toMatchObject({
      detail: "the model's key was refused",
      reason: "auth",
    });
    expect(failedLines("Caltrans", [`${MODEL_ERROR_PREFIX}claude refusal`])).toEqual({
      line: "Could not read Caltrans",
      detail: "the model did not answer",
      reason: "other",
    });
    // A road that merely did not answer is named beside the one that is out
    // of credits, not dropped so that the other reads as "the model".
    expect(
      failedLines("Caltrans", [
        `${MODEL_ERROR_PREFIX}anthropic: 529 overloaded_error`,
        `${MODEL_ERROR_PREFIX}openai: 429 You have no credits remaining`,
      ])
    ).toEqual({
      line: "Could not read Caltrans",
      detail: "Claude is not answering and OpenAI has no credits",
      reason: "no-credits",
    });
    expect(failedLines("Caltrans", ["record.things[0].state.sources: at least one source"])).toEqual({
      line: "Could not read Caltrans",
      detail: "the model's answer did not check out",
      reason: "validation",
    });
    expect(failedLines("Caltrans", [])).toMatchObject({ detail: "something went wrong", reason: "other" });
  });

  it("okLines, displayModelName, outageLine", () => {
    expect(okLines("Caltrans", { created: 0 })).toEqual({ line: "Read Caltrans", detail: "nothing new to ask" });
    expect(okLines("Caltrans", { created: 1, updated: 2, dismissed: 1, skippedSettled: 3 }).detail).toBe(
      "1 new question, 2 updated, 1 dismissed, 3 already settled"
    );
    expect(displayModelName("claude-sonnet-5")).toBe("Claude Sonnet 5");
    expect(displayModelName("gpt-5.5")).toBe("GPT-5.5");
    expect(displayModelName("gpt-5.4-mini")).toBe("GPT-5.4 mini");
    expect(displayModelName("claude-haiku-5")).toBe("Claude Haiku 5");
    expect(displayModelName("fake")).toBe("fake");
    expect(outageLine("The secretary could not respond", "openai", classifyProviderError(OPENAI_NO_CREDITS))).toBe(
      "The secretary could not respond: OpenAI has no credits. Add credits, raise the limit, or connect your own key in Settings."
    );
    expect(outageLine("The secretary could not respond", "openai", classifyProviderError("500 server error"))).toBeNull();
  });

  it("describeHealth: unknown is usable, a refused key alone asks for the key, no key at all asks for one", async () => {
    const status = (state: "ok" | "capped" | "no-credits" | "auth" | "missing" | "unknown") => ({ state, until: null, connected: false });
    await withEnv({ UNDERSTANDING_PROVIDER: undefined }, () => {
      expect(describeHealth({ anthropic: status("capped"), openai: status("unknown") })).toMatchObject({ ok: true, line: null });
      expect(describeHealth({ anthropic: status("auth"), openai: status("missing") })).toMatchObject({
        ok: false,
        line: "Reading is paused: the model's key was refused.",
        action: "Check the key in Settings, or connect another.",
      });
      expect(describeHealth({ anthropic: status("missing"), openai: status("missing") })).toMatchObject({
        ok: false,
        line: "Reading is paused: no model is connected.",
        action: "Connect your own key in Settings.",
      });
      expect(describeHealth({ anthropic: status("auth"), openai: status("no-credits") })).toMatchObject({
        line: "Reading is paused: the Claude key was refused and OpenAI has no credits.",
        action: PROVIDER_ACTION,
      });
    });
  });
});

// --------------------------------------------------------------------------
// The route
// --------------------------------------------------------------------------

describe("GET /api/understanding/progress", () => {
  it("returns the snapshot, the newest run row worded like a finish, and the provider object", async () => {
    resetProgress();
    resetProviderMemory();
    const { GET } = await import("@/app/api/understanding/progress/route");
    const body = await withEnv(
      { ANTHROPIC_API_KEY: "test-key", OPENAI_API_KEY: "test-key", UNDERSTANDING_PROVIDER: undefined },
      async () => {
        const res = await GET();
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        return res.json();
      }
    );
    expect(body.active).toEqual([]);
    expect(body.recent).toEqual([]);
    // The newest ok-or-failed row is (6)'s Caltrans run, which updated the
    // two questions (1) created and made none of its own.
    expect(body.lastRun).toMatchObject({
      projectName: "Caltrans",
      status: "ok",
      line: "Read Caltrans",
      detail: "nothing new to ask",
    });
    expect(Number.isNaN(Date.parse(body.lastRun.finishedAt))).toBe(false);
    expect(body.provider).toMatchObject({
      ok: true,
      line: null,
      action: null,
      anthropic: { state: "unknown", until: null, connected: false },
      openai: { state: "ok", until: null, connected: false },
    });

    // A failed run's row reads as the finish would have: with the ok rows
    // gone the newest is (3)'s Caltrans row (started seconds ago; (5)'s
    // legacy Album row was backdated a minute).
    await db
      .delete(understandingRuns)
      .where(and(eq(understandingRuns.userId, U.id), eq(understandingRuns.status, "ok")));
    const again = await withEnv({ ANTHROPIC_API_KEY: "test-key", OPENAI_API_KEY: "test-key" }, async () =>
      (await GET()).json()
    );
    expect(again.lastRun).toMatchObject({
      projectName: "Caltrans",
      status: "failed",
      line: "Could not read Caltrans",
      detail: "the model has no credits",
    });
  });
});
