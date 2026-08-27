// SIGNALS.tasks (SPEC §4): the id vocabulary for the Canvas tap-to-complete
// contract (§7.6 data-check). The painter may only act on ids that appear
// here, so this list must be exactly the user's OPEN tasks — due-soonest
// first, capped at 50, and never another user's. Real Postgres, real queries.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks, user } from "@/lib/db/schema";
import { computeSignals } from "@/lib/layout/signals";

const A = { id: `test-sig-a-${crypto.randomUUID()}`, email: `sig-a-${Date.now()}@tasks.test` };
const B = { id: `test-sig-b-${crypto.randomUUID()}`, email: `sig-b-${Date.now()}@tasks.test` };

const day = (n: number) => new Date(Date.now() + n * 86400000);

let projectId: string;

beforeAll(async () => {
  await db.insert(user).values([
    { id: A.id, name: "Sig A", email: A.email },
    { id: B.id, name: "Sig B", email: B.email },
  ]);
  const [proj] = await db
    .insert(projects)
    .values({ userId: A.id, name: "flyers", status: "active" })
    .returning();
  projectId = proj.id;
  await db.insert(tasks).values([
    { userId: A.id, projectId, title: "print flyers", status: "todo", dueAt: day(2) },
    { userId: A.id, title: "hang flyers", status: "in_progress", dueAt: day(1) },
    { userId: A.id, title: "someday, undated", status: "inbox" },
    { userId: A.id, title: "already done", status: "done", dueAt: day(1) },
    { userId: A.id, title: "dropped it", status: "dropped" },
    { userId: B.id, title: "B's open task", status: "todo", dueAt: day(1) },
  ]);
});

afterAll(async () => {
  // user cascade wipes tasks/projects
  await db.delete(user).where(inArray(user.id, [A.id, B.id]));
});

describe("SIGNALS.tasks", () => {
  it("carries open tasks only, due-soonest first with undated last", async () => {
    const signals = await computeSignals(A.id);
    expect(signals.tasks.map((t) => t.title)).toEqual([
      "hang flyers",
      "print flyers",
      "someday, undated",
    ]);
    const [hang, print, someday] = signals.tasks;
    expect(hang.id).toBeTruthy();
    expect(hang.status).toBe("in_progress");
    expect(hang.due_at).toBeTruthy();
    expect(print.project_id).toBe(projectId);
    expect(someday.due_at).toBeNull();
    expect(someday.project_id).toBeNull();
  });

  it("never carries another user's ids (data-check would hand them to the shell)", async () => {
    const signals = await computeSignals(A.id);
    expect(signals.tasks.some((t) => t.title.includes("B's"))).toBe(false);
    const bSignals = await computeSignals(B.id);
    expect(bSignals.tasks.map((t) => t.title)).toEqual(["B's open task"]);
  });

  it("caps at 50, keeping the soonest-due", async () => {
    await db.insert(tasks).values(
      Array.from({ length: 55 }, (_, i) => ({
        userId: A.id,
        title: `bulk-${i}`,
        status: "todo" as const,
        dueAt: day(10 + i),
      }))
    );
    const signals = await computeSignals(A.id);
    expect(signals.tasks.length).toBe(50);
    // soonest-due survive the cut; the far-future tail and the undated fall off
    expect(signals.tasks[0].title).toBe("hang flyers");
    expect(signals.tasks.some((t) => t.title === "bulk-47")).toBe(true);
    expect(signals.tasks.some((t) => t.title === "bulk-54")).toBe(false);
    expect(signals.tasks.some((t) => t.title === "someday, undated")).toBe(false);
  });
});
