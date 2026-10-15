// v1.11 r3 (docs/projects/SPEC.md §2): his moves' queue, on what it already did
// right (the Reviewer's N15 and N16), and one read at a time in a move's
// transaction. A move that is refused, or throws, in the middle of his queue
// does not stop the moves after it; another user's move does not wait behind
// his; and a move never sends a query on its transaction while another is
// still waiting there (pg 8 warns "Calling client.query() when the client is
// already executing a query", and pg 9 refuses it). A move holds its turn
// through the plan head it reads after its transaction, so the tests hold or
// break a move there.
process.env.TZ = "UTC";

import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("@/lib/layout/plan-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/layout/plan-store")>();
  return { ...real, getPlanHead: vi.fn(real.getPlanHead) };
});

import pg from "pg";
import { db } from "@/lib/db";
import { projects, user } from "@/lib/db/schema";
import { getPlanHead } from "@/lib/layout/plan-store";
import { listProjects } from "@/lib/projects/list";
import { moveProject } from "@/lib/projects/order";

const TZ = "America/Los_Angeles";
const head = vi.mocked(getPlanHead);
const users: string[] = [];
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

async function someone(names: string[]): Promise<string> {
  const id = `test-order-queue-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Queue", email: `${id}@v111.test`, timezone: TZ });
  for (const name of names) await db.insert(projects).values({ userId: id, name, status: "active" });
  return id;
}

/** The promise, or a failure after ms naming what was still waiting. */
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer after ${ms} ms`)), ms))]);

describe("his moves' queue", () => {
  it("a move refused, or one that throws, in the middle of his queue does not stop the moves after it (N15)", async () => {
    const id = await someone(["Alder", "Birch", "Cedar"]);
    const real = head.getMockImplementation()!;
    // The second move's plan head breaks, after its own transaction.
    head.mockImplementationOnce(real).mockImplementationOnce(async () => {
      throw new Error("a read that broke");
    });
    const first = moveProject(id, "Cedar", "top");
    const second = moveProject(id, "Birch", "top");
    const refused = moveProject(id, "Nowhere Land", "top");
    const last = moveProject(id, "Alder", "top");
    const settled = await within(Promise.allSettled([first, second, refused, last]), 15_000, "four moves");
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect((settled[1] as PromiseRejectedResult).reason.message).toBe("a read that broke");
    expect((settled[2] as PromiseFulfilledResult<Awaited<typeof refused>>).value).toEqual({ ok: false, error: 'No project matching "Nowhere Land"' });
    const after = (settled[3] as PromiseFulfilledResult<Awaited<typeof last>>).value;
    expect(after.ok && after.place, "the last move ran after the two").toBe(1);
    expect((await listProjects(id, TZ)).map((r) => r.name)).toEqual(["Alder", "Birch", "Cedar"]);
  }, 30_000);

  it("another user's move does not wait behind his (N16)", async () => {
    const his = await someone(["His one", "His two"]);
    const theirs = await someone(["Their one", "Their two"]);
    const real = head.getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const calls = head.mock.calls.length;
    head.mockImplementationOnce(async (...args) => {
      await held;
      return real(...args);
    });
    // His move holds his turn until released.
    const mine = moveProject(his, "His two", "top");
    await vi.waitFor(() => expect(head.mock.calls.length).toBe(calls + 1), { timeout: 5_000 });
    const other = await within(moveProject(theirs, "Their two", "top"), 5_000, "the other user's move while his is held");
    expect(other.ok && other.place).toBe(1);
    release();
    const done = await mine;
    expect(done.ok && done.place).toBe(1);
  }, 30_000);
});

describe("one read at a time in a move's transaction", () => {
  it("a move never sends a query on its transaction while another is waiting there (pg 8 warns, pg 9 refuses)", async () => {
    const id = await someone(["Dove", "Egret", "Finch"]);
    // The condition pg warns on (node_modules/pg/lib/client.js: a query() while its queue is not empty), counted on
    // every client, since the deprecation notice itself is printed once per process.
    const Client = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown; _queryQueue?: unknown[] };
    const query = Client.query;
    let overlapping = 0;
    Client.query = function (this: { _queryQueue?: unknown[] }, ...args: unknown[]) {
      if ((this._queryQueue?.length ?? 0) > 0) overlapping++;
      return query.apply(this, args);
    };
    try {
      const moved = await moveProject(id, "Finch", "top");
      expect(moved.ok).toBe(true);
    } finally {
      Client.query = query;
    }
    expect(overlapping, "queries sent while another waited on the same client").toBe(0);
  }, 30_000);
});
