// v1.17 (docs/tasks/SPEC.md §1): a model write never loses his notes. He types his note through the real PATCH
// route; the model writes through the real tools chat and voice call, extraction through applyExtraction, and
// Google through the fake (tests/fixtures/google.ts). Made-up user, made-up notes; no model is called.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { checkins, conversations, events, projects, tasks, user } from "@/lib/db/schema";
import { setGoogleHttpForTests } from "@/lib/google/connection";
import { applyExtraction, type ExtractionResult } from "@/lib/secretary/extraction";
import { toolSchemas } from "@/lib/secretary/tool-schemas";
import { executeTool, liveTurnContext, type ToolContext } from "@/lib/secretary/tools";
import { gatherProject, hashBundle } from "@/lib/understanding/gather";
import { renderBundle } from "@/lib/understanding/prompt";
import { PATCH } from "@/app/api/tasks/[id]/route";
import { connectCalendar, fakeGoogle, type FakeGoogle } from "./fixtures/google";

const TZ = "America/Los_Angeles";
/** His note, as he typed it: colons, a label of his own, a link, accents, a blank line. */
const HIS = "Corrugated, 8 ft long.\nGate code: 4412\nhttps://timber.example/roof?a=1&b=2\nÉtagère — café, naïve.\n\nOwner: me (my own label)";
const users: string[] = [];
let ctx: ToolContext;
let uid: string;
let google: FakeGoogle;

beforeEach(async () => {
  uid = `test-notes-${crypto.randomUUID()}`;
  users.push(uid);
  await db.insert(user).values({ id: uid, name: "Notes", email: `${uid}@v117.test`, timezone: TZ });
  session.user = { id: uid, email: `${uid}@v117.test`, name: "Notes", timezone: TZ };
  ctx = liveTurnContext({ userId: uid, timezone: TZ, attachmentCount: 0 });
  google = fakeGoogle();
  setGoogleHttpForTests(google.http);
});
afterEach(() => setGoogleHttpForTests(null));
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
const mine = async () => db.select().from(tasks).where(eq(tasks.userId, uid));
/** He saves the note from the editor or the view: the real route. */
async function save(id: string, body: Record<string, unknown>) {
  const res = await PATCH(
    new Request(`http://x/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  );
  expect(res.status, "his save is accepted").toBe(200);
  return ((await res.json()) as { task: typeof tasks.$inferSelect }).task;
}
/** A task with his note on it, typed through the route. */
async function hisTask(title: string, extra: Partial<typeof tasks.$inferInsert> = {}, note = HIS) {
  const [t] = await db.insert(tasks).values({ userId: uid, title, status: "todo", source: "typed", ...extra }).returning();
  await save(t.id, { notes: note });
  return t.id;
}
const tool = async (name: string, args: Record<string, unknown>) => (await executeTool(ctx, name, args)).result as Record<string, unknown>;

describe("a model's note is added after his, never in place of it (§1.1)", () => {
  const paths: [string, (id: string, line: string) => Promise<Record<string, unknown>>][] = [
    ["update_task notes", (id, line) => tool("update_task", { task: id, notes: line })],
    ["amend_task note", (id, line) => tool("amend_task", { task: id, note: line })],
    ["log_status progress", (id, line) => tool("log_status", { task: id, signal: "progress", note: line })],
    ["log_status started", (id, line) => tool("log_status", { task: id, signal: "started", note: line })],
    ["log_status postponed", (id, line) => tool("log_status", { task: id, signal: "postponed", new_due_at: "2026-11-20T09:00:00", note: line })],
    ["log_status dropped", (id, line) => tool("log_status", { task: id, signal: "dropped", note: line })],
  ];
  it.each(paths)("%s: his note stays, byte for byte, and the line goes after it; the result says what was added", async (_name, write) => {
    const id = await hisTask("Order the roof panels");
    const out = await write(id, "Ask if they deliver to the side gate.");
    expect(out.error).toBeUndefined();
    expect((await row(id)).notes).toBe(`${HIS}\nAsk if they deliver to the side gate.`);
    expect(out.notes_added).toEqual(["Ask if they deliver to the side gate."]);
  });

  it("two in a row both stay, in order", async () => {
    const id = await hisTask("Fix the gutter");
    await tool("log_status", { task: id, signal: "progress", note: "Bought the brackets." });
    await tool("log_status", { task: id, signal: "progress", note: "Two brackets up." });
    expect((await row(id)).notes).toBe(`${HIS}\nBought the brackets.\nTwo brackets up.`);
  });

  it("the same note again writes nothing, and the result says it was already in the note", async () => {
    const id = await hisTask("Paint the shed door");
    await tool("amend_task", { task: id, note: "Use the green from the porch." });
    const before = await row(id);
    const again = await tool("amend_task", { task: id, note: "Use the green from the porch.  " });
    const after = await row(id);
    expect(after.notes).toBe(before.notes);
    expect(after.updatedAt.getTime(), "nothing was written").toBe(before.updatedAt.getTime());
    expect(again.notes_already_there).toBe(true);
    expect(again.notes_added).toBeUndefined();
  });

  it("a note whose lines are partly there adds only the others, in order, each once; trailing spaces don't count", async () => {
    const id = await hisTask("Order the roof panels");
    const out = await tool("update_task", { task: id, notes: "Gate code: 4412   \nBring the ladder.\n\nBring the ladder.\nAsk for the invoice." });
    expect((await row(id)).notes).toBe(`${HIS}\nBring the ladder.\nAsk for the invoice.`);
    expect(out.notes_added).toEqual(["Bring the ladder.", "Ask for the invoice."]);
  });

  it("on a task with no note, the note is the lines alone", async () => {
    const [t] = await db.insert(tasks).values({ userId: uid, title: "Sharpen the saw", status: "todo", source: "typed" }).returning();
    await tool("amend_task", { task: t.id, note: "The fine-tooth one." });
    expect((await row(t.id)).notes).toBe("The fine-tooth one.");
  });
});

describe("replacing only when he asks (§1.2)", () => {
  it("update_task replace_notes replaces, and the result gives back exactly what it replaced", async () => {
    const id = await hisTask("Order the roof panels");
    const out = await tool("update_task", { task: id, notes: "Only the clear panels now.", replace_notes: true });
    expect((await row(id)).notes).toBe("Only the clear panels now.");
    expect(out.notes_replaced).toBe(HIS);
  });

  it("amend_task replace_note with nothing clears the note, and gives it back", async () => {
    const id = await hisTask("Order the roof panels");
    const out = await tool("amend_task", { task: id, note: "", replace_note: true });
    expect((await row(id)).notes).toBeNull();
    expect(out.notes_replaced).toBe(HIS);
  });

  it("the tool text keeps the flags for when he asks to change or clear the note", () => {
    for (const [name, field] of [["update_task", "replace_notes"], ["amend_task", "replace_note"], ["update_event", "replace_notes"]] as const) {
      const shape = (toolSchemas[name] as unknown as { shape: Record<string, { description?: string }> }).shape;
      expect(shape[field]?.description, `${name}.${field}`).toMatch(/only when the user asks/i);
    }
  });
});

describe("the same title (§1.3)", () => {
  it("create_task with a note, on an open task of the same title: nothing new, the note is added there, and the result says so", async () => {
    const id = await hisTask("Buy wood stain");
    const out = await tool("create_task", { title: "  buy WOOD   stain ", notes: "Oak colour, 2 litres." });
    expect((await mine()).length, "nothing was created").toBe(1);
    expect((await row(id)).notes).toBe(`${HIS}\nOak colour, 2 litres.`);
    expect(out.already_existed).toBe(true);
    expect(out.notes_added).toEqual(["Oak colour, 2 litres."]);
    expect(String(out.note)).toMatch(/added to it/i);
  });

  it("on an open task that is only similar: nothing new, the result names it and says the note was not saved", async () => {
    const id = await hisTask("Buy wood stain");
    const out = await tool("create_task", { title: "Buy the wood stain", notes: "Oak colour, 2 litres." });
    expect((await mine()).length, "nothing was created").toBe(1);
    expect((await row(id)).notes).toBe(HIS);
    expect(out.note_saved).toBe(false);
    expect(String(out.note)).toContain("Buy wood stain");
    expect(String(out.note)).toMatch(/not saved/i);
  });

  it("extraction: a note on an open task of the same title is added; on a similar one it is not saved, and counted", async () => {
    const id = await hisTask("Call the roofer");
    const raw = (title: string, notes: string): ExtractionResult => ({
      tasks: [{ title, notes, due_at: null, project: null }],
      events: [],
      status_updates: [],
      facts: [],
      mentions: [],
      ambiguities: [],
    } as unknown as ExtractionResult);
    const [conv] = await db.insert(conversations).values({ userId: uid, mode: "text" }).returning();
    const same = await applyExtraction(uid, conv.id, raw("call the  Roofer", "He said Thursday works."));
    expect((await row(id)).notes).toBe(`${HIS}\nHe said Thursday works.`);
    expect(same).toMatchObject({ createdTasks: 0, notesAdded: 1, notesNotSaved: 0 });
    const similar = await applyExtraction(uid, conv.id, raw("Call roofer back", "Ask about gutters too."));
    expect((await row(id)).notes).toBe(`${HIS}\nHe said Thursday works.`);
    expect(similar).toMatchObject({ createdTasks: 0, notesAdded: 0, notesNotSaved: 1 });
  });

  it("add_to_list on an item already there: the item gets the note, and the result says so truthfully", async () => {
    await tool("add_to_list", { items: ["lotion"], list: "shopping" });
    const again = await tool("add_to_list", { items: ["lotion"], list: "shopping", note: "the SPF 50 one" });
    const lotion = (await mine()).filter((r) => r.title.toLowerCase() === "lotion");
    expect(lotion.map((r) => r.notes)).toEqual(["the SPF 50 one"]);
    expect(again.already_on_list).toEqual(["Lotion"]);
    expect(again.note_added_to).toEqual(["Lotion"]);
    expect(String(again.read_back)).toMatch(/added the note/i);
    const thrice = await tool("add_to_list", { items: ["lotion"], list: "shopping", note: "the SPF 50 one" });
    expect(thrice.note_added_to ?? []).toEqual([]);
    expect(thrice.note_already_on).toEqual(["Lotion"]);
    expect((await mine()).filter((r) => r.title.toLowerCase() === "lotion").map((r) => r.notes)).toEqual(["the SPF 50 one"]);
  });
});

describe("done and blocked (§1.4, §1.5)", () => {
  it("log_status done with a note: done, the note added, his note kept", async () => {
    const id = await hisTask("Sweep the patio");
    await tool("log_status", { task: id, signal: "done", note: "Used the new broom, it's in the shed." });
    const t = await row(id);
    expect(t.status).toBe("done");
    expect(t.notes).toBe(`${HIS}\nUsed the new broom, it's in the shed.`);
  });

  it("a recurring task done with a note: the note stays on the finished one; the next one copies the note as it was before it", async () => {
    const id = await hisTask("Water the seedlings", { recurrence: "weekly", dueAt: new Date(Date.now() + 86_400_000) });
    await tool("log_status", { task: id, signal: "done", note: "The tray by the window was dry." });
    expect((await row(id)).notes).toBe(`${HIS}\nThe tray by the window was dry.`);
    const next = (await mine()).filter((r) => r.title === "Water the seedlings" && r.id !== id);
    expect(next.map((r) => r.notes)).toEqual([HIS]);
  });

  it("log_status blocked: the reason goes in blocked_reason only; his note is untouched", async () => {
    const id = await hisTask("Move the compost bin");
    await tool("log_status", { task: id, signal: "blocked", note: "waiting on the neighbour's answer" });
    const t = await row(id);
    expect(t.notes).toBe(HIS);
    expect(t.blockedReason).toBe("waiting on the neighbour's answer");
  });
});

describe("his own save keeps what was added while he typed (§1.6)", () => {
  it("lines added since he opened it are kept after his text; a line he deleted stays deleted", async () => {
    const id = await hisTask("Order the roof panels");
    const opened = (await row(id)).notes; // the editor opens
    await tool("amend_task", { task: id, note: "Chat: ask about delivery." }); // a chat turn, meanwhile
    await tool("amend_task", { task: id, note: "Voice: the van is free Friday." }); // a call, meanwhile
    const his = HIS.replace("Gate code: 4412\n", "") + "\nMeasure the gap first.";
    const saved = await save(id, { notes: his, notesBase: opened });
    expect(saved.notes).toBe(`${his}\nChat: ask about delivery.\nVoice: the van is free Friday.`);
    expect(saved.notes).not.toContain("Gate code");
  });

  it("nothing changed since he opened it: his text is stored exactly as sent", async () => {
    const id = await hisTask("Order the roof panels");
    const his = `${HIS}\n  indented, with trailing spaces   \n`;
    expect((await save(id, { notes: his, notesBase: HIS })).notes).toBe(his);
  });

  it("his repeated lines are his: kept, with a line added meanwhile after them", async () => {
    const id = await hisTask("Order the roof panels");
    await tool("amend_task", { task: id, note: "Added meanwhile." });
    const his = "- one\n- one\n- one";
    expect((await save(id, { notes: his, notesBase: HIS })).notes).toBe(`${his}\nAdded meanwhile.`);
  });

  it("a page from before v1.17 sends no base: his text, then the stored lines his text does not have", async () => {
    const id = await hisTask("Order the roof panels");
    await tool("amend_task", { task: id, note: "Added meanwhile." });
    const his = "Just this now.";
    expect((await save(id, { notes: his })).notes).toBe(`${his}\n${HIS.split("\n").filter((l) => l.trim()).join("\n")}\nAdded meanwhile.`);
  });

  it("a replace he asked for by voice while the editor was open: his text, then everything added since, the replacement too", async () => {
    const id = await hisTask("Order the roof panels");
    await tool("update_task", { task: id, notes: "Replaced by voice.", replace_notes: true });
    await tool("amend_task", { task: id, note: "Then one more." });
    const his = `${HIS}\nHis own line.`;
    expect((await save(id, { notes: his, notesBase: HIS })).notes).toBe(`${his}\nReplaced by voice.\nThen one more.`);
  });
});

describe("events (§1.7)", () => {
  it("update_event adds to the event's notes, and Google is sent the whole note as its description", async () => {
    await connectCalendar(uid);
    const made = (await executeTool(ctx, "create_event", { title: "Roofer visit", starts_at: "2026-11-03T10:00:00", notes: "His: park on the left." })).result as { event_id: string };
    await tool("update_event", { event: made.event_id, notes: "Bring the ladder." });
    const [e] = await db.select().from(events).where(eq(events.id, made.event_id));
    expect(e.notes).toBe("His: park on the left.\nBring the ladder.");
    expect(google.calls.patch.at(-1)?.body.description).toBe("His: park on the left.\nBring the ladder.");
    const out = await tool("update_event", { event: made.event_id, notes: "Bring the ladder." });
    expect(out.notes_already_there).toBe(true);
    expect((await db.select().from(events).where(eq(events.id, made.event_id)))[0].notes).toBe("His: park on the left.\nBring the ladder.");
  });
});

describe("what the understanding model reads of a long note (§1.8)", () => {
  it("its head and its tail, the newest line included, in the same 300 characters", async () => {
    const [p] = await db.insert(projects).values({ userId: uid, name: "Shed", status: "active" }).returning();
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of what he wrote about the shed.`);
    lines.push("NEWEST: the roofer comes Thursday.");
    await db.insert(tasks).values({ userId: uid, projectId: p.id, title: "Order the roof panels", status: "todo", source: "typed", notes: lines.join("\n") });
    const text = renderBundle((await gatherProject(uid, p.id, { timezone: TZ, now: new Date() }))!);
    const noteLine = text.split("\n").find((l) => l.trimStart().startsWith("notes:"))!;
    expect(noteLine).toContain("Line 1 of what he wrote");
    expect(noteLine).toContain("NEWEST: the roofer comes Thursday.");
    const shown = noteLine.trimStart().slice("notes: ".length).replace(" … ", "").replace(/ \(cut\)$/, "");
    expect(shown.length).toBeLessThanOrEqual(300);
  });
});

// v1.10: four things 1.17 did right that nothing caught a version breaking (the Reviewer's probe, M9, M22, M24, M27).
describe("gaps the Reviewer's probe found (v1.10)", () => {
  it("M9: he types a line a call is adding at the same time; his save stores it once", async () => {
    const id = await hisTask("Fix the gate", {}, "Hinges are loose.");
    const opened = (await row(id)).notes;
    await tool("amend_task", { task: id, note: "Gate code: 4412" }); // a call, while he types
    const saved = await save(id, { notes: "Hinges are loose.\nGate code: 4412", notesBase: opened });
    expect(saved.notes).toBe("Hinges are loose.\nGate code: 4412");
  });

  it("M22: extraction never gives a note to a finished task of the same title", async () => {
    const [done] = await db
      .insert(tasks)
      .values({ userId: uid, title: "Call the roofer", status: "done", source: "typed", notes: "His note.", completedAt: new Date() })
      .returning();
    const [conv] = await db.insert(conversations).values({ userId: uid, mode: "text" }).returning();
    const out = await applyExtraction(uid, conv.id, {
      tasks: [{ title: "call the roofer", notes: "He said Thursday works.", due_at: null, project: null }],
      events: [],
      status_updates: [],
      facts: [],
      mentions: [],
      ambiguities: [],
    } as unknown as ExtractionResult);
    expect((await row(done.id)).notes).toBe("His note.");
    expect(out).toMatchObject({ createdTasks: 0, notesAdded: 0, notesNotSaved: 1 });
  });

  it("M24: update_task done with a note on a recurring task: the next one takes the note from before it", async () => {
    const id = await hisTask("Water the seedlings", { recurrence: "weekly", dueAt: new Date(Date.now() + 86_400_000) });
    await tool("update_task", { task: id, status: "done", notes: "The tray by the window was dry." });
    expect((await row(id)).notes).toBe(`${HIS}\nThe tray by the window was dry.`);
    const next = (await mine()).filter((r) => r.title === "Water the seedlings" && r.id !== id);
    expect(next.map((r) => r.notes)).toEqual([HIS]);
  });

  it("M9's other half: his line ending in a no-break space and a call's same line are one line", async () => {
    const id = await hisTask("Fix the gate", {}, "Hinges are loose.");
    const opened = (await row(id)).notes;
    await tool("amend_task", { task: id, note: "Gate code: 4412" }); // a call, while he types
    const his = "Hinges are loose.\nGate code: 4412\u00a0";
    const saved = await save(id, { notes: his, notesBase: opened });
    expect(saved.notes).toBe(his);
  });

  it("a blocked reason stays in History: its checkin says what it waited on, after it is unblocked too", async () => {
    const id = await hisTask("Move the compost bin");
    await tool("log_status", { task: id, signal: "blocked", note: "the neighbour's answer" });
    await tool("log_status", { task: id, signal: "started" });
    expect((await row(id)).blockedReason, "unblocked, the field is clear").toBeNull();
    const trail = await db.select().from(checkins).where(eq(checkins.taskId, id));
    expect(trail.map((c) => c.note)).toContain("Status → blocked: the neighbour's answer");
  });

  it("a checkin changes no understanding hash: History is not in what a run reads", async () => {
    const [p] = await db.insert(projects).values({ userId: uid, name: "Garden", status: "active" }).returning();
    const [t] = await db.insert(tasks).values({ userId: uid, projectId: p.id, title: "Move the compost bin", status: "blocked", source: "typed", blockedReason: "the neighbour's answer" }).returning();
    const now = new Date();
    const before = hashBundle((await gatherProject(uid, p.id, { timezone: TZ, now }))!);
    await db.insert(checkins).values({ userId: uid, taskId: t.id, type: "user_update", note: "Status → blocked: the neighbour's answer" });
    expect(hashBundle((await gatherProject(uid, p.id, { timezone: TZ, now }))!)).toBe(before);
  });

  it("M27: his save reads the row under its lock: a line committed while he saves is kept", async () => {
    const id = await hisTask("Order the roof panels");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => (locked = r));
    // Another connection: holds the row, adds a line, and commits only once his save is under way.
    const other = db.transaction(async (tx) => {
      await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).for("update");
      await tx.update(tasks).set({ notes: `${HIS}\nFrom the other connection.` }).where(eq(tasks.id, id));
      locked();
      await held;
    });
    await hasLock;
    const saving = save(id, { notes: `${HIS}\nHis own line.`, notesBase: HIS });
    await new Promise((r) => setTimeout(r, 300)); // his save is waiting on the row now
    release();
    await other;
    const saved = await saving;
    expect(saved.notes).toBe(`${HIS}\nHis own line.\nFrom the other connection.`);
  });
});
