// v1.11 r2 (docs/projects/SPEC.md §2): his moves are applied one at a time,
// in the order they arrived, and a move waiting its turn holds no database
// connection. Ten at once through the tool a call uses: all ten finish, in the
// order they arrived, and a read that has nothing to do with them answers
// while they run. In a file of its own: on 2b212e5 a move held his rows locked
// and read through the shared pool (six connections, no limit on the wait);
// the waiting moves held every connection, the one holding the lock never got
// one, and nothing in the process answered again, this file's pool included.
process.env.TZ = "UTC";

import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));

import type { Pool } from "pg";
import { db } from "@/lib/db";
import { projects, user } from "@/lib/db/schema";
import { listProjects } from "@/lib/projects/list";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const users: string[] = [];
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

/** The promise, or a failure after ms naming what was still waiting. */
const within = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: no answer after ${ms} ms`)), ms))]);

describe("many moves at once", () => {
  it("ten all finish, in the order they arrived, and an unrelated read answers while they run", async () => {
    const id = `test-order-many-${crypto.randomUUID()}`;
    users.push(id);
    await db.insert(user).values({ id, name: "Many", email: `${id}@v111.test`, timezone: TZ });
    const names = Array.from({ length: 10 }, (_, i) => `Project ${String(i + 1).padStart(2, "0")}`);
    for (const name of names) await db.insert(projects).values({ userId: id, name, status: "active" });
    const ctx = liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 });

    // Each to the top, in this order: applied one at a time as they came, the last one ends on top.
    const finished: { name: string; at: number }[] = [];
    const moves = names.map((name) =>
      executeTool(ctx, "move_project", { project: name, to: "top" }).then((r) => {
        finished.push({ name, at: performance.now() });
        return r;
      })
    );
    const read = await within(db.select({ id: user.id }).from(user).where(eq(user.id, id)), 5_000, "an unrelated read");
    const readAt = performance.now();
    expect(read).toHaveLength(1);

    const results = await within(Promise.all(moves), 20_000, "ten moves at once");
    expect(results.map((r) => (r.result as { place?: number; error?: string }).place ?? (r.result as { error?: string }).error)).toEqual(names.map(() => 1));
    expect(finished.map((f) => f.name), "they finished in the order they arrived").toEqual(names);
    expect(readAt, "the read did not wait behind them").toBeLessThan(finished.at(-1)!.at);
    expect((await listProjects(id, TZ)).map((r) => r.name)).toEqual(names.toReversed());
  }, 40_000);

  it("no request waits for a database connection for more than 10 seconds", () => {
    expect((db.$client as Pool).options.connectionTimeoutMillis).toBe(10_000);
  });
});
