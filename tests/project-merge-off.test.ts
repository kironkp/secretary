// v1.09 (docs/chat/SPEC.md §5): update_project's merge is turned off until
// 1.12. It moved the tasks and then deleted the old project, and with it
// everything else that belonged to it. Now it answers that merging is not
// available yet and changes nothing, whatever else the same call asks for.
// Through the shared tool executor (chat and voice both call it), against the
// real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks, user } from "@/lib/db/schema";
import { executeTool } from "@/lib/secretary/tools";
import { anthropicToolDefs } from "@/lib/secretary/tool-schemas";
import { buildInstructionParts } from "@/lib/secretary/persona";

const U = { id: `test-merge-off-${crypto.randomUUID()}`, email: `merge-off-${Date.now()}@v109.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };
const NOT_YET = /merging projects is not available yet/i;

/** What his projects and tasks are, by name: what a refused call must leave as it was. */
const board = async () => {
  const ps = await db.select().from(projects).where(eq(projects.userId, U.id));
  const ts = await db.select().from(tasks).where(eq(tasks.userId, U.id));
  return ps
    .map((p) => ({ name: p.name, color: p.color, tasks: ts.filter((t) => t.projectId === p.id).map((t) => t.title).toSorted() }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
};

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Merge", email: U.email });
  await executeTool(ctx, "create_project", { name: "Garden shed" });
  await executeTool(ctx, "create_project", { name: "Kitchen tiles" });
  await executeTool(ctx, "create_task", { title: "Buy timber", project: "Garden shed" });
  await executeTool(ctx, "create_task", { title: "Pour the base", project: "Kitchen tiles" });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("update_project with merge_into", () => {
  it.each([
    ["merge_into alone", { merge_into: "Kitchen tiles" }],
    ["with a new name in the same call", { merge_into: "Kitchen tiles", name: "Shed" }],
    ["with a new color in the same call", { merge_into: "Kitchen tiles", color: "#7aa2ff" }],
    ["with delete in the same call", { merge_into: "Kitchen tiles", delete: true }],
    ["into a project that does not exist", { merge_into: "Camping list" }],
  ])("%s: says merging is not available yet, and nothing moves, is renamed or is deleted", async (_what, extra) => {
    const before = await board();
    const res = await executeTool(ctx, "update_project", { project: "Garden shed", ...extra });
    expect((res.result as { error?: string }).error).toMatch(NOT_YET);
    expect(res.toast).toBeUndefined();
    expect(await board()).toEqual(before);
  });
});

describe("the model is not sent to merge", () => {
  it("the tool's description and its merge_into say merging is not available yet", () => {
    const tool = anthropicToolDefs().find((t) => t.name === "update_project")!;
    expect(tool.description).toMatch(NOT_YET);
    expect(tool.description).not.toMatch(/moves all tasks then deletes/i);
    const mergeInto = (tool.input_schema as { properties: Record<string, { description?: string }> }).properties.merge_into;
    expect(mergeInto.description).toMatch(NOT_YET);
  });

  it("the persona no longer tells it to merge duplicate projects", () => {
    const { stable } = buildInstructionParts("", {});
    expect(stable).not.toMatch(/merge_into/);
  });

  it("a delete refused because the project still has tasks does not point at merge_into", async () => {
    const res = await executeTool(ctx, "update_project", { project: "Garden shed", delete: true });
    const error = (res.result as { error?: string }).error ?? "";
    expect(error).toMatch(/still has 1 task/);
    expect(error).not.toMatch(/merge/i);
    expect((await board()).map((p) => p.name)).toContain("Garden shed");
  });
});
