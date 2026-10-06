// SEC-A004: "Ask me more" reads only projects whose data changed. It was
// forced past the hash, so every press re-read every project at Opus prices.
// runAll is spied on (no model is reachable under vitest anyway).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; timezone: string } }));
const runAllArgs = vi.hoisted(() => [] as unknown[]);

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return { ...real, requireSession: async () => session.user ?? NextResponse.json({ error: "no" }, { status: 401 }) };
});
vi.mock("@/lib/understanding/run", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/understanding/run")>();
  return {
    ...real,
    runAll: async (_userId: string, opts: unknown) => {
      runAllArgs.push(opts);
      return { results: { p1: { status: "skipped", reason: "unchanged" } }, retiredAsr: 0 };
    },
  };
});

import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { POST as askMeMore } from "@/app/api/interview/more/route";

const U = { id: `test-more-${crypto.randomUUID()}`, email: `more-${Date.now()}@sec-a004.test`, name: "More", timezone: "America/Los_Angeles" };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: U.name, email: U.email, timezone: U.timezone });
  session.user = U;
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("Ask me more", () => {
  it("is not forced past the hash, and says when nothing changed", async () => {
    const res = await askMeMore();
    expect(res.status).toBe(200);
    expect(runAllArgs).toHaveLength(1);
    expect(runAllArgs[0]).toMatchObject({ mode: "interview" });
    expect((runAllArgs[0] as { force?: boolean }).force).toBeUndefined();
    expect(await res.json()).toMatchObject({ ran: 0, failed: 0, questionsCreated: 0, unchanged: 1 });
  });
});
