// Reading and writing the one board. Every function takes userId first and
// filters on it, the same contract lib/db/queries.ts states and
// tests/user-scoping.test.ts proves.
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workspaces } from "@/lib/db/schema";
import { sanitizeCanvasMarkup } from "@/lib/canvas/sanitize";
import {
  boardSchema,
  CURRENT_SEED,
  EMPTY_BOARD,
  type BindingQuery,
  type Board,
} from "./types";
import { addWidget, nextWidgetId } from "./ops";

export type StoredBoard = { id: string; name: string; version: number; board: Board };

/**
 * The starter set. These are BOUND widgets: the markup is a template and the
 * rows come from Postgres, so the board is useful the moment it is created and
 * stays current without anyone asking it to.
 *
 * The template shape is the whole idea — one row written once, repeated by the
 * shell. The model never writes a task title.
 */
const SEED_WIDGETS: Array<{
  title: string;
  x: number;
  w: number;
  h: number;
  body: string;
  query: BindingQuery;
}> = [
  {
    title: "Overdue",
    x: 0,
    w: 6,
    h: 6,
    query: { source: "tasks", where: { open: true, due: "overdue" }, sort: "due", limit: 10 },
    body:
      '<ul data-each class="cv-list">' +
      '<li data-row-check><span data-field="title"></span> <em data-field="due" class="cv-muted"></em></li>' +
      "</ul>" +
      '<p data-empty class="cv-muted">Nothing overdue.</p>',
  },
  {
    title: "Due today",
    x: 6,
    w: 6,
    h: 6,
    query: { source: "tasks", where: { open: true, due: "today" }, sort: "due", limit: 10 },
    body:
      '<ul data-each class="cv-list">' +
      '<li data-row-check><span data-field="title"></span> <em data-field="project" class="cv-muted"></em></li>' +
      "</ul>" +
      '<p data-empty class="cv-muted">Clear for today.</p>',
  },
  {
    title: "Projects",
    x: 0,
    w: 6,
    h: 6,
    query: { source: "projects", sort: "title", limit: 12 },
    body:
      '<ul data-each class="cv-list">' +
      '<li><span data-field="name"></span> <em data-field="open" class="cv-muted"></em> ' +
      '<em data-field="deadline" class="cv-muted"></em></li>' +
      "</ul>" +
      '<p data-empty class="cv-muted">No active projects.</p>',
  },
  {
    title: "Coming up",
    x: 6,
    w: 6,
    h: 6,
    query: { source: "events", sort: "due", limit: 8 },
    body:
      '<ul data-each class="cv-list">' +
      '<li><span data-field="title"></span> <em data-field="when" class="cv-muted"></em></li>' +
      "</ul>" +
      '<p data-empty class="cv-muted">Nothing on the calendar.</p>',
  },
  {
    title: "Everything open",
    x: 0,
    w: 12,
    h: 7,
    query: { source: "tasks", where: { open: true }, sort: "due", limit: 25 },
    body:
      '<p class="cv-muted"><span data-count></span> open</p>' +
      '<ul data-each class="cv-list">' +
      '<li data-row-check><span data-field="title"></span> ' +
      '<em data-field="project" class="cv-muted"></em> ' +
      '<em data-field="due" class="cv-muted"></em> ' +
      '<em data-field="stage" class="cv-muted"></em></li>' +
      "</ul>" +
      '<p data-empty class="cv-muted">Nothing open. Enjoy it.</p>',
  },
];

/** Apply any starter widgets this board has not seen. Never destructive. */
function applySeed(board: Board): Board {
  if (board.seedVersion >= CURRENT_SEED) return board;
  let next = board;
  for (const seed of SEED_WIDGETS) {
    if (next.widgets.some((w) => w.title === seed.title)) continue;
    next = addWidget(next, {
      id: nextWidgetId(next.widgets, seed.title),
      title: seed.title,
      x: seed.x,
      w: seed.w,
      h: seed.h,
      collapsed: false,
      body: seed.body,
      query: seed.query,
    });
  }
  // The starter set is a starting point, not something to undo back past.
  return { ...next, seedVersion: CURRENT_SEED, undo: [], redo: [] };
}

/**
 * Parse defensively, and sanitize EVERY body here — the single place a stored
 * board becomes a served board.
 *
 * Doing it here rather than at each call site is what keeps the page render and
 * the API payload byte-identical. When they differed, the client saw a "new"
 * template on the first poll and re-wrote the widget's innerHTML, throwing away
 * scroll and selection: the exact continuity failure this surface exists to
 * avoid. Sanitizing is idempotent, so a canonical body survives a round trip
 * unchanged.
 *
 * The Workspace surface: bodies render inline and bound to the user's rows, so
 * the sanitizer also drops the inline styles that would cut a title off
 * (docs/understanding/SPEC.md §9) — the stylesheet's rule cannot beat an
 * inline `!important` on its own.
 */
function readBoard(raw: unknown): Board {
  const parsed = boardSchema.safeParse(raw);
  if (!parsed.success) return EMPTY_BOARD;
  return {
    ...parsed.data,
    widgets: parsed.data.widgets.map((w) => ({
      ...w,
      body: sanitizeCanvasMarkup(w.body, { surface: "workspace" }),
    })),
  };
}

export async function getBoard(userId: string): Promise<StoredBoard> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.userId, userId), eq(workspaces.isDefault, true)))
    .limit(1);

  if (row) {
    const stored = readBoard(row.board);
    const seeded = applySeed(stored);
    if (seeded === stored) {
      return { id: row.id, name: row.name, version: row.version, board: stored };
    }
    // A board created before this starter set gains the new widgets once, and
    // keeps everything the user has already arranged.
    const [bumped] = await db
      .update(workspaces)
      .set({ board: seeded, version: row.version + 1, updatedAt: new Date() })
      .where(and(eq(workspaces.id, row.id), eq(workspaces.userId, userId)))
      .returning();
    return {
      id: row.id,
      name: row.name,
      version: bumped?.version ?? row.version,
      board: seeded,
    };
  }

  const board = applySeed(EMPTY_BOARD);
  const [created] = await db
    .insert(workspaces)
    .values({ userId, name: "Workspace", isDefault: true, board, version: 1 })
    .returning();
  return { id: created.id, name: created.name, version: created.version, board };
}

/**
 * Write the board back. `expectedVersion` is optimistic concurrency: a write
 * against a version that has moved is refused, so a stale tab cannot silently
 * undo what another device did. Returns null when refused.
 */
export async function saveBoard(
  userId: string,
  boardId: string,
  board: Board,
  expectedVersion: number
): Promise<StoredBoard | null> {
  const [updated] = await db
    .update(workspaces)
    .set({ board, version: expectedVersion + 1, updatedAt: new Date() })
    .where(
      and(
        eq(workspaces.id, boardId),
        eq(workspaces.userId, userId),
        eq(workspaces.version, expectedVersion)
      )
    )
    .returning();

  if (!updated) return null;
  return {
    id: updated.id,
    name: updated.name,
    version: updated.version,
    board: readBoard(updated.board),
  };
}
