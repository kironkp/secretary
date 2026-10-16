// v1.10 (docs/tasks/SPEC.md §2.4): a task taken off done is not done any more. Before, neither the PATCH route (the
// editor's Status, the done circle) nor update_task (the model reopening it) cleared completedAt, so a reopened task
// kept a finish date: the suggestions prompt described it as "done" beside its open status. Made-up user; the real
// route and tool; no model is called.
process.env.TZ = "UTC";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; timezone: string } }));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return { ...real, requireSession: async () => session.user ?? NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
});
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));

import { db } from "@/lib/db";
import { tasks, user } from "@/lib/db/schema";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";
import { PATCH } from "@/app/api/tasks/[id]/route";

const TZ = "America/Los_Angeles";
const users: string[] = [];
let uid: string;
beforeEach(async () => {
  uid = `test-reopen-${crypto.randomUUID()}`;
  users.push(uid);
  await db.insert(user).values({ id: uid, name: "Reopen", email: `${uid}@v110.test`, timezone: TZ });
  session.user = { id: uid, email: `${uid}@v110.test`, name: "Reopen", timezone: TZ };
});
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
const done = async () =>
  (await db.insert(tasks).values({ userId: uid, title: "Sweep the porch", status: "done", source: "typed", completedAt: new Date() }).returning())[0].id;
const patch = (id: string, body: Record<string, unknown>) =>
  PATCH(new Request(`http://x/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });

describe("reopened, a task is not done any more (§2.4)", () => {
  it.each(["todo", "in_progress", "blocked", "inbox"])("the PATCH route to %s clears completedAt", async (status) => {
    const id = await done();
    expect((await patch(id, { status })).status).toBe(200);
    const t = await row(id);
    expect(t.status).toBe(status);
    expect(t.completedAt).toBeNull();
  });

  it("update_task, the model reopening it, clears completedAt too", async () => {
    const id = await done();
    await executeTool(liveTurnContext({ userId: uid, timezone: TZ, attachmentCount: 0 }), "update_task", { task: id, status: "todo" });
    expect((await row(id)).completedAt).toBeNull();
  });

  it("a task that was never done keeps a null completedAt, and done sets it", async () => {
    const [t] = await db.insert(tasks).values({ userId: uid, title: "Oil the hinges", status: "todo", source: "typed" }).returning();
    await patch(t.id, { status: "in_progress" });
    expect((await row(t.id)).completedAt).toBeNull();
    await patch(t.id, { status: "done" });
    expect((await row(t.id)).completedAt).not.toBeNull();
  });
});
