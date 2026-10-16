// v1.17 r2 (docs/tasks/SPEC.md §1.1): "trailing spaces" means one thing in the code and in the database. The
// Reviewer's defect: JS trimmed every Unicode space (trimEnd), the SQL only ' \t\r', so a line he stored ending in
// a no-break space never matched the same line from the model: it was added twice, and the result said it was
// already there. Made-up user, made-up notes; against the real database; no model is called.
process.env.TZ = "UTC";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { tasks, user } from "@/lib/db/schema";
import * as notes from "@/lib/secretary/notes";
import { executeTool, liveTurnContext, type ToolContext } from "@/lib/secretary/tools";

const TZ = "America/Los_Angeles";
const users: string[] = [];
let uid: string;
let ctx: ToolContext;
beforeEach(async () => {
  uid = `test-trailing-${crypto.randomUUID()}`;
  users.push(uid);
  await db.insert(user).values({ id: uid, name: "Trailing", email: `${uid}@v117.test`, timezone: TZ });
  session.user = { id: uid, email: `${uid}@v117.test`, name: "Trailing", timezone: TZ };
  ctx = liveTurnContext({ userId: uid, timezone: TZ, attachmentCount: 0 });
});
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
const tool = async (name: string, args: Record<string, unknown>) => (await executeTool(ctx, name, args)).result as Record<string, unknown>;

/** The characters String.prototype.trimEnd strips, asked of this engine, not of the code under test. */
const TRIM_END = Array.from({ length: 0x10000 }, (_, c) => String.fromCharCode(c)).filter((ch) => `a${ch}`.trimEnd() === "a");
/** And a few it keeps: a zero-width space, a letter, a dot. */
const KEPT = ["​", "x", "."];

describe("one definition of a trailing space, in the code and in the database (r2)", () => {
  it("the code's set is exactly trimEnd's", () => {
    expect(TRIM_END.length).toBeGreaterThan(20);
    expect([...(notes as unknown as { TRAILING_SPACES?: string }).TRAILING_SPACES ?? ""].sort()).toEqual([...TRIM_END].sort());
  });

  it("for each of trimEnd's characters, and a few it keeps, the SQL and the code agree, on Postgres", async () => {
    const [t] = await db.insert(tasks).values({ userId: uid, title: "Probe", status: "todo", source: "typed" }).returning();
    const disagree: string[] = [];
    for (const ch of [...TRIM_END.filter((c) => c !== "\n"), ...KEPT]) {
      const stored = `Deck B${ch}`;
      await db.update(tasks).set({ notes: stored }).where(eq(tasks.id, t.id));
      const [{ added }] = await db.select({ added: notes.addedLines(tasks.notes, ["Deck B"]) }).from(tasks).where(eq(tasks.id, t.id));
      const sqlSaysThere = added === null;
      const codeSaysThere = notes.linesAdded(stored, ["Deck B"]).length === 0;
      const shouldBeThere = !KEPT.includes(ch);
      if (sqlSaysThere !== codeSaysThere || codeSaysThere !== shouldBeThere)
        disagree.push(`U+${ch.charCodeAt(0).toString(16).padStart(4, "0")}: sql ${sqlSaysThere}, code ${codeSaysThere}`);
    }
    expect(disagree).toEqual([]);
  });
});

describe("a line he stored with a trailing no-break space is the same line (the Reviewer's repro, made up)", () => {
  const HIS = "Deck B.\nConfirmation: KX7Q2 ";
  const hisTask = async (title = "Book the ferry") =>
    (await db.insert(tasks).values({ userId: uid, title, status: "todo", source: "typed", notes: HIS }).returning())[0].id;
  const sent = ["Confirmation: KX7Q2", "Confirmation: KX7Q2 ", "Confirmation: KX7Q2　", "Confirmation: KX7Q2\t"];

  it.each(sent)("amend_task, update_task, log_status progress, and done with %j: stored once, and the result says it was there", async (line) => {
    for (const write of [
      (id: string) => tool("amend_task", { task: id, note: line }),
      (id: string) => tool("update_task", { task: id, notes: line }),
      (id: string) => tool("log_status", { task: id, signal: "progress", note: line }),
      (id: string) => tool("log_status", { task: id, signal: "done", note: line }),
    ]) {
      const id = await hisTask();
      const out = await write(id);
      expect((await row(id)).notes, String(write)).toBe(HIS);
      expect(out.notes_already_there, String(write)).toBe(true);
      expect(out.notes_added, String(write)).toBeUndefined();
    }
  });

  it("create_task on the same-title twin: stored once, and it does not say the note was added", async () => {
    const id = await hisTask();
    const out = await tool("create_task", { title: "book the ferry", notes: "Confirmation: KX7Q2" });
    expect((await row(id)).notes).toBe(HIS);
    expect(out.notes_already_there).toBe(true);
    expect(String(out.note)).not.toMatch(/added to it/);
  });

  it("add_to_list on an item already there with that note: the note is not added again, and it says so", async () => {
    await tool("add_to_list", { items: ["sunscreen"], list: "shopping" });
    const item = (await db.select().from(tasks).where(eq(tasks.userId, uid))).find((r) => r.title.toLowerCase() === "sunscreen")!;
    await db.update(tasks).set({ notes: "the SPF 50 one " }).where(eq(tasks.id, item.id));
    const out = await tool("add_to_list", { items: ["sunscreen"], list: "shopping", note: "the SPF 50 one" });
    expect((await row(item.id)).notes).toBe("the SPF 50 one ");
    expect(out.note_added_to ?? []).toEqual([]);
    expect(out.note_already_on).toEqual(["Sunscreen"]);
  });
});
