// Living documents + stages + recurrence, against the real database:
// section-level voice ergonomics, version safety, next-occurrence spawning,
// and suggestion project-filing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { documents, projects, tasks, user } from "@/lib/db/schema";
import { executeTool } from "@/lib/secretary/tools";
import { nextOccurrence } from "@/lib/secretary/recurrence";
import { insertSuggestions } from "@/lib/secretary/suggestions";

const U = { id: `test-doc-${crypto.randomUUID()}`, email: `d-${Date.now()}@doc.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Doc Test", email: U.email });
  await db.insert(projects).values({ userId: U.id, name: "Caltrans" });
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("nextOccurrence", () => {
  it("monthly keeps the day-of-month (the rent case)", () => {
    const next = nextOccurrence(new Date(2026, 8, 1, 9), "monthly"); // Sep 1
    expect(next.getMonth()).toBe(9);
    expect(next.getDate()).toBe(1);
  });

  it("monthly clamps Jan 31 → Feb 28", () => {
    const next = nextOccurrence(new Date(2026, 0, 31), "monthly");
    expect(next.getMonth()).toBe(1);
    expect(next.getDate()).toBe(28);
  });

  it("weekly adds 7 days; daily adds 1", () => {
    expect(nextOccurrence(new Date(2026, 7, 10), "weekly").getDate()).toBe(17);
    expect(nextOccurrence(new Date(2026, 7, 10), "daily").getDate()).toBe(11);
  });
});

describe("recurring tasks", () => {
  it("completing a recurring task spawns the next occurrence with stages reset", async () => {
    const created = await executeTool(ctx, "create_task", {
      title: "Pay rent",
      due_at: new Date(Date.now() + 2 * 86400000).toISOString(),
      recurrence: "monthly",
      stages: ["Transfer", "Confirm"],
    });
    const id = (created.result as { task_id: string }).task_id;
    await executeTool(ctx, "update_task", { task: id, stage_done: "transfer" });

    const done = await executeTool(ctx, "complete_task", { task: id });
    expect((done.result as { next_occurrence_due: string }).next_occurrence_due).toBeTruthy();

    const rows = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, U.id), eq(tasks.title, "Pay rent")));
    expect(rows).toHaveLength(2);
    const next = rows.find((t) => t.status === "todo")!;
    expect(next.recurrence).toBe("monthly");
    expect(next.stages.every((s) => !s.done)).toBe(true);
    expect(next.dueAt!.getTime()).toBeGreaterThan(
      rows.find((t) => t.status === "done")!.dueAt!.getTime()
    );
  });
});

describe("documents", () => {
  it("create → read (short doc returns content) → edit snapshots → revert restores", async () => {
    const created = await executeTool(ctx, "create_document", {
      title: "Duty statement",
      project: "caltrans",
      sections: [
        { heading: "Position summary", content: "Original summary." },
        { heading: "Primary responsibilities", content: "Original responsibilities." },
      ],
    });
    const docId = (created.result as { document_id: string }).document_id;
    expect((created.result as { project: string }).project).toBe("Caltrans");

    const read = await executeTool(ctx, "read_document", { document: "duty" });
    const sections = (read.result as { sections: { heading: string; content: string }[] })
      .sections;
    expect(sections[0].content).toBe("Original summary.");

    const edited = await executeTool(ctx, "edit_document_section", {
      document: "duty statement",
      section: "responsibilities",
      content: "Rewritten: supervises the auditorium project.",
    });
    expect((edited.result as { revertible: boolean }).revertible).toBe(true);

    const readBack = await executeTool(ctx, "read_document", {
      document: docId,
      section: "2",
    });
    expect(
      (readBack.result as { section: { content: string } }).section.content
    ).toContain("auditorium");

    const reverted = await executeTool(ctx, "revert_document", { document: "duty" });
    expect((reverted.result as { restored: string }).restored).toContain("Primary");
    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sections[1].content).toBe("Original responsibilities.");
  });

  it("long documents return headings only (voice budget)", async () => {
    await executeTool(ctx, "create_document", {
      title: "Long report",
      sections: [{ heading: "Body", content: "x".repeat(3000) }],
    });
    const read = await executeTool(ctx, "read_document", { document: "long report" });
    const r = read.result as { note?: string; sections: { content?: string }[] };
    expect(r.note).toContain("headings only");
    expect(r.sections[0].content).toBeUndefined();
  });

  it("unknown section errors honestly with the real headings", async () => {
    const res = await executeTool(ctx, "edit_document_section", {
      document: "duty statement",
      section: "conclusion",
      content: "nope",
    });
    expect((res.result as { error: string }).error).toContain("Position summary");
  });
});

describe("suggestion filing", () => {
  it("suggestions land in their existing project, never create one", async () => {
    const inserted = await insertSuggestions(
      U.id,
      [
        { title: "Renew Caltrans parking permit", reason: "annual", due_at: null, project: "caltrans" },
        { title: "Standalone errand", reason: "life", due_at: null, project: "Brand New Project" },
      ],
      []
    );
    expect(inserted).toBe(2);
    const rows = await db
      .select({ title: tasks.title, projectId: tasks.projectId })
      .from(tasks)
      .where(and(eq(tasks.userId, U.id), eq(tasks.source, "suggested")));
    const permit = rows.find((r) => r.title.includes("parking"));
    expect(permit?.projectId).toBeTruthy();
    const errand = rows.find((r) => r.title.includes("Standalone"));
    expect(errand?.projectId).toBeNull();
    const projectNames = await db.select({ n: projects.name }).from(projects).where(eq(projects.userId, U.id));
    expect(projectNames.map((p) => p.n)).toEqual(["Caltrans"]);
  });
});
