// SEC-A006: Today's "Try now" under a failed read. POST /api/understanding
// with a projectId reads that one project again, never every project, and
// never someone else's. The run itself is a spy: no model here.
process.env.TZ = "UTC";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; timezone: string } }));
const runs = vi.hoisted(() => ({ project: [] as string[], all: 0 }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return {
    ...real,
    requireSession: async () => session.user ?? NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
  };
});
vi.mock("@/lib/understanding/run", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/understanding/run")>();
  return {
    ...real,
    runProject: async (_userId: string, projectId: string) => {
      runs.project.push(projectId);
      return { status: "ok", version: 2, questions: 0 };
    },
    runAll: async () => {
      runs.all++;
      return { results: {}, retiredAsr: 0 };
    },
  };
});

import { db } from "@/lib/db";
import { projects, user } from "@/lib/db/schema";
import { POST } from "@/app/api/understanding/route";

const ME = { id: `test-try-now-${crypto.randomUUID()}`, email: `try-now-${Date.now()}@sec-a006.test`, timezone: "America/Los_Angeles" };
const OTHER = { id: `test-try-now-other-${crypto.randomUUID()}`, email: `try-now-o-${Date.now()}@sec-a006.test` };
let mine = "";
let theirs = "";

beforeAll(async () => {
  await db.insert(user).values([
    { id: ME.id, name: "Me", email: ME.email, timezone: ME.timezone },
    { id: OTHER.id, name: "Other", email: OTHER.email },
  ]);
  [{ id: mine }] = await db.insert(projects).values({ userId: ME.id, name: "Caltrans" }).returning({ id: projects.id });
  [{ id: theirs }] = await db.insert(projects).values({ userId: OTHER.id, name: "Theirs" }).returning({ id: projects.id });
});
beforeEach(() => {
  runs.project = [];
  runs.all = 0;
  delete process.env.UNDERSTANDING_DISABLED;
});
afterAll(async () => {
  for (const id of [ME.id, OTHER.id]) await db.delete(user).where(eq(user.id, id));
});

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/understanding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("Try now reads one project again", () => {
  it("reads just that project, not every project", async () => {
    session.user = ME;
    const res = await post({ projectId: mine });
    expect(res.status).toBe(200);
    expect(runs.project).toEqual([mine]);
    expect(runs.all).toBe(0);
  });

  it("never reads another user's project", async () => {
    session.user = { ...ME, id: `${ME.id}-quota` }; // a fresh quota window
    const res = await post({ projectId: theirs });
    expect(res.status).toBe(404);
    expect(runs.project).toEqual([]);
  });

  it("respects the off switch and the once-a-minute quota", async () => {
    session.user = { ...ME, id: `${ME.id}-off` };
    process.env.UNDERSTANDING_DISABLED = "true";
    expect((await post({ projectId: mine })).status).toBe(409);
    delete process.env.UNDERSTANDING_DISABLED;
    session.user = ME; // used its minute in the first test
    expect((await post({ projectId: mine })).status).toBe(429);
    expect(runs.project).toEqual([]);
  });
});
