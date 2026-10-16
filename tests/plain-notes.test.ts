// v1.10 (docs/tasks/SPEC.md §2.1–§2.3): notes are plain words, priority is neither shown nor asked, a suggestion's
// note is its reason. Through the real tools (a live turn is one the chat route or the voice tools route marks
// live), applyExtraction and insertSuggestions with faked output, and the Workspace resolver. Made-up user, made-up
// notes; no model is called.
process.env.TZ = "UTC";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));

import { db } from "@/lib/db";
import { conversations, tasks, user } from "@/lib/db/schema";
import { applyExtraction, extractionSchema, type ExtractionResult } from "@/lib/secretary/extraction";
import { NY_SECRETARY_PERSONA, SECRETARY_PERSONA, VOICE_MODALITY_RULES } from "@/lib/secretary/persona";
import { insertSuggestions } from "@/lib/secretary/suggestions";
import { anthropicToolDefs, toolSchemas } from "@/lib/secretary/tool-schemas";
import { executeTool, liveTurnContext, type ToolContext } from "@/lib/secretary/tools";
import { bindingQuerySchema } from "@/lib/workspace/types";
import { resolveBinding } from "@/lib/workspace/bindings";

const TZ = "America/Los_Angeles";
const users: string[] = [];
let uid: string;
let live: ToolContext;
let notLive: ToolContext;
beforeEach(async () => {
  uid = `test-plain-${crypto.randomUUID()}`;
  users.push(uid);
  await db.insert(user).values({ id: uid, name: "Plain", email: `${uid}@v110.test`, timezone: TZ });
  // A chat or voice turn: the route marks it live.
  live = { ...liveTurnContext({ userId: uid, timezone: TZ, attachmentCount: 0 }), live: true } as ToolContext;
  // Anything else that runs a tool (an understanding answer builds just this).
  notLive = { userId: uid, timezone: TZ };
});
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
const mine = async () => db.select().from(tasks).where(eq(tasks.userId, uid));
const tool = async (ctx: ToolContext, name: string, args: Record<string, unknown>) => (await executeTool(ctx, name, args)).result as Record<string, unknown>;
async function aTask(title = "Order the roof panels", notes: string | null = "His own words.") {
  const [t] = await db.insert(tasks).values({ userId: uid, title, status: "todo", source: "typed", notes }).returning();
  return t.id;
}

/** Labelled notes in each form the backstop reads, with the line that should trip it. */
const LABELLED: [string, string][] = [
  ["Owner: Sam", "Owner: Sam"],
  ["- Owner: Sam", "- Owner: Sam"],
  ["* **Next action:** call the yard", "* **Next action:** call the yard"],
  ["1. Status — waiting on the yard", "1. Status — waiting on the yard"],
  ["DEPENDENCIES: the permit", "DEPENDENCIES: the permit"],
  ["Effort：two hours", "Effort：two hours"],
  ["Evidence = the email from Friday", "Evidence = the email from Friday"],
  ["Blocked by – the landlord", "Blocked by – the landlord"],
  ["_Waiting on_: the quote", "_Waiting on_: the quote"],
  ["Ask about the side gate.\\nNext steps: call them back", "Next steps: call them back"],
  ["Bring the ladder.\nStatus of record: open", "Status of record: open"],
  ["Sources: the yard's site", "Sources: the yard's site"],
  ["Deadline: Friday", "Deadline: Friday"],
  ["Due: Friday", "Due: Friday"],
  ["Priority: high", "Priority: high"],
  ["Assignees: me and Sam", "Assignees: me and Sam"],
  ["Depends on: the permit", "Depends on: the permit"],
  ["Blockers: none", "Blockers: none"],
];
/** Details that are plain words, colons and all: stored as written. */
const PLAIN = [
  "Gate code: 4412",
  "Bring the ladder.\nAsk for the invoice.",
  "11:00 AM PT / 2:00 PM ET",
  "https://timber.example/roof?a=1&b=2",
  "Mon: 8-5",
  "Call first. Owner: Sam",
  "Due to the rain we moved it.",
];

describe("a labelled note in a live turn is not saved; the rest of the call is (§2.1)", () => {
  it.each(LABELLED)("amend_task %j: not saved, and the result names the line and says how", async (note, line) => {
    const id = await aTask();
    const out = await tool(live, "amend_task", { task: id, note });
    expect((await row(id)).notes).toBe("His own words.");
    expect(out.note_not_saved).toMatchObject({ line });
    expect(JSON.stringify(out.note_not_saved)).toMatch(/say it as plain words, a line or two/i);
  });

  it("create_task: the task is made, without the note", async () => {
    const out = await tool(live, "create_task", { title: "Paint the shed door", notes: "Owner: Sam\nNext action: buy paint" });
    const made = (await mine()).find((r) => r.title === "Paint the shed door")!;
    expect(made, "the task was made").toBeTruthy();
    expect(made.notes).toBeNull();
    expect(out.note_not_saved).toMatchObject({ line: "Owner: Sam" });
  });

  it("update_task: the status changes, the note does not", async () => {
    const id = await aTask();
    const out = await tool(live, "update_task", { task: id, status: "in_progress", notes: "Status: started" });
    const t = await row(id);
    expect(t.status).toBe("in_progress");
    expect(t.notes).toBe("His own words.");
    expect(out.note_not_saved).toBeTruthy();
  });

  it("log_status done: done, without the note", async () => {
    const id = await aTask();
    const out = await tool(live, "log_status", { task: id, signal: "done", note: "Evidence: the receipt" });
    const t = await row(id);
    expect(t.status).toBe("done");
    expect(t.notes).toBe("His own words.");
    expect(out.note_not_saved).toBeTruthy();
  });

  it("add_to_list: the items go on, without the note", async () => {
    const out = await tool(live, "add_to_list", { items: ["lotion"], list: "shopping", note: "Source: the pharmacy flyer" });
    const lotion = (await mine()).find((r) => r.title.toLowerCase() === "lotion")!;
    expect(lotion.notes).toBeNull();
    expect(out.added).toEqual(["Lotion"]);
    expect(out.note_not_saved).toBeTruthy();
  });

  it.each(PLAIN)("a plain detail %j is stored as written", async (note) => {
    const id = await aTask("Fix the gate", null);
    const out = await tool(live, "amend_task", { task: id, note });
    expect((await row(id)).notes).toBe(note.split("\n").map((l) => l.trimEnd()).join("\n"));
    expect(out.note_not_saved).toBeUndefined();
  });
});

describe("the check reads the model's new text only, never his (§2.1)", () => {
  const HIS = "Owner: me (my own label)\nGate code: 4412";
  it("his own labels don't stop a plain note the model adds", async () => {
    const id = await aTask("Fix the gate", HIS);
    const out = await tool(live, "amend_task", { task: id, note: "Bring the ladder." });
    expect((await row(id)).notes).toBe(`${HIS}\nBring the ladder.`);
    expect(out.note_not_saved).toBeUndefined();
  });

  it("a done recurring task's next copy carries his labelled note unchecked", async () => {
    const [t] = await db
      .insert(tasks)
      .values({ userId: uid, title: "Water the seedlings", status: "todo", source: "typed", notes: HIS, recurrence: "weekly", dueAt: new Date(Date.now() + 86_400_000) })
      .returning();
    await tool(live, "log_status", { task: t.id, signal: "done" });
    const next = (await mine()).filter((r) => r.title === "Water the seedlings" && r.id !== t.id);
    expect(next.map((r) => r.notes)).toEqual([HIS]);
  });
});

describe("in the background a labelled note is stored as written, and counted (§2.1)", () => {
  it("a tool call that is not a live turn", async () => {
    const id = await aTask("Fix the gate", null);
    const out = await tool(notLive, "amend_task", { task: id, note: "Owner: Sam" });
    expect((await row(id)).notes).toBe("Owner: Sam");
    expect(out.note_not_saved).toBeUndefined();
  });

  it("extraction: stored, counted in its summary, and the log line has counts, never the text", async () => {
    const [conv] = await db.insert(conversations).values({ userId: uid, mode: "text" }).returning();
    const said: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void said.push(a.join(" ")));
    const out = await applyExtraction(uid, conv.id, {
      tasks: [{ title: "Call the roofer about the gutters", notes: "Owner: Sam\nDeadline: Friday", due_at: null, project: null }],
      events: [],
      status_updates: [],
      facts: [],
      mentions: [],
      ambiguities: [],
    } as unknown as ExtractionResult);
    spy.mockRestore();
    const made = (await mine()).find((r) => r.title === "Call the roofer about the gutters")!;
    expect(made.notes).toBe("Owner: Sam\nDeadline: Friday");
    expect(out).toMatchObject({ createdTasks: 1, notesLabelled: 1 });
    expect(said.join("\n")).not.toContain("Sam");
  });

  it("suggestions: the reason alone, no 'Suggested:'; a labelled one stored and counted in the log, never its text", async () => {
    const said: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void said.push(a.join(" ")));
    await insertSuggestions(uid, [
      { title: "Clean the gutters", reason: "Leaves are piling up before the rain.", due_at: null, project: null },
      { title: "Book the chimney sweep", reason: "Owner: Sam", due_at: null, project: null },
    ], []);
    spy.mockRestore();
    const byTitle = Object.fromEntries((await mine()).map((r) => [r.title, r.notes]));
    expect(byTitle["Clean the gutters"]).toBe("Leaves are piling up before the rain.");
    expect(byTitle["Book the chimney sweep"]).toBe("Owner: Sam");
    expect(said.join("\n")).toMatch(/1 labelled/);
    expect(said.join("\n")).not.toContain("Sam");
  });
});

describe("no priority (§2.2)", () => {
  it("the tools no longer take one, and one sent anyway is not written", async () => {
    expect("priority" in (toolSchemas.create_task as unknown as { shape: object }).shape).toBe(false);
    expect("priority" in (toolSchemas.update_task as unknown as { shape: object }).shape).toBe(false);
    for (const def of anthropicToolDefs().filter((d) => ["create_task", "update_task"].includes(d.name)))
      expect(JSON.stringify(def), def.name).not.toMatch(/priorit/i);
    await tool(live, "create_task", { title: "Sweep the porch", priority: 3 });
    expect((await mine()).find((r) => r.title === "Sweep the porch")!.priority).toBe(0);
    const [t] = await db.insert(tasks).values({ userId: uid, title: "Oil the hinges", status: "todo", source: "typed", priority: 3 }).returning();
    await tool(live, "update_task", { task: t.id, priority: 1, due_at: "2026-11-02T09:00:00" });
    expect((await row(t.id)).priority, "his stored value stays").toBe(3);
  });

  it("a widget sorting by priority still validates, and sorts by due", async () => {
    const q = bindingQuerySchema.parse({ source: "tasks", sort: "priority", where: { open: true } });
    const day = (n: number) => new Date(Date.now() + n * 86_400_000);
    await db.insert(tasks).values([
      { userId: uid, title: "Later, high", status: "todo", source: "typed", priority: 3, dueAt: day(9) },
      { userId: uid, title: "Sooner, none", status: "todo", source: "typed", priority: 0, dueAt: day(2) },
      { userId: uid, title: "Middle, low", status: "todo", source: "typed", priority: 1, dueAt: day(5) },
    ]);
    const rows = await resolveBinding(uid, q, TZ);
    expect(rows.map((r) => r.fields.title)).toEqual(["Sooner, none", "Middle, low", "Later, high"]);
  });
});

describe("the prompts say it (§2.1)", () => {
  const RULE = /a line or two of plain words, or nothing/i;
  it("each notes field carries the rule's words", () => {
    const desc = (name: keyof typeof toolSchemas, field: string) =>
      ((toolSchemas[name] as unknown as { shape: Record<string, { description?: string }> }).shape[field]?.description ?? "");
    for (const [name, field] of [["create_task", "notes"], ["update_task", "notes"], ["amend_task", "note"], ["add_to_list", "note"]] as const) {
      expect(desc(name, field), `${name}.${field}`).toMatch(RULE);
      expect(desc(name, field), `${name}.${field}`).toMatch(/no 'Label:' lines/);
    }
    expect(desc("log_status", "note")).toMatch(/only what is worth keeping on the task, a short plain line; nothing when the signal says it all/i);
    const extraction = JSON.stringify(extractionSchema.shape.tasks.element.shape.notes.description ?? "");
    expect(extraction).toMatch(RULE);
  });

  it("the persona keeps every detail, in its own field or as a short plain sentence", () => {
    expect(SECRETARY_PERSONA).toMatch(/its own field when one exists, otherwise as a short plain sentence in the notes/i);
    expect(SECRETARY_PERSONA).not.toMatch(/structured fields \(or notes\)/);
  });

  it("no example in the tool or persona text is itself a label", async () => {
    const { plainNote } = await import("@/lib/secretary/plain-note");
    const texts = [SECRETARY_PERSONA, NY_SECRETARY_PERSONA, VOICE_MODALITY_RULES, ...anthropicToolDefs().map((d) => JSON.stringify(d))];
    const quoted = texts.flatMap((t) => [...t.matchAll(/["'“‘\\]([^"'”’\\]{3,80})["'”’\\]/g)].map((m) => m[1]));
    expect(quoted.filter((q) => plainNote(q) !== null)).toEqual([]);
  });
});

describe("every write of a task's notes goes through the check, or is on the list (§2.1)", () => {
  /** Where a task's notes are written without the check, on purpose: his typing, recurrence's copy, his save's merge. */
  const ALLOWED = [
    "app/api/tasks/[id]/route.ts: updates.notes = mergeNotes(",
    "lib/secretary/recurrence.ts: notes: completed.notes,",
    "lib/understanding/answer.ts",
  ];
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
  it("every site that writes tasks.notes is checked or allowed", () => {
    const unchecked: string[] = [];
    for (const file of [...files("lib"), ...files("app/api")]) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, i) => {
        // A write of a note: a notes value in an insert or an update of tasks, or the added lines of §1.1.
        const isWrite =
          /withLines\(tasks\.notes/.test(text) ||
          (/^\s*(notes:|updates\.notes = )/.test(text) &&
            !/notes: (tasks|events)\.notes/.test(text) &&
            lines.slice(Math.max(0, i - 15), i).some((l) => /\.(insert|update)\(tasks\)|updates: Partial<typeof tasks/.test(l)));
        if (!isWrite) return;
        const site = `${file}: ${text.trim()}`;
        if (ALLOWED.some((a) => site.startsWith(a) || (a.endsWith(".ts") && file === a))) return;
        const before = lines.slice(Math.max(0, i - 40), i + 1).join("\n");
        if (!/checkNote\(|noteChecked|plainNote\(/.test(before)) unchecked.push(`${site} (line ${i + 1})`);
      });
    }
    expect(unchecked).toEqual([]);
  });
});

// v1.10 r2 (§2.1): the check reads only the lines a write would add, the ones the note lacks, decided under the
// row's lock. The Reviewer's defect: a live write that echoed the note was refused whenever the note already held a
// labelled line, his own or a model's from before v1.10, and the new line was lost.
describe("only the lines a write would add are checked (r2)", () => {
  const OLD = "Corrugated, 8 ft long.\nNext action: call the yard";
  const ECHO = `${OLD}\nThey deliver on Fridays.`;
  const paths: [string, (id: string) => Promise<Record<string, unknown>>][] = [
    ["amend_task", (id) => tool(live, "amend_task", { task: id, note: ECHO })],
    ["update_task", (id) => tool(live, "update_task", { task: id, notes: ECHO })],
    ["log_status progress", (id) => tool(live, "log_status", { task: id, signal: "progress", note: ECHO })],
    ["log_status done", (id) => tool(live, "log_status", { task: id, signal: "done", note: ECHO })],
    ["create_task on the same-title twin", () => tool(live, "create_task", { title: "order the ROOF panels", notes: ECHO })],
  ];
  it.each(paths)("%s: the note echoed with a plain new line: the new line is saved, the old label never read", async (_name, write) => {
    const id = await aTask("Order the roof panels", OLD);
    const out = await write(id);
    expect(out.note_not_saved).toBeUndefined();
    expect((await row(id)).notes).toBe(`${OLD}\nThey deliver on Fridays.`);
    expect(out.notes_added).toEqual(["They deliver on Fridays."]);
  });

  it("his own labelled line echoed back with a plain new line: the new line is saved", async () => {
    const his = "Owner: me (my own label)\nHinges are loose.";
    const id = await aTask("Fix the gate", his);
    const out = await tool(live, "amend_task", { task: id, note: `${his}\nBring the long screws.` });
    expect(out.note_not_saved).toBeUndefined();
    expect((await row(id)).notes).toBe(`${his}\nBring the long screws.`);
  });

  it("an echo with a new labelled line: refused, naming only the new line", async () => {
    const id = await aTask("Order the roof panels", OLD);
    const out = await tool(live, "amend_task", { task: id, note: `${OLD}\nNext step: book the van` });
    expect(out.note_not_saved).toMatchObject({ line: "Next step: book the van" });
    expect((await row(id)).notes).toBe(OLD);
  });

  it("a replace is still checked whole", async () => {
    const id = await aTask("Order the roof panels", OLD);
    const out = await tool(live, "update_task", { task: id, notes: OLD, replace_notes: true });
    expect(out.note_not_saved).toMatchObject({ line: "Next action: call the yard" });
    expect((await row(id)).notes).toBe(OLD);
  });

  it("a labelled line another connection commits while the write waits is already there: not checked, and not lost", async () => {
    const id = await aTask("Order the roof panels", "Corrugated, 8 ft long.");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => (locked = r));
    const other = db.transaction(async (tx) => {
      await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).for("update");
      await tx.update(tasks).set({ notes: OLD }).where(eq(tasks.id, id));
      locked();
      await held;
    });
    await hasLock;
    // The model read the note before that line was there, and sends it back with a new one.
    const writing = tool(live, "amend_task", { task: id, note: ECHO });
    await new Promise((r) => setTimeout(r, 300)); // the write is waiting on the row
    release();
    await other;
    const out = await writing;
    expect(out.note_not_saved).toBeUndefined();
    expect((await row(id)).notes).toBe(`${OLD}\nThey deliver on Fridays.`);
  });
});
