// v1.11 (docs/projects/SPEC.md): his project order. One comparator; a move
// puts a project at a place in its group and places it and everything above
// it; the drag (the route), the chat tool and the call are one operation; a
// move never asks a model; the Overview's run of cards and the Projects tab
// follow it, and a card he placed on the Overview keeps its place. Against the
// local database, through the real entry points; the models are fakes that
// count, and nothing leaves the machine.
process.env.TZ = "UTC";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; timezone: string } }));
/** Every model the app could reach: a call to any of them is counted. */
const models = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return { ...real, requireSession: async () => session.user ?? NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
});
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/anthropic", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/anthropic")>();
  const counted = async () => {
    models.calls++;
    throw new Error("no model in this test");
  };
  const client = { messages: { create: counted, parse: counted, stream: () => ({ on() { return this; }, finalMessage: counted }) } };
  return { ...real, claudeBrainEnabled: () => true, anthropicClientFor: async () => ({ client, source: "house" }), anthropicFor: async () => client };
});
vi.mock("@/lib/openai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/openai")>();
  const counted = async () => {
    models.calls++;
    throw new Error("no model in this test");
  };
  return { ...real, openaiClientFor: async () => ({ client: { responses: { create: counted }, chat: { completions: { create: counted } } }, source: "house" }) };
});

import { db } from "@/lib/db";
import { events, projects, tasks, user } from "@/lib/db/schema";
import { byOrder, byUrgency } from "@/lib/project-order";
import { moveProject } from "@/lib/projects/order";
import { GROUPS, listProjects } from "@/lib/projects/list";
import { buildBriefing } from "@/lib/secretary/briefing";
import { sectionKey } from "@/lib/layout/plan";
import { clearPlanCache, lastPlannerUsage } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, persistPlan } from "@/lib/layout/plan-store";
import { computeSignals, signalsHash } from "@/lib/layout/signals";
import { REGISTRY_VERSION } from "@/lib/layout/registry";
import { anthropicToolDefs, VOICE_TOOL_NAMES } from "@/lib/secretary/tool-schemas";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";
import { POST as orderRoute } from "@/app/api/projects/order/route";
import { PATCH as projectRoute } from "@/app/api/projects/[id]/route";
import { POST as newProjectRoute } from "@/app/api/projects/route";

const TZ = "America/Los_Angeles";
const users: string[] = [];
const day = (n: number) => new Date(Date.now() + n * 86_400_000);

/**
 * His projects, made in this order: Atlas 2 days late, Birch 5 days late, Cedar due in 3 days (all urgent),
 * then Dune, Ember, Fjord with no date; Grove set aside; and two lists. The urgency order of the active ones is
 * Birch, Atlas, Cedar, Dune, Ember, Fjord.
 */
async function his() {
  const id = `test-order-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Order", email: `${id}@v111.test`, timezone: TZ });
  session.user = { id, email: `${id}@v111.test`, name: "Order", timezone: TZ };
  const ids: Record<string, string> = {};
  const add = async (name: string, due: number | null, kind: "project" | "list" = "project", status: "active" | "someday" = "active") => {
    const [p] = await db.insert(projects).values({ userId: id, name, kind, status }).returning();
    ids[name] = p.id;
    await db.insert(tasks).values({ userId: id, projectId: p.id, title: `${name}: a task`, status: "todo", source: "spoken", dueAt: due === null ? null : day(due) });
  };
  await add("Atlas", -2);
  await add("Birch", -5);
  await add("Cedar", 3);
  for (const name of ["Dune", "Ember", "Fjord"]) await add(name, null);
  await add("Grove", null, "project", "someday");
  await add("Shopping", null, "list");
  await add("Packing", null, "list");
  const ctx = liveTurnContext({ userId: id, timezone: TZ, attachmentCount: 0 });
  const nameOf = (projectId: string) => Object.entries(ids).find(([, v]) => v === projectId)?.[0];
  /** The Projects tab, by group, as names. */
  const tab = async () => {
    const rows = await listProjects(id, TZ);
    const group = (r: (typeof rows)[number]) => (r.kind === "list" ? "lists" : r.status === "active" ? "active" : "set aside");
    return {
      active: rows.filter((r) => group(r) === "active").map((r) => r.name),
      lists: rows.filter((r) => group(r) === "lists").map((r) => r.name),
      setAside: rows.filter((r) => group(r) === "set aside").map((r) => r.name),
    };
  };
  /** One visit to the Overview: its cards, as names, and the store that follows it. */
  const overview = async (call?: () => Promise<string>) => {
    const bundle = await computeCurrentPlan(id);
    await persistPlan(id, bundle, call ? { call } : undefined);
    return bundle.plan.sections.filter((s) => s.component === "project_card").map((s) => nameOf(String(s.props?.project_id)));
  };
  const positions = async () =>
    Object.fromEntries((await db.select({ name: projects.name, position: projects.position }).from(projects).where(eq(projects.userId, id))).map((r) => [r.name, r.position]));
  return { id, ids, ctx, tab, overview, positions, move: (project: string, to: Parameters<typeof moveProject>[2]) => moveProject(id, project, to) };
}

/** The names in the briefing's PROJECTS section, in the order it gives them. */
const briefingProjects = (text: string) => {
  const from = text.indexOf("PROJECTS (");
  expect(from, "the briefing has a PROJECTS section").toBeGreaterThan(-1);
  const section = text.slice(from).split("\n\n")[0];
  return [...section.matchAll(/^- "([^"]+)" \(/gm)].map((m) => m[1]);
};

beforeEach(() => {
  clearPlanCache();
  models.calls = 0;
});
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("one comparator", () => {
  const u = (name: string, soonest: number | null, extra: Partial<Parameters<typeof byOrder>[0]> = {}) => ({ name, soonest, ...extra });
  it("lists after projects; then the ones he placed, by position; then urgent first; then the urgency order", () => {
    const all = [
      u("Quiet", null),
      u("Late", -4, { urgent: true }),
      u("Soon", 2, { urgent: true }),
      u("Placed second", null, { position: 1 }),
      u("Placed first", 9, { position: 0 }),
      u("A list placed", null, { list: true, position: 0 }),
      u("A list", null, { list: true }),
      u("Dated", 20),
    ];
    expect(all.toSorted(byOrder).map((x) => x.name)).toEqual(["Placed first", "Placed second", "Late", "Soon", "Dated", "Quiet", "A list placed", "A list"]);
  });
  it("with nothing placed it is the order the cards had before (urgent first, then the urgency order)", () => {
    const all = [u("B", null), u("A", 5), u("C", -1, { urgent: true }), u("D", 30)];
    const before = (a: (typeof all)[number], b: (typeof all)[number]) => Number(!!b.urgent) - Number(!!a.urgent) || byUrgency(a, b);
    expect(all.toSorted(byOrder)).toEqual(all.toSorted(before));
  });
});

describe("the order's last word (v1.11 r2)", () => {
  it("ends on when it was made, then its id: two projects with one name keep their places against each other", () => {
    const twin = (createdAt: string, id: string) => ({ name: "Twin", soonest: null, createdAt, id });
    const older = twin("2026-01-01T00:00:00.000Z", "b");
    const newer = twin("2026-02-01T00:00:00.000Z", "a");
    expect([newer, older].sort(byOrder)).toEqual([older, newer]);
    expect([older, newer].sort(byOrder)).toEqual([older, newer]);
    const one = twin("2026-01-01T00:00:00.000Z", "a");
    const two = twin("2026-01-01T00:00:00.000Z", "b");
    expect([two, one].sort(byOrder)).toEqual([one, two]);
  });

  it("two projects with one name keep their places on the Projects tab and in list_projects when one is recoloured", async () => {
    const h = await his();
    const made = [
      ...(await db.insert(projects).values({ userId: h.id, name: "Twin", status: "active" }).returning()),
      ...(await db.insert(projects).values({ userId: h.id, name: "Twin", status: "active" }).returning()),
    ];
    const expected = made.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)).map((r) => r.id);
    const twins = async () => (await listProjects(h.id, TZ)).filter((r) => r.name === "Twin").map((r) => r.id);
    expect(await twins()).toEqual(expected);
    // A model tells the two apart only by what they hold: the one made first has a task.
    await db.insert(tasks).values({ userId: h.id, projectId: expected[0], title: "Twin: a task", status: "todo", source: "spoken" });
    // The one made first is recoloured: Postgres writes a new copy of its row, which then comes back last.
    for (const color of ["#ff3b30", "#34c759", "#007aff"]) {
      await db.update(projects).set({ color }).where(eq(projects.id, expected[0]));
      expect(await twins(), `after recolouring to ${color}`).toEqual(expected);
      const listed = (await executeTool(h.ctx, "list_projects", {})).result as { name: string; open: number }[];
      expect(listed.filter((p) => p.name === "Twin").map((p) => p.open)).toEqual([1, 0]);
    }
  });
});

describe("urgent first, among what he did not place", () => {
  it("a project whose only date is an event this week is urgent: it stands before the undated ones (the Reviewer's M3)", async () => {
    // Its event makes a deadline within the week (signals.ts infers one from events too), so it is urgent; its
    // urgency key sees no open dated task and no stored deadline. Without "urgent first" it would sort by name among
    // the undated ones, last.
    const h = await his();
    const [z] = await db.insert(projects).values({ userId: h.id, name: "Zinnia", status: "active" }).returning();
    await db.insert(tasks).values({ userId: h.id, projectId: z.id, title: "Zinnia: a task", status: "todo", source: "spoken" });
    await db.insert(events).values({ userId: h.id, projectId: z.id, title: "Zinnia: the visit", startsAt: day(3) });
    expect((await h.tab()).active).toEqual(["Birch", "Atlas", "Cedar", "Zinnia", "Dune", "Ember", "Fjord"]);
  });
});

describe("a move: a project to a place in its group, it and everything above it placed", () => {
  it("down one is a move: the project goes one place down", async () => {
    const h = await his();
    expect(await h.move("Birch", "down")).toMatchObject({ ok: true, place: 2 });
    expect((await h.tab()).active).toEqual(["Atlas", "Birch", "Cedar", "Dune", "Ember", "Fjord"]);
    expect(await h.move("Birch", "down")).toMatchObject({ ok: true, place: 3 });
    expect((await h.tab()).active).toEqual(["Atlas", "Cedar", "Birch", "Dune", "Ember", "Fjord"]);
  });

  it("before any move the Projects tab is in the one order within each group (it was alphabetical)", async () => {
    const h = await his();
    expect(await h.tab()).toEqual({ active: ["Birch", "Atlas", "Cedar", "Dune", "Ember", "Fjord"], lists: ["Packing", "Shopping"], setAside: ["Grove"] });
    expect(Object.values(await h.positions()).every((p) => p === null)).toBe(true);
  });

  it("to the top places that one project; the rest keep the urgency order below it", async () => {
    const h = await his();
    expect(await h.move("Fjord", "top")).toMatchObject({ ok: true, name: "Fjord", place: 1 });
    expect((await h.tab()).active).toEqual(["Fjord", "Birch", "Atlas", "Cedar", "Dune", "Ember"]);
    expect(await h.positions()).toMatchObject({ Fjord: 0, Birch: null, Atlas: null, Cedar: null, Dune: null, Ember: null });
  });

  it("to a place lower down places it and every project above it, in the order they stand", async () => {
    const h = await his();
    expect(await h.move("Ember", { index: 2 })).toMatchObject({ ok: true, place: 3 });
    expect((await h.tab()).active).toEqual(["Birch", "Atlas", "Ember", "Cedar", "Dune", "Fjord"]);
    expect(await h.positions()).toMatchObject({ Birch: 0, Atlas: 1, Ember: 2, Cedar: null, Dune: null, Fjord: null });
    // Up one, down one, above and below another: the same operation, said otherwise.
    expect(await h.move("Ember", "up")).toMatchObject({ ok: true, place: 2 });
    expect((await h.tab()).active).toEqual(["Birch", "Ember", "Atlas", "Cedar", "Dune", "Fjord"]);
    expect(await h.move("Dune", { above: "Ember" })).toMatchObject({ ok: true, place: 2 });
    expect((await h.tab()).active).toEqual(["Birch", "Dune", "Ember", "Atlas", "Cedar", "Fjord"]);
    expect(await h.move("Birch", { below: "Atlas" })).toMatchObject({ ok: true, place: 4 });
    expect((await h.tab()).active).toEqual(["Dune", "Ember", "Atlas", "Birch", "Cedar", "Fjord"]);
    // Down to the bottom: it passes every project, and all of them are placed.
    expect(await h.move("Dune", "bottom")).toMatchObject({ ok: true, place: 6 });
    expect((await h.tab()).active).toEqual(["Ember", "Atlas", "Birch", "Cedar", "Fjord", "Dune"]);
    expect(Object.entries(await h.positions()).filter(([n]) => ["Ember", "Atlas", "Birch", "Cedar", "Fjord", "Dune"].includes(n)).every(([, p]) => p !== null)).toBe(true);
  });

  it("a project he placed stays above one that becomes more urgent; urgency still orders the ones he did not place", async () => {
    const h = await his();
    await h.move("Dune", "top");
    await db.insert(tasks).values({ userId: h.id, projectId: h.ids.Fjord, title: "Fjord: late now", status: "todo", source: "spoken", dueAt: day(-9) });
    expect((await h.tab()).active).toEqual(["Dune", "Fjord", "Birch", "Atlas", "Cedar", "Ember"]);
  });

  it("a move stays in its group: a list among lists, a set-aside project among set-aside ones", async () => {
    const h = await his();
    expect(await h.move("Shopping", "top")).toMatchObject({ ok: true, place: 1 });
    expect(await h.tab()).toEqual({ active: ["Birch", "Atlas", "Cedar", "Dune", "Ember", "Fjord"], lists: ["Shopping", "Packing"], setAside: ["Grove"] });
    // Lists after projects on the Overview too, placed or not.
    const cards = await h.overview();
    expect(cards.slice(-2)).toEqual(["Shopping", "Packing"]);
  });

  it("a project that changes group arrives unplaced, at its urgency place; the group it left keeps its order", async () => {
    const h = await his();
    await h.move("Ember", { index: 2 });
    expect((await h.tab()).active).toEqual(["Birch", "Atlas", "Ember", "Cedar", "Dune", "Fjord"]);
    const patch = (name: string, status: string) =>
      projectRoute(new Request(`http://localhost/api/projects/${h.ids[name]}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }), { params: Promise.resolve({ id: h.ids[name] }) });
    expect((await patch("Ember", "someday")).status).toBe(200);
    expect(await h.tab()).toMatchObject({ active: ["Birch", "Atlas", "Cedar", "Dune", "Fjord"], setAside: ["Ember", "Grove"] });
    expect((await h.positions()).Ember).toBeNull();
    expect((await patch("Ember", "active")).status).toBe(200);
    expect((await h.tab()).active).toEqual(["Birch", "Atlas", "Cedar", "Dune", "Ember", "Fjord"]);
    // Within one group (set aside, then archived) nothing changes.
    await h.move("Grove", "top");
    expect((await patch("Grove", "archived")).status).toBe(200);
    expect((await h.positions()).Grove).toBe(0);
  });

  it("two moves at once are one after the other: the order is one that either could have left, with no place given twice", async () => {
    const h = await his();
    const [a, b] = await Promise.all([h.move("Fjord", "top"), h.move("Ember", "top")]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    const active = (await h.tab()).active;
    expect([["Fjord", "Ember"], ["Ember", "Fjord"]]).toContainEqual(active.slice(0, 2));
    const placed = Object.values(await h.positions()).filter((p): p is number => p !== null);
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("refuses what it cannot do, plainly, and changes nothing", async () => {
    const h = await his();
    const before = await h.positions();
    expect(await h.move("Nowhere", "top")).toMatchObject({ ok: false });
    expect(await h.move("Atlas", { above: "Shopping" })).toMatchObject({ ok: false, error: expect.stringMatching(/not in the same group|a list/i) });
    expect(await h.positions()).toEqual(before);
  });
});

describe("the drag, the chat and the call are one operation", () => {
  it("the route the drag posts to moves the project to that place in its group", async () => {
    const h = await his();
    const res = await orderRoute(new Request("http://localhost/api/projects/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: h.ids.Ember, to: 0 }) }));
    expect(res.status).toBe(200);
    expect((await h.tab()).active).toEqual(["Ember", "Birch", "Atlas", "Cedar", "Dune", "Fjord"]);
    const other = await orderRoute(new Request("http://localhost/api/projects/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "not-his", to: 0 }) }));
    expect(other.status).toBe(404);
  });

  it("move_project, in chat and on a call, says where the project is now", async () => {
    const h = await his();
    expect(VOICE_TOOL_NAMES).toContain("move_project");
    const res = await executeTool(h.ctx, "move_project", { project: "ember", to: "top" });
    expect(res.result).toMatchObject({ project: "Ember", place: 1, of: 6 });
    expect((res.result as { says: string }).says).toMatch(/Ember is at the top of your projects/);
    expect(res.toast?.text).toMatch(/Ember/);
    expect((await h.tab()).active[0]).toBe("Ember");
    expect((await executeTool(h.ctx, "move_project", { project: "Ember", above: "Cedar" })).result).toMatchObject({ place: 3 });
    expect((await executeTool(h.ctx, "move_project", { project: "Nowhere", to: "top" })).result).toHaveProperty("error");
  });

  it("the descriptions say which tool: move_project for his project order, arrange_dashboard for a section on the Overview", () => {
    const defs = anthropicToolDefs();
    expect(defs.find((t) => t.name === "move_project")!.description).toMatch(/Projects tab/);
    expect(defs.find((t) => t.name === "arrange_dashboard")!.description).toMatch(/move_project/);
  });
});

describe("a move costs nothing", () => {
  it("after a drag and after the tool, the Overview asks no planner and no model: the signals' hash does not carry the order", async () => {
    const h = await his();
    let planner = 0;
    const call = async () => {
      planner++;
      lastPlannerUsage.model = "claude-sonnet-5";
      lastPlannerUsage.input = 4_000;
      lastPlannerUsage.output = 800;
      return JSON.stringify({ plan_id: "p", reason_summary: "A busy week", sections: [] });
    };
    await h.overview(call);
    const asked = planner;
    const hash = signalsHash(await computeSignals(h.id), REGISTRY_VERSION);
    await orderRoute(new Request("http://localhost/api/projects/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: h.ids.Fjord, to: 0 }) }));
    expect(signalsHash(await computeSignals(h.id), REGISTRY_VERSION)).toBe(hash);
    expect((await h.overview(call))[0]).toBe("Fjord");
    await executeTool(h.ctx, "move_project", { project: "Dune", to: "top" });
    expect((await h.overview(call)).slice(0, 2)).toEqual(["Dune", "Fjord"]);
    expect(planner - asked).toBe(0);
    expect(models.calls).toBe(0);
  });
});

describe("the Overview", () => {
  it("the run of cards follows his order, then urgency", async () => {
    const h = await his();
    expect(await h.overview()).toEqual(["Birch", "Atlas", "Cedar", "Dune", "Ember", "Fjord", "Packing", "Shopping"]);
    await h.move("Ember", "top");
    await h.move("Dune", { index: 1 });
    expect(await h.overview()).toEqual(["Ember", "Dune", "Birch", "Atlas", "Cedar", "Fjord", "Packing", "Shopping"]);
  });

  it("a card he placed on the Overview keeps its place, and the answer to a move says so, dragged or asked", async () => {
    const h = await his();
    await h.overview();
    // Fjord's card sent to the top of the Overview itself (v1.02): his place on the board.
    expect((await executeTool(h.ctx, "arrange_dashboard", { operations: [{ op: "move_to_top", section: "Fjord" }] })).result).toMatchObject({ applied: true });
    const board = async () => (await computeCurrentPlan(h.id)).plan.sections.map(sectionKey);
    const placedAt = (await board()).indexOf(`project_card:${h.ids.Fjord}`);
    const res = await executeTool(h.ctx, "move_project", { project: "Fjord", to: "bottom" });
    expect((res.result as { says: string }).says).toMatch(/On the Overview, its card stays where you put it/);
    expect((await board()).indexOf(`project_card:${h.ids.Fjord}`)).toBe(placedAt);
    expect((await h.tab()).active.at(-1)).toBe("Fjord");
    // The drag: the same answer, for the page to show.
    const dragged = await orderRoute(new Request("http://localhost/api/projects/order", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: h.ids.Fjord, to: 0 }) }));
    expect(await dragged.json()).toMatchObject({ ok: true, says: expect.stringMatching(/On the Overview, its card stays where you put it/) });
    expect((await board()).indexOf(`project_card:${h.ids.Fjord}`)).toBe(placedAt);
    // A project whose card he did not place: no such sentence.
    const plain = await executeTool(h.ctx, "move_project", { project: "Dune", to: "top" });
    expect((plain.result as { says: string }).says).not.toMatch(/Overview/);
  });
});

describe("New project, on the Projects tab", () => {
  const make = (name: string) =>
    newProjectRoute(new Request("http://localhost/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }));
  it("makes the project by the chat's own path: it arrives unplaced, at its urgency place", async () => {
    const h = await his();
    await h.move("Fjord", "top");
    const res = await make("Bike tune-up");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "Bike tune-up", alreadyExisted: false });
    expect((await h.positions())["Bike tune-up"]).toBeNull();
    expect((await h.tab()).active).toEqual(["Fjord", "Birch", "Atlas", "Cedar", "Bike tune-up", "Dune", "Ember"]);
  });
  it("an empty name makes nothing; a name he already has is that project, not a second one", async () => {
    const h = await his();
    const before = (await db.select().from(projects).where(eq(projects.userId, h.id))).length;
    expect((await make("   ")).status).toBe(400);
    const again = await make("ember");
    expect(await again.json()).toMatchObject({ name: "Ember", alreadyExisted: true });
    expect((await db.select().from(projects).where(eq(projects.userId, h.id))).length).toBe(before);
  });
});

describe("what a model is handed", () => {
  it("the groups keep their order whatever he placed: active, then lists, then set aside (the tab's rows, list_projects, the briefing)", async () => {
    const h = await his();
    // Placed first in its own group: by the one order alone it would stand before every active project.
    await h.move("Grove", "top");
    const rows = await listProjects(h.id, TZ);
    const groups = rows.map((r) => r.group);
    expect(groups).toEqual(groups.toSorted((a, b) => GROUPS.indexOf(a) - GROUPS.indexOf(b)));
    expect(rows.at(-1)!.name).toBe("Grove");
    const active = ["Atlas", "Birch", "Cedar", "Dune", "Ember", "Fjord"];
    const listed = ((await executeTool(h.ctx, "list_projects", {})).result as { name: string }[]).map((p) => p.name);
    expect(listed.indexOf("Grove")).toBeGreaterThan(Math.max(...active.map((n) => listed.indexOf(n))));
    const briefed = briefingProjects((await buildBriefing(h.id, TZ)).text);
    expect(briefed.indexOf("Grove")).toBeGreaterThan(Math.max(...active.map((n) => briefed.indexOf(n))));
  });

  it("the briefing's PROJECTS are in his order", async () => {
    const h = await his();
    await h.move("Fjord", "top");
    await h.move("Dune", { index: 1 });
    const briefed = briefingProjects((await buildBriefing(h.id, TZ)).text);
    expect(briefed.filter((n) => ["Atlas", "Birch", "Cedar", "Dune", "Ember", "Fjord"].includes(n))).toEqual(["Fjord", "Dune", "Birch", "Atlas", "Cedar", "Ember"]);
  });

  it("list_projects gives his projects in the one order", async () => {
    const h = await his();
    await h.move("Fjord", "top");
    const listed = (await executeTool(h.ctx, "list_projects", {})).result as { name: string }[];
    expect(listed.map((p) => p.name).filter((n) => ["Atlas", "Birch", "Cedar", "Dune", "Ember", "Fjord"].includes(n))).toEqual(["Fjord", "Birch", "Atlas", "Cedar", "Dune", "Ember"]);
  });
});
