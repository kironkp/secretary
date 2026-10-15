// v1.17 (docs/tasks/SPEC.md §1), a walk with no rule in it: his made-up note, typed through the real PATCH route
// (colons, labels, links, accents, a blank line), against random sequences of every model path that writes a note,
// his own saves (some racing a model write), stale re-sends, a replace he asked for, and two writes at once. After
// every step: his text comes first, byte for byte; every token a result said was added is still there; the step's
// token is on the task or its result says it was not saved; no line is there twice. Made-up user, no model called.
process.env.TZ = "UTC";

import { afterAll, describe, expect, it, vi } from "vitest";
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
import { conversations, tasks, user } from "@/lib/db/schema";
import { applyExtraction, type ExtractionResult } from "@/lib/secretary/extraction";
import { executeTool, liveTurnContext } from "@/lib/secretary/tools";
import { PATCH } from "@/app/api/tasks/[id]/route";

const TZ = "America/Los_Angeles";
const HIS = "Corrugated, 8 ft long.\nGate code: 4412\nhttps://timber.example/roof?a=1&b=2\nÉtagère — café, naïve.\n\nOwner: me (my own label)";
const SEEDS = (process.env.NOTES_WALK_SEEDS ?? Array.from({ length: 24 }, (_, i) => i + 1).join(",")).split(",").map(Number);
const STEPS = Number(process.env.NOTES_WALK_STEPS ?? 30);
const users: string[] = [];
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

/** mulberry32: the same seed, the same walk. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("his note against every model path, at random (v1.17)", () => {
  it.each(SEEDS)("seed %i", async (seed) => {
    const random = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(random() * xs.length)];
    const uid = `test-notes-walk-${seed}-${crypto.randomUUID()}`;
    users.push(uid);
    await db.insert(user).values({ id: uid, name: "Walk", email: `${uid}@v117.test`, timezone: TZ });
    session.user = { id: uid, email: `${uid}@v117.test`, name: "Walk", timezone: TZ };
    const ctx = liveTurnContext({ userId: uid, timezone: TZ, attachmentCount: 0 });
    const [conv] = await db.insert(conversations).values({ userId: uid, mode: "text" }).returning();
    const tool = async (name: string, args: Record<string, unknown>) => (await executeTool(ctx, name, args)).result as Record<string, unknown>;
    const read = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
    const save = async (id: string, body: Record<string, unknown>) => {
      const res = await PATCH(
        new Request(`http://x/api/tasks/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ id }) }
      );
      expect(res.status).toBe(200);
    };
    const extract = (title: string, notes: string) =>
      applyExtraction(uid, conv.id, { tasks: [{ title, notes, due_at: null, project: null }], events: [], status_updates: [], facts: [], mentions: [], ambiguities: [] } as unknown as ExtractionResult);

    const TITLE = "Order the roof panels";
    const [t] = await db.insert(tasks).values({ userId: uid, title: TITLE, status: "todo", source: "typed" }).returning();
    await save(t.id, { notes: HIS });
    await tool("add_to_list", { items: ["lotion"], list: "shopping" });
    const lotion = (await db.select().from(tasks).where(eq(tasks.userId, uid))).find((r) => r.title.toLowerCase() === "lotion")!;
    await save(lotion.id, { notes: "His list note: the one in the blue tube." });

    /** What must hold of each: his text first, and the model lines a result said were added. */
    const subject = { [t.id]: { his: HIS, kept: new Set<string>() }, [lotion.id]: { his: "His list note: the one in the blue tube.", kept: new Set<string>() } };
    const sent: string[] = []; // every model line written so far, for stale re-sends
    const log: string[] = [];

    for (let step = 0; step < STEPS; step++) {
      const tok = `tok${seed}x${step}`;
      const line = pick([`Note ${tok}.`, `Next: call them ${tok}`, `Owner: Sam ${tok}`, `see https://x.example/${tok}?q=1`, `Façade ${tok} — déjà vu`]);
      const before = await read(t.id);
      let where: "task" | "blocked" | "list" | "none" = "task"; // where the step's token should end up
      let saidNotSaved = false;
      let written = line; // the line this step wrote
      const kind = pick([
        "update_task", "amend_task", "progress", "started", "postponed", "blocked", "twin", "similar", "extract", "extract-similar",
        "stale", "replace", "his-save", "his-save-racing", "two-at-once", "list",
      ]);
      log.push(`${step} ${kind}`);
      const where_ = `seed ${seed}, steps: ${log.join(" | ")}`;
      switch (kind) {
        case "update_task":
          await tool("update_task", { task: t.id, notes: line });
          break;
        case "amend_task":
          await tool("amend_task", { task: t.id, note: line });
          break;
        case "progress":
        case "started":
          await tool("log_status", { task: t.id, signal: kind, note: line });
          break;
        case "postponed":
          await tool("log_status", { task: t.id, signal: "postponed", new_due_at: `2026-12-${String(1 + (step % 28)).padStart(2, "0")}T09:00:00`, note: line });
          break;
        case "blocked":
          await tool("log_status", { task: t.id, signal: "blocked", note: line });
          where = "blocked";
          break;
        case "twin":
          await tool("create_task", { title: `  ${TITLE.toUpperCase()} `, notes: line });
          break;
        case "similar": {
          const out = await tool("create_task", { title: `${TITLE} now`, notes: line });
          saidNotSaved = out.note_saved === false;
          where = "none";
          break;
        }
        case "extract":
          await extract(TITLE.toLowerCase(), line);
          break;
        case "extract-similar": {
          const out = await extract(`${TITLE} soon`, line);
          saidNotSaved = (out as { notesNotSaved?: number }).notesNotSaved === 1;
          where = "none";
          break;
        }
        case "stale": {
          // A line written before, sent again (a re-issued call, a stale copy).
          written = sent.length ? pick(sent) : line;
          await tool("amend_task", { task: t.id, note: written });
          break;
        }
        case "replace": {
          // He asked for the note to be changed: the result gives back exactly what was there.
          const text = `Changed at his word ${tok}.\nStill: ${tok}`;
          const out = pick([true, false])
            ? await tool("update_task", { task: t.id, notes: text, replace_notes: true })
            : await tool("amend_task", { task: t.id, note: text, replace_note: true });
          expect(out.notes_replaced, `the replaced text comes back exactly (${where_})`).toBe(before.notes);
          subject[t.id] = { his: text, kept: new Set() };
          break;
        }
        case "his-save": {
          // He opens it, keeps or deletes a model line, adds his own, saves; nothing happened meanwhile.
          const opened = before.notes ?? "";
          const lines = opened.split("\n");
          const drop = lines.findIndex((l) => l.includes("tok") && random() < 0.5);
          const his = [...lines.filter((_, i) => i !== drop), `His own ${tok}: kept as typed  `].join("\n");
          await save(t.id, { notes: his, notesBase: opened });
          expect((await read(t.id)).notes, `stored exactly as he sent it (${where_})`).toBe(his);
          subject[t.id] = { his, kept: new Set() };
          break;
        }
        case "his-save-racing": {
          // He opens it; a model line lands while he types; he saves with what he opened.
          const opened = before.notes ?? "";
          await tool("amend_task", { task: t.id, note: line });
          const his = `${opened}\nHis own ${tok}: typed while it was open`;
          await save(t.id, { notes: his, notesBase: opened });
          subject[t.id] = { his, kept: new Set([line]) };
          break;
        }
        case "two-at-once": {
          const other = `Also ${tok}b from the background.`;
          await Promise.all([tool("amend_task", { task: t.id, note: line }), extract(TITLE, other)]);
          expect((await read(t.id)).notes?.split("\n"), `both writes at once landed (${where_})`).toEqual(expect.arrayContaining([line, other]));
          subject[t.id].kept.add(other);
          sent.push(other);
          break;
        }
        case "list":
          await tool("add_to_list", { items: ["lotion"], list: "shopping", note: line });
          where = "list";
          break;
      }
      if (where === "task" && kind !== "replace" && kind !== "his-save") {
        subject[t.id].kept.add(written);
      }
      if (where === "list") subject[lotion.id].kept.add(line);
      if (!["replace", "his-save", "stale"].includes(kind)) sent.push(line);

      // The step's token: on the task (or the list item), or the result said it was not saved.
      const now = await read(t.id);
      const item = await read(lotion.id);
      if (where === "blocked") expect(now.blockedReason, `the reason is on the task (${where_})`).toBe(line);
      if (where === "none") {
        expect(saidNotSaved, `the result says the note was not saved (${where_})`).toBe(true);
        expect(`${now.notes}\n${item.notes}`, `and it was not (${where_})`).not.toContain(tok);
      }
      if (where === "list") expect(item.notes?.split("\n"), `on the item (${where_})`).toContain(line);

      for (const [id, s] of Object.entries(subject)) {
        const notes = (id === t.id ? now : item).notes ?? "";
        expect(notes.startsWith(s.his), `his text first, byte for byte (${where_})`).toBe(true);
        for (const k of s.kept) expect(notes.split("\n"), `a line a write added is still there (${where_})`).toContain(k);
        const lines = notes.split("\n").filter((l) => l.trim());
        expect(lines.length, `no line twice: ${JSON.stringify(lines)} (${where_})`).toBe(new Set(lines.map((l) => l.trimEnd())).size);
      }
    }

    // Last, sometimes: done or dropped with a note. His text still first, the note on it.
    const end = pick(["done", "dropped", "neither"]);
    if (end !== "neither") {
      const line = `Last: ${end} tok${seed}end`;
      await tool("log_status", { task: t.id, signal: end, note: line });
      const last = await read(t.id);
      expect(last.status, `seed ${seed}, ${end}`).toBe(end);
      expect(last.notes?.startsWith(subject[t.id].his), `his text first after ${end} (seed ${seed})`).toBe(true);
      expect(last.notes?.split("\n"), `the ${end} note is on it (seed ${seed})`).toContain(line);
    }
  }, 180_000);
});
