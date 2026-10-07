// SEC-A009: the understanding hash no longer moves on a bare updated_at or a
// planned start (a timeline drag is not news to a run). Deploying the new
// formula must not re-read every project once: a record stamped with the old
// formula over unchanged inputs is re-stamped with the new one, with no model
// call. A project that genuinely changed still re-reads, once. Against the
// local database with a fake model; sec plan's acceptance for the change.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, records, tasks, understandingRuns, user } from "@/lib/db/schema";
import { gatherProject, hashBundle, legacyHashBundle } from "@/lib/understanding/gather";
import { runProject } from "@/lib/understanding/run";
import { CPO_NOW, CPO_TZ, fakeModel, minimalOutputFor, seedCpoScenario, type CpoIds } from "./fixtures/understanding";

const U = { id: `test-understanding-restamp-${crypto.randomUUID()}`, email: `restamp-${Date.now()}@sec-a009.test` };
const NOW = CPO_NOW;
const TZ = CPO_TZ;
let ids: CpoIds;

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Restamp Tester", email: U.email, timezone: TZ });
  ids = await seedCpoScenario(U.id, NOW);
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

const projectIds = () => [ids.caltrans, ids.album];
const gather = (p: string) => gatherProject(U.id, p, { now: NOW, timezone: TZ });
const record = async (p: string) =>
  (await db.select().from(records).where(and(eq(records.userId, U.id), eq(records.projectId, p))))[0];
const runAll = async (model: ReturnType<typeof fakeModel>) => {
  const out: Record<string, string> = {};
  for (const p of projectIds()) {
    const r = await runProject(U.id, p, { timezone: TZ, now: NOW, model });
    out[p] = r.status === "skipped" ? `skipped:${r.reason}` : r.status;
  }
  return out;
};

// Two understanding runs per step against the database: past vitest's 5 s
// default when another DB-heavy file runs alongside (5037 ms seen).
describe("the A009 hash change costs no re-reads", { timeout: 30_000 }, () => {
  it("first read: every project runs once and is stamped with the new formula", async () => {
    const model = fakeModel((bundle) => minimalOutputFor(bundle));
    const out = await runAll(model);
    expect(Object.values(out)).toEqual(["ok", "ok"]);
    expect(model.calls).toHaveLength(2);
    for (const p of projectIds()) expect((await record(p)).inputsHash).toBe(hashBundle((await gather(p))!));
  });

  it("a record stamped with the OLD formula over unchanged inputs is re-stamped, with 0 model calls", async () => {
    // As every record in production is the moment A009 deploys.
    for (const p of projectIds()) {
      const legacy = legacyHashBundle((await gather(p))!);
      expect(legacy).not.toBe(hashBundle((await gather(p))!));
      await db.update(records).set({ inputsHash: legacy }).where(and(eq(records.userId, U.id), eq(records.projectId, p)));
    }
    const model = fakeModel((bundle) => minimalOutputFor(bundle));
    const out = await runAll(model);
    expect(Object.values(out)).toEqual(["skipped:unchanged", "skipped:unchanged"]);
    expect(model.calls).toHaveLength(0);
    for (const p of projectIds()) expect((await record(p)).inputsHash).toBe(hashBundle((await gather(p))!));
  });

  it("a timeline drag of a start (updated_at moves too) is not news: 0 model calls", async () => {
    await db
      .update(tasks)
      .set({ startAt: new Date(NOW.getTime() + 2 * 86_400_000), updatedAt: new Date(NOW.getTime() + 60_000) })
      .where(eq(tasks.id, ids.checkCpo));
    const model = fakeModel((bundle) => minimalOutputFor(bundle));
    expect(Object.values(await runAll(model))).toEqual(["skipped:unchanged", "skipped:unchanged"]);
    expect(model.calls).toHaveLength(0);
  });

  it("a genuinely changed project still re-reads, once; the other does not", async () => {
    await db.update(tasks).set({ notes: "Teresa says it waits on the FY27 conversion." }).where(eq(tasks.id, ids.checkCpo));
    const model = fakeModel((bundle) => minimalOutputFor(bundle));
    const out = await runAll(model);
    expect(out[ids.caltrans]).toBe("ok");
    expect(out[ids.album]).toBe("skipped:unchanged");
    expect(model.calls).toHaveLength(1);
    // And once is once: the next sweep has nothing new.
    const again = fakeModel((bundle) => minimalOutputFor(bundle));
    expect(Object.values(await runAll(again))).toEqual(["skipped:unchanged", "skipped:unchanged"]);
    expect(again.calls).toHaveLength(0);
  });
});

describe("a failure logged under the old formula keeps its backoff (sec rev's prod simulation)", { timeout: 30_000 }, () => {
  // As Caltrans is in production: no record (a failed run stores none) and a
  // validator-refused run stamped with the formula before A009. Releasing
  // that backoff would buy one paid read the moment A009 deploys.
  let projectId = "";
  beforeAll(async () => {
    const [p] = await db.insert(projects).values({ userId: U.id, name: "Backoff under the old hash", status: "active" }).returning();
    projectId = p.id;
    await db.insert(tasks).values({ userId: U.id, projectId, title: "File the FY27 conversion", status: "todo", source: "spoken" });
    const bundle = (await gather(projectId))!;
    await db.insert(understandingRuns).values({
      userId: U.id,
      projectId,
      status: "failed",
      inputsHash: legacyHashBundle(bundle),
      errors: ["things[0].evidence: no such row"],
      inputTokens: 18_000,
      outputTokens: 4_000,
    });
  });

  it("the sweep holds back, with 0 model calls", async () => {
    const model = fakeModel((bundle) => minimalOutputFor(bundle));
    const result = await runProject(U.id, projectId, { timezone: TZ, now: NOW, model, backoffAfterFailure: true });
    expect(result).toEqual({ status: "skipped", reason: "backoff" });
    expect(model.calls).toHaveLength(0);
  });

  it("and a genuine change to its data still reads it, once", async () => {
    // As the app writes it: update_task bumps updated_at with every change.
    await db
      .update(tasks)
      .set({ notes: "Teresa signed it.", updatedAt: new Date(NOW.getTime() + 60_000) })
      .where(eq(tasks.projectId, projectId));
    const model = fakeModel((bundle) => minimalOutputFor(bundle));
    const result = await runProject(U.id, projectId, { timezone: TZ, now: NOW, model, backoffAfterFailure: true });
    expect(result.status === "skipped" ? `skipped:${result.reason}` : result.status).toBe("ok");
    expect(model.calls).toHaveLength(1);
  });
});
