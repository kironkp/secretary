// Durable canvas cross-offs (SPEC §7.6): the canvas GET returns doneTaskIds —
// the snapshot's data-check ids whose tasks are already done, user-scoped —
// and the tap's PATCH records canvas provenance in the check-in note.
// Exercises the real query layer against the real database, and the tasks
// PATCH route with the session guard mocked.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, tasks, user } from "@/lib/db/schema";
import { collectCheckIds, doneCheckIds } from "@/lib/canvas/painter";

const A = { id: `test-cv-done-a-${crypto.randomUUID()}`, email: `a-${Date.now()}@cvdone.test` };
const B = { id: `test-cv-done-b-${crypto.randomUUID()}`, email: `b-${Date.now()}@cvdone.test` };

// The route's session guard is mocked (there is no request scope in tests);
// everything downstream — Zod schema, ownership check, check-in write — is real.
// The auth module itself is stubbed too: importing a route handler pulls in
// @/lib/api → @/lib/auth, and the real betterAuth instance must never build
// inside vitest.
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
const sessionUser = { id: A.id, email: A.email, name: "User A", timezone: "UTC" };
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, requireSession: vi.fn(async () => sessionUser) };
});

let aDone: string;
let aOpen: string;
let bDone: string;

beforeAll(async () => {
  await db.insert(user).values([
    { id: A.id, name: "User A", email: A.email, timezone: "UTC" },
    { id: B.id, name: "User B", email: B.email, timezone: "UTC" },
  ]);
  const rows = await db
    .insert(tasks)
    .values([
      { userId: A.id, title: "A done", status: "done" },
      { userId: A.id, title: "A open", status: "todo" },
      { userId: B.id, title: "B done", status: "done" },
    ])
    .returning({ id: tasks.id });
  [aDone, aOpen, bDone] = rows.map((r) => r.id);
});

afterAll(async () => {
  // user cascade wipes tasks/checkins
  await db.delete(user).where(inArray(user.id, [A.id, B.id]));
});

const markupWith = (...ids: string[]) =>
  ids.map((id) => `<li data-check="${id}">task</li>`).join("");

describe("collectCheckIds", () => {
  it("extracts and dedupes data-check ids from sanitized markup", () => {
    const markup = `${markupWith("t-1", "t_2", "t-1")}<span data-link="p-9">p</span>`;
    expect(collectCheckIds(markup)).toEqual(["t-1", "t_2"]);
  });

  it("returns nothing for markup without data-check", () => {
    expect(collectCheckIds("<div data-expand>hi</div>")).toEqual([]);
  });
});

describe("doneCheckIds (seeds durable cross-offs)", () => {
  it("returns only the markup's tasks that are done", async () => {
    const ids = await doneCheckIds(A.id, markupWith(aDone, aOpen));
    expect(ids).toEqual([aDone]);
  });

  it("never returns another user's task, even when the markup names it", async () => {
    const ids = await doneCheckIds(A.id, markupWith(aDone, bDone));
    expect(ids).toEqual([aDone]);
  });

  it("skips the query entirely for markup without data-check", async () => {
    expect(await doneCheckIds(A.id, "<div>nothing checkable</div>")).toEqual([]);
  });
});

describe("PATCH provenance (check-in note source)", () => {
  const patch = async (taskId: string, body: Record<string, unknown>) => {
    const { PATCH } = await import("@/app/api/tasks/[id]/route");
    return PATCH(
      new Request(`http://test/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: taskId }) }
    );
  };

  const lastNote = async (taskId: string) => {
    const [row] = await db
      .select({ note: checkins.note })
      .from(checkins)
      .where(and(eq(checkins.userId, A.id), eq(checkins.taskId, taskId)))
      .orderBy(desc(checkins.at))
      .limit(1);
    return row?.note;
  };

  it('source: "canvas" writes canvas provenance', async () => {
    const res = await patch(aOpen, { status: "done", source: "canvas" });
    expect(res.status).toBe(200);
    expect(await lastNote(aOpen)).toBe("Marked done from canvas");
  });

  it("missing source keeps the historical dashboard wording", async () => {
    const [{ id }] = await db
      .insert(tasks)
      .values({ userId: A.id, title: "A open 2", status: "todo" })
      .returning({ id: tasks.id });
    const res = await patch(id, { status: "done" });
    expect(res.status).toBe(200);
    expect(await lastNote(id)).toBe("Marked done from dashboard");
  });

  it("rejects an unknown source", async () => {
    const res = await patch(aOpen, { status: "done", source: "carrier-pigeon" });
    expect(res.status).toBe(400);
  });
});
