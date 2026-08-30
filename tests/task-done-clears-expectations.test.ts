// SPEC §11 via the task API: marking a task done — canvas tap or dashboard
// checkbox, both land on PATCH /api/tasks/[id] — clears the task's open
// commitments silently, exactly like the chat/voice tools' done-path. Only
// that task's OPEN rows for THAT user clear; missed history, other tasks,
// task-less commitments, and other users' rows are untouched.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { expectations, tasks, user } from "@/lib/db/schema";

const A = { id: `test-exp-done-a-${crypto.randomUUID()}`, email: `a-${Date.now()}@expdone.test` };
const B = { id: `test-exp-done-b-${crypto.randomUUID()}`, email: `b-${Date.now()}@expdone.test` };

// Session guard mocked (no request scope in tests); auth module stubbed so the
// real betterAuth instance never builds inside vitest. Everything downstream —
// ownership check, expectation clearing — is real.
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
const sessionUser = { id: A.id, email: A.email, name: "User A", timezone: "UTC" };
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, requireSession: vi.fn(async () => sessionUser) };
});

let target: string; // A's task being marked done
let other: string; // A's unrelated task

const inADay = new Date(Date.now() + 24 * 3600000);

beforeAll(async () => {
  await db.insert(user).values([
    { id: A.id, name: "User A", email: A.email, timezone: "UTC" },
    { id: B.id, name: "User B", email: B.email, timezone: "UTC" },
  ]);
  const rows = await db
    .insert(tasks)
    .values([
      { userId: A.id, title: "Target task", status: "todo" },
      { userId: A.id, title: "Other task", status: "todo" },
    ])
    .returning({ id: tasks.id });
  [target, other] = rows.map((r) => r.id);
  await db.insert(expectations).values([
    { userId: A.id, taskId: target, commitment: "target open", expectedUpdateBy: inADay },
    { userId: A.id, taskId: target, commitment: "target missed", expectedUpdateBy: inADay, status: "missed" },
    { userId: A.id, taskId: other, commitment: "other-task open", expectedUpdateBy: inADay },
    { userId: A.id, taskId: null, commitment: "task-less open", expectedUpdateBy: inADay },
    // B's commitment pointing at A's task id: user scoping must still hold.
    { userId: B.id, taskId: target, commitment: "other-user open", expectedUpdateBy: inADay },
  ]);
});

afterAll(async () => {
  // user cascade wipes tasks/expectations
  await db.delete(user).where(inArray(user.id, [A.id, B.id]));
});

const patchDone = async (taskId: string) => {
  const { PATCH } = await import("@/app/api/tasks/[id]/route");
  return PATCH(
    new Request(`http://test/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done", source: "canvas" }),
    }),
    { params: Promise.resolve({ id: taskId }) }
  );
};

const byCommitment = async () => {
  const rows = await db
    .select({
      commitment: expectations.commitment,
      status: expectations.status,
      clearedAt: expectations.clearedAt,
    })
    .from(expectations)
    .where(inArray(expectations.userId, [A.id, B.id]));
  return new Map(rows.map((r) => [r.commitment, r]));
};

describe("PATCH done clears expectations (SPEC §11)", () => {
  it("clears only the task's open rows; everything else is untouched", async () => {
    const res = await patchDone(target);
    expect(res.status).toBe(200);

    const rows = await byCommitment();
    expect(rows.get("target open")?.status).toBe("cleared");
    expect(rows.get("target open")?.clearedAt).toBeTruthy();
    expect(rows.get("target missed")?.status).toBe("missed");
    expect(rows.get("other-task open")?.status).toBe("open");
    expect(rows.get("task-less open")?.status).toBe("open");
    expect(rows.get("other-user open")?.status).toBe("open");
  });

  it("a repeat PATCH is a clean no-op — cleared rows keep their clearedAt", async () => {
    const before = (await byCommitment()).get("target open")?.clearedAt;
    const res = await patchDone(target);
    expect(res.status).toBe(200);

    const rows = await byCommitment();
    expect(rows.get("target open")?.status).toBe("cleared");
    expect(rows.get("target open")?.clearedAt).toEqual(before);
    expect(rows.get("target missed")?.status).toBe("missed");
    expect(rows.get("other-user open")?.status).toBe("open");
  });
});
