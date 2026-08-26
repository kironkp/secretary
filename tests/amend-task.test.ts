// "File that under Caltrans" must land on the EXISTING task — the voice-path
// amend_task delegate, the "no project" sentinels, and the create-guard's
// fill-a-blank-project behavior, against the real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ilike } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks, user } from "@/lib/db/schema";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-amend-${crypto.randomUUID()}`, email: `amend-${Date.now()}@amend.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Amend Tester", email: U.email });
  await db.insert(projects).values({ userId: U.id, name: "Caltrans" });
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

async function taskRow(fragment: string) {
  const [t] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, U.id), ilike(tasks.title, `%${fragment}%`)));
  return t;
}

async function projectRow(name: string) {
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, U.id), eq(projects.name, name)));
  return p;
}

describe("amend_task: change the EXISTING task, never a twin", () => {
  it("files an unfiled task under a project by fuzzy ref", async () => {
    await executeTool(ctx, "create_commitment", { title: "Pick up the glue samples" });
    const { result, toast } = await executeTool(ctx, "amend_task", {
      task: "glue samples",
      project: "caltrans",
    });
    expect((result as { project: string }).project).toBe("Caltrans");
    expect(toast?.text).toContain("Moved");
    const t = await taskRow("glue");
    const p = await projectRow("Caltrans");
    expect(t.projectId).toBe(p.id);
    // amended in place — still exactly one glue task
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, U.id), ilike(tasks.title, "%glue%")));
    expect(rows).toHaveLength(1);
  });

  it('"none"/"unfiled"/"no project" unfile without crashing', async () => {
    for (const sentinel of ["none", "unfiled", "no project"]) {
      await executeTool(ctx, "amend_task", { task: "glue samples", project: "Caltrans" });
      const { result } = await executeTool(ctx, "amend_task", {
        task: "glue samples",
        project: sentinel,
      });
      expect((result as { error?: string }).error).toBeUndefined();
      expect((result as { project: string | null }).project).toBeNull();
      const t = await taskRow("glue");
      expect(t.projectId).toBeNull();
    }
    // and no project literally named after a sentinel was spawned
    const all = await db.select().from(projects).where(eq(projects.userId, U.id));
    expect(all.some((p) => /^(none|unfiled|no project)$/i.test(p.name))).toBe(false);
  });

  it("retitles and adds a note in one call", async () => {
    const { result } = await executeTool(ctx, "amend_task", {
      task: "glue samples",
      title: "Pick up the glue samples from the depot",
      note: "Gate code is 4411",
    });
    expect((result as { title: string }).title).toBe("Pick up the glue samples from the depot");
    const t = await taskRow("glue");
    expect(t.title).toBe("Pick up the glue samples from the depot");
    expect(t.notes).toBe("Gate code is 4411");
  });

  it("an unmatched ref returns an error, not a new task", async () => {
    const before = await db.select().from(tasks).where(eq(tasks.userId, U.id));
    const { result } = await executeTool(ctx, "amend_task", {
      task: "no such task anywhere",
      project: "Caltrans",
    });
    expect((result as { error: string }).error).toContain("No task matching");
    const after = await db.select().from(tasks).where(eq(tasks.userId, U.id));
    expect(after).toHaveLength(before.length);
  });
});

describe("create-guard twin: a named project files the existing task", () => {
  it("fills a blank project on the twin instead of silently dropping it — and toasts", async () => {
    const first = await executeTool(ctx, "create_task", { title: "Order the reflective vests" });
    const second = await executeTool(ctx, "create_task", {
      title: "Order the reflective vests",
      project: "Caltrans",
    });
    expect((second.result as { already_existed: boolean }).already_existed).toBe(true);
    expect((second.result as { task_id: string }).task_id).toBe(
      (first.result as { task_id: string }).task_id
    );
    expect((second.result as { project: string }).project).toBe("Caltrans");
    expect(second.toast?.text).toContain("Caltrans"); // the move is always visible
    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, U.id), ilike(tasks.title, "%reflective vests%")));
    expect(rows).toHaveLength(1); // never a second row
    const p = await projectRow("Caltrans");
    expect(rows[0].projectId).toBe(p.id);
  });

  it("never overwrites a project already set — and never spawns the named one", async () => {
    const again = await executeTool(ctx, "create_task", {
      title: "Order the reflective vests",
      project: "Brand New Zone",
    });
    expect((again.result as { already_existed: boolean }).already_existed).toBe(true);
    expect((again.result as { project?: string }).project).toBeUndefined();
    expect(again.toast).toBeUndefined(); // nothing changed, no toast
    const t = await taskRow("reflective vests");
    const p = await projectRow("Caltrans");
    expect(t.projectId).toBe(p.id); // still Caltrans
    expect(await projectRow("Brand New Zone")).toBeUndefined();
  });
});
