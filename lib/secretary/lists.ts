// Lists (SEC-A003, 2026-10-06): Shopping and its kind are projects with
// kind "list", whose tasks are the items. Kiron said "Please add lotion to my
// shopping list for the boat" and got a task "buy lotion for the boat" filed
// under Personal. A list item is a noun on a named list; what it is for is a
// note; and a list phrase never invents a project called "Boat".
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks } from "@/lib/db/schema";

/** The list an item goes on when no other is named. */
export const DEFAULT_LIST = "Shopping";

/**
 * A spoken list reference, split into the list's name and what the item is
 * for: "my shopping list for the boat" → Shopping, "for the boat";
 * "packing list" → Packing. Null when the words don't name a list.
 */
export function parseListPhrase(words: string): { name: string; purpose: string | null } | null {
  const s = words.trim().replace(/[.!?]+$/, "");
  const m = /^(?:(?:my|the|our|a)\s+)?(.+?)\s+list(?:\s+(for\s+.+))?$/i.exec(s);
  if (!m) return null;
  return { name: listName(m[1]), purpose: m[2]?.trim() ?? null };
}

/** "shopping" → "Shopping"; "boat" → "Boat". */
function listName(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** Where add_to_list puts things: the named list (with or without the word "list"), else Shopping. */
export function listFor(words: string | undefined): { name: string; purpose: string | null } {
  if (!words?.trim()) return { name: DEFAULT_LIST, purpose: null };
  const phrase = parseListPhrase(words);
  if (phrase) return phrase;
  // "shopping", "Shopping for the boat": a name, then maybe what it is for.
  const m = /^(?:(?:my|the|our|a)\s+)?(.+?)(?:\s+(for\s+.+))?$/i.exec(words.trim().replace(/[.!?]+$/, ""))!;
  return { name: listName(m[1]), purpose: m[2]?.trim() ?? null };
}

/** An item as it sits on a list: a noun, capitalized; "buy lotion" is "Lotion". */
export function itemTitle(raw: string): string {
  const t = raw
    .trim()
    .replace(/^(?:to\s+)?(?:buy|get|pick up|grab|order)\s+/i, "")
    .replace(/^(?:some|a|an|more)\s+/i, "")
    .replace(/[.!?]+$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The user's list by name, if they have one. */
export async function findList(userId: string, name: string) {
  const [found] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.userId, userId),
        eq(projects.kind, "list"),
        ne(projects.status, "archived"),
        sql`lower(${projects.name}) = ${name.toLowerCase()}`
      )
    )
    .limit(1);
  return found ?? null;
}

/** The user's list by name, made on first use. */
export async function findOrCreateList(userId: string, name: string) {
  const found = await findList(userId, name);
  if (found) return { list: found, created: false };
  const [list] = await db.insert(projects).values({ userId, name, kind: "list" }).returning();
  return { list, created: true };
}

/** "Lotion", "Lotion and Sunscreen", "Lotion, Sunscreen and Hats". */
export function spokenList(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** One line per list with its open items, for the briefing: "Shopping: Lotion (for the boat), Sunscreen". */
export async function listsSummary(userId: string): Promise<string[]> {
  const lists = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.kind, "list"), ne(projects.status, "archived")))
    .orderBy(asc(projects.name));
  if (!lists.length) return [];
  const items = await db
    .select({ projectId: tasks.projectId, title: tasks.title, notes: tasks.notes })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.projectId, lists.map((l) => l.id)),
        inArray(tasks.status, ["inbox", "todo", "in_progress", "blocked"])
      )
    )
    .orderBy(asc(tasks.createdAt));
  return lists.map((l) => {
    const mine = items.filter((i) => i.projectId === l.id).map((i) => (i.notes ? `${i.title} (${i.notes})` : i.title));
    return `${l.name}: ${mine.length ? mine.join(", ") : "empty"}`;
  });
}
