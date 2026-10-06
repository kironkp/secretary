// SEC-A003: Kiron's screenshot of 10-06, replayed against the tools voice and
// chat share. He said "Please add lotion to my shopping list for the boat"
// and got a task "buy lotion for the boat" under Personal; then "Can you put
// the shopping list at the top of the dashboard?" and heard "Sure, let me
// move that so it's easier to reach", then "I can't move the dashboard
// sections with the tools I have right now." No model is called here.
process.env.TZ = "UTC";

import { afterAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, projects, tasks, user } from "@/lib/db/schema";
import { computeCurrentPlan, getPlanHead } from "@/lib/layout/plan-store";
import { sectionKey, type LayoutPlan } from "@/lib/layout/plan";
import { buildInstructions, CHAT_ONLY_IN_PERSONA, VOICE_MODALITY_RULES } from "@/lib/secretary/persona";
import { itemTitle, listFor, parseListPhrase } from "@/lib/secretary/lists";
import { refreshProcrastinationScores } from "@/lib/secretary/procrastination";
import { openAIToolDefs, openAIVoiceToolDefs, VOICE_TOOL_NAMES } from "@/lib/secretary/tool-schemas";
import { executeTool, liveTurnContext, resolveProject } from "@/lib/secretary/tools";
import { gatherAll, gatherProject, loadProjectNames } from "@/lib/understanding/gather";

const TZ = "America/Los_Angeles";
const users: string[] = [];

async function newUser(projectNames: string[] = []): Promise<string> {
  const id = `test-lists-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Lists Tester", email: `${id}@sec-a003.test`, timezone: TZ });
  for (const name of projectNames) await db.insert(projects).values({ userId: id, name });
  return id;
}
const call = (userId: string) => liveTurnContext({ userId, timezone: TZ, attachmentCount: 0 });
const projectsOf = (userId: string) =>
  db.select({ id: projects.id, name: projects.name, kind: projects.kind }).from(projects).where(eq(projects.userId, userId));

afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("lists: 'add lotion to my shopping list for the boat'", () => {
  it("is Lotion on the Shopping list, noted 'for the boat', said back truthfully; no Boat project", async () => {
    const userId = await newUser(["Personal"]);
    const out = await executeTool(call(userId), "add_to_list", { items: ["lotion"], list: "shopping list for the boat" });
    expect(out.result).toMatchObject({
      list: "Shopping",
      list_created: true,
      added: ["Lotion"],
      note: "for the boat",
      read_back: "Added Lotion to your Shopping list (for the boat).",
    });
    const shopping = (await projectsOf(userId)).find((p) => p.kind === "list")!;
    expect((await projectsOf(userId)).map((p) => [p.name, p.kind]).sort()).toEqual([
      ["Personal", "project"],
      ["Shopping", "list"],
    ]);
    const [item] = await db.select().from(tasks).where(eq(tasks.userId, userId));
    expect(item).toMatchObject({ title: "Lotion", notes: "for the boat", projectId: shopping.id, status: "todo" });

    // Said the other way round, it is the same item, once.
    const again = await executeTool(call(userId), "add_to_list", { items: ["buy lotion"], note: "for the boat" });
    expect(again.result).toMatchObject({ list: "Shopping", added: [], already_on_list: ["Lotion"], read_back: "Lotion is already on it." });
    expect(await db.select().from(tasks).where(eq(tasks.userId, userId))).toHaveLength(1);
  });

  it("a list phrase never makes a project, whichever tool the model picks", async () => {
    const userId = await newUser(["Personal"]);
    const resolved = await resolveProject(userId, "my shopping list for the boat");
    expect(resolved.matched).toBe("list");
    expect(resolved.project).toMatchObject({ name: "Shopping", kind: "list" });
    await executeTool(call(userId), "create_task", { title: "Sunscreen", project: "my shopping list for the boat" });
    await executeTool(call(userId), "create_commitment", { title: "Towels", project: "shopping list" });
    expect((await projectsOf(userId)).map((p) => [p.name, p.kind]).sort()).toEqual([
      ["Personal", "project"],
      ["Shopping", "list"],
    ]);
    const onShopping = await db
      .select({ title: tasks.title })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.projectId, resolved.project!.id)));
    expect(onShopping.map((t) => t.title).sort()).toEqual(["Sunscreen", "Towels"]);
  });

  it("names: shopping is the default; a list he names is its own", () => {
    expect(parseListPhrase("my shopping list for the boat")).toEqual({ name: "Shopping", purpose: "for the boat" });
    expect(parseListPhrase("packing list")).toEqual({ name: "Packing", purpose: null });
    expect(parseListPhrase("my boat list")).toEqual({ name: "Boat", purpose: null });
    expect(parseListPhrase("the Caltrans project")).toBeNull();
    expect(listFor(undefined)).toEqual({ name: "Shopping", purpose: null });
    expect(listFor("shopping")).toEqual({ name: "Shopping", purpose: null });
    expect(listFor("Shopping for the boat")).toEqual({ name: "Shopping", purpose: "for the boat" });
    expect(itemTitle("buy some lotion")).toBe("Lotion");
    expect(itemTitle("paper towels")).toBe("Paper towels");
  });

  it("list_items reads the list back; an item ticked off leaves it", async () => {
    const userId = await newUser();
    await executeTool(call(userId), "add_to_list", { items: ["lotion", "hats"], note: "for the boat" });
    await executeTool(call(userId), "add_to_list", { items: ["ice"], list: "packing" });
    const shopping = await executeTool(call(userId), "list_items", {});
    expect(shopping.result).toMatchObject({ list: "Shopping", read_back: "Shopping: Lotion (for the boat) and Hats (for the boat)." });
    const [lotion] = await db.select().from(tasks).where(and(eq(tasks.userId, userId), eq(tasks.title, "Lotion")));
    await executeTool(call(userId), "complete_task", { task: lotion.id });
    expect((await executeTool(call(userId), "list_items", { list: "shopping" })).result).toMatchObject({
      read_back: "Shopping: Hats (for the boat).",
    });
    expect((await executeTool(call(userId), "list_items", { list: "packing list" })).result).toMatchObject({ read_back: "Packing: Ice." });
  });
});

describe("arrange_dashboard: 'can you put the shopping list at the top of the dashboard?'", () => {
  const keys = (plan: LayoutPlan) => plan.sections.map((s) => sectionKey(s));

  it("moves the Shopping card to the top at once, pins it there, says so, and calls no model", async () => {
    const userId = await newUser(["Caltrans", "Personal"]);
    await executeTool(call(userId), "add_to_list", { items: ["lotion"], note: "for the boat" });
    const shopping = (await projectsOf(userId)).find((p) => p.kind === "list")!;
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const out = await executeTool(call(userId), "arrange_dashboard", {
        operations: [{ op: "move_to_top", section: "shopping list" }],
      });
      expect(out.result).toMatchObject({ applied: true, read_back: "Done: moved Shopping list to the top." });
      expect(out.toast).toEqual({ icon: "layout", text: "Dashboard rearranged" });
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
    const head = (await getPlanHead(userId))!;
    expect(keys(head.spec as LayoutPlan)[0]).toBe(`project_card:${shopping.id}`);
    expect(head.pinned).toContain(`project_card:${shopping.id}`);
    // What the page renders now.
    expect(keys((await computeCurrentPlan(userId)).plan)[0]).toBe(`project_card:${shopping.id}`);
  });

  it("a pin preference on another section does not refuse the user's own move", async () => {
    const userId = await newUser(["Caltrans", "Personal"]);
    await db.insert(layoutPreferences).values({ userId, kind: "pin_section", value: { section: "hero_next_up" } });
    const caltrans = (await projectsOf(userId)).find((p) => p.name === "Caltrans")!;
    const out = await executeTool(call(userId), "arrange_dashboard", { operations: [{ op: "move_to_top", section: "caltrans" }] });
    expect(out.result).toMatchObject({ applied: true });
    expect(keys((await getPlanHead(userId))!.spec as LayoutPlan)[0]).toBe(`project_card:${caltrans.id}`);
  });

  it("hide stays hidden when the data changes; show brings it back", async () => {
    const userId = await newUser(["Caltrans"]);
    const hid = await executeTool(call(userId), "arrange_dashboard", { operations: [{ op: "hide", section: "the timeline" }] });
    expect(hid.result).toMatchObject({ applied: true, read_back: "Done: hid timeline." });
    expect(keys((await getPlanHead(userId))!.spec as LayoutPlan)).not.toContain("timeline");
    // New work changes the signals, so the board is planned again.
    await executeTool(call(userId), "create_task", { title: "Send the CPO", project: "Caltrans" });
    expect(keys((await computeCurrentPlan(userId)).plan)).not.toContain("timeline");

    const shown = await executeTool(call(userId), "arrange_dashboard", { operations: [{ op: "show", section: "timeline" }] });
    expect(shown.result).toMatchObject({ applied: true });
    expect(keys((await computeCurrentPlan(userId)).plan)).toContain("timeline");
    expect(
      await db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, userId), eq(layoutPreferences.kind, "hide_section")))
    ).toEqual([]);
  });

  it("a section that isn't there is said, and nothing changes", async () => {
    const userId = await newUser(["Caltrans"]);
    await executeTool(call(userId), "arrange_dashboard", { operations: [{ op: "move_down", section: "stats" }] });
    const before = (await getPlanHead(userId))!.version;
    const out = await executeTool(call(userId), "arrange_dashboard", { operations: [{ op: "move_to_top", section: "weather" }] });
    expect(String((out.result as { error: string }).error)).toMatch(/^There's no "weather" on the dashboard/);
    expect((await getPlanHead(userId))!.version).toBe(before);
  });
});

describe("a list is not work", () => {
  it("understanding never reads a list, and the model's project names leave it out", async () => {
    const userId = await newUser(["Caltrans"]);
    await executeTool(call(userId), "add_to_list", { items: ["lotion"] });
    const shopping = (await projectsOf(userId)).find((p) => p.kind === "list")!;
    const now = new Date();
    const bundles = await gatherAll(userId, { now, timezone: TZ });
    expect(bundles.map((b) => b.project.name)).toEqual(["Caltrans"]);
    expect(await gatherProject(userId, shopping.id, { now, timezone: TZ })).toBeNull();
    expect(await loadProjectNames(userId)).toEqual(["Caltrans"]);
  });

  it("a list item scores no procrastination, however long it sits", async () => {
    const userId = await newUser(["Caltrans"]);
    await executeTool(call(userId), "add_to_list", { items: ["lotion"] });
    const [caltrans] = (await projectsOf(userId)).filter((p) => p.name === "Caltrans");
    const old = new Date(Date.now() - 60 * 86_400_000);
    await db.update(tasks).set({ postponedCount: 4, createdAt: old }).where(eq(tasks.userId, userId));
    await db.insert(tasks).values({ userId, title: "Send the CPO", projectId: caltrans.id, status: "todo", postponedCount: 4, createdAt: old });
    await refreshProcrastinationScores(userId);
    const rows = await db.select({ title: tasks.title, score: tasks.procrastinationScore }).from(tasks).where(eq(tasks.userId, userId));
    expect(rows.find((r) => r.title === "Lotion")?.score).toBe(0);
    expect(rows.find((r) => r.title === "Send the CPO")!.score).toBeGreaterThanOrEqual(3);
  });
});

describe("never announce before it's done", () => {
  it("voice and chat carry the rule; a slow lookup's filler names no action", () => {
    const shared = buildInstructions("", {});
    expect(shared).toContain("Never announce an action before it happens");
    const search = openAIToolDefs().find((t) => t.name === "search_web")!;
    expect(search.description).toContain("say only a brief 'one sec' first");
    expect(search.description).not.toMatch(/looking that up/);
  });

  it("the voice is never told it can call a tool it lacks", () => {
    const all = openAIToolDefs().map((t) => t.name);
    const voice = new Set<string>(VOICE_TOOL_NAMES);
    const named = (text: string) => all.filter((n) => new RegExp(`\\b${n}\\b`).test(text));
    // The voice rules name only tools the call has.
    expect(named(VOICE_MODALITY_RULES).filter((n) => !voice.has(n))).toEqual([]);
    // The shared persona's other tools are the reviewed chat-only list, which the voice rules cover.
    expect(named(buildInstructions("", {})).filter((n) => !voice.has(n)).sort()).toEqual([...CHAT_ONLY_IN_PERSONA].sort());
    expect(VOICE_MODALITY_RULES).toContain("that's one for the chat");
  });

  it("the call carries the list and dashboard tools, in shapes the Realtime API accepts", () => {
    const defs = openAIVoiceToolDefs();
    for (const name of ["add_to_list", "list_items", "arrange_dashboard"]) {
      const def = defs.find((d) => d.name === name);
      expect(def, name).toBeDefined();
      expect(JSON.stringify(def!.parameters)).not.toMatch(/"(oneOf|anyOf)"/);
    }
  });
});
