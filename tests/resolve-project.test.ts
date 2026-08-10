// "Find It" must never spawn a duplicate next to "Find It app" — fuzzy
// project resolution, task moves, and merge, against the real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks, user } from "@/lib/db/schema";
import { executeTool, resolveProject } from "@/lib/secretary/tools";

const A = { id: `test-proj-a-${crypto.randomUUID()}`, email: `a-${Date.now()}@proj.test` };
const B = { id: `test-proj-b-${crypto.randomUUID()}`, email: `b-${Date.now()}@proj.test` };
const ctx = { userId: A.id, timezone: "America/Los_Angeles" };

beforeAll(async () => {
  await db.insert(user).values([
    { id: A.id, name: "Proj A", email: A.email },
    { id: B.id, name: "Proj B", email: B.email },
  ]);
  await db.insert(projects).values([
    { userId: A.id, name: "Find It app" },
    { userId: A.id, name: "Jazz music project" },
    { userId: B.id, name: "B's Secret Plan" },
  ]);
});

afterAll(async () => {
  await db.delete(user).where(inArray(user.id, [A.id, B.id]));
});

describe("resolveProject", () => {
  it("exact name matches", async () => {
    const r = await resolveProject(A.id, "Find It app");
    expect(r.project?.name).toBe("Find It app");
    expect(r.matched).toBe("exact");
  });

  it("case-insensitive exact matches", async () => {
    const r = await resolveProject(A.id, "find it APP");
    expect(r.project?.name).toBe("Find It app");
    expect(r.matched).toBe("exact");
  });

  it('"Find It" fuzzy-matches "Find It app" instead of creating a duplicate', async () => {
    const r = await resolveProject(A.id, "Find It");
    expect(r.project?.name).toBe("Find It app");
    expect(r.matched).toBe("fuzzy");
    const all = await db.select().from(projects).where(eq(projects.userId, A.id));
    expect(all.filter((p) => p.name.toLowerCase().includes("find it"))).toHaveLength(1);
  });

  it("punctuation/whitespace differences match via normalization", async () => {
    const r = await resolveProject(A.id, "find-it-app!");
    expect(r.project?.name).toBe("Find It app");
    expect(["normalized", "fuzzy"]).toContain(r.matched);
  });

  it("a genuinely new name creates a project (and reports it)", async () => {
    const r = await resolveProject(A.id, "Mexico trip");
    expect(r.matched).toBe("created");
    expect(r.project?.name).toBe("Mexico trip");
  });

  it("create:false returns null instead of creating", async () => {
    const r = await resolveProject(A.id, "Nonexistent Thing", { create: false });
    expect(r.project).toBeNull();
  });

  it("never matches another user's project", async () => {
    const r = await resolveProject(A.id, "B's Secret Plan", { create: false });
    expect(r.project).toBeNull();
    const rb = await resolveProject(B.id, "secret plan", { create: false });
    expect(rb.project?.name).toBe("B's Secret Plan");
  });
});

describe("create idempotency guard (the double-tool-call bug)", () => {
  it("an identical re-issued create_task returns the existing task, no twin", async () => {
    const first = await executeTool(ctx, "create_task", {
      title: "Run reference patents through Art Bot",
    });
    const second = await executeTool(ctx, "create_task", {
      title: "Run reference patents through Art Bot",
    });
    expect((second.result as { already_existed: boolean }).already_existed).toBe(true);
    expect((second.result as { task_id: string }).task_id).toBe(
      (first.result as { task_id: string }).task_id
    );
    expect(second.toast).toBeUndefined(); // nothing happened, no toast
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, A.id), eq(tasks.title, "Run reference patents through Art Bot")));
    expect(rows).toHaveLength(1);
  });

  it("similar-but-distinct tasks still both go through", async () => {
    await executeTool(ctx, "create_task", { title: "Email Ash about the patent" });
    const second = await executeTool(ctx, "create_task", { title: "Call Ash about the patent" });
    expect((second.result as { already_existed?: boolean }).already_existed).toBeUndefined();
  });

  it("an identical re-issued create_event returns the existing event", async () => {
    const at = new Date(Date.now() + 3 * 86400000).toISOString();
    const first = await executeTool(ctx, "create_event", { title: "Sync with Jazz", starts_at: at });
    const second = await executeTool(ctx, "create_event", { title: "Sync with Jazz", starts_at: at });
    expect((second.result as { already_existed: boolean }).already_existed).toBe(true);
    expect((second.result as { event_id: string }).event_id).toBe(
      (first.result as { event_id: string }).event_id
    );
  });
});

describe("update_task project moves + update_project merge", () => {
  it("update_task with project moves the task (fuzzy) and reports it", async () => {
    const created = await executeTool(ctx, "create_task", {
      title: "Test Find It on iPad",
      project: "Find It app",
    });
    const taskId = (created.result as { task_id: string }).task_id;

    const moved = await executeTool(ctx, "update_task", {
      task: taskId,
      project: "jazz music",
    });
    expect((moved.result as { project: string }).project).toBe("Jazz music project");
    expect(moved.toast?.text).toContain("Moved");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    const [jazz] = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, A.id))
      .then((r) => r.filter((p) => p.name === "Jazz music project"));
    expect(row.projectId).toBe(jazz.id);

    const cleared = await executeTool(ctx, "update_task", { task: taskId, project: "none" });
    expect((cleared.result as { project: null }).project).toBeNull();
    const [row2] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(row2.projectId).toBeNull();
  });

  it("update_project merge_into moves tasks and deletes the duplicate", async () => {
    await executeTool(ctx, "create_project", { name: "Duplicate Zone" });
    await executeTool(ctx, "create_task", { title: "stranded task", project: "Duplicate Zone" });
    const merged = await executeTool(ctx, "update_project", {
      project: "Duplicate Zone",
      merge_into: "Jazz music project",
    });
    expect((merged.result as { moved_tasks: number }).moved_tasks).toBe(1);
    const remaining = await db
      .select()
      .from(projects)
      .where(eq(projects.userId, A.id))
      .then((r) => r.filter((p) => p.name === "Duplicate Zone"));
    expect(remaining).toHaveLength(0);
  });

  it("delete refuses when tasks are attached", async () => {
    const res = await executeTool(ctx, "update_project", {
      project: "Jazz music project",
      delete: true,
    });
    expect((res.result as { error: string }).error).toContain("merge_into");
  });
});
