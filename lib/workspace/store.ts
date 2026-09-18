// Reading and writing the one board. Every function takes userId first and
// filters on it, the same contract lib/db/queries.ts states and
// tests/user-scoping.test.ts proves.
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { workspaces } from "@/lib/db/schema";
import { boardSchema, EMPTY_BOARD, type Board } from "./types";
import { addWidget, nextWidgetId } from "./ops";

export type StoredBoard = { id: string; name: string; version: number; board: Board };

/**
 * A first board that is worth looking at. Phase 1 bodies are static: the point
 * of this phase is that the geometry works under a finger, and an empty grid
 * proves nothing. Phase 2 replaces these with bound content.
 */
function starterBoard(): Board {
  let board = EMPTY_BOARD;
  const seeds = [
    {
      title: "Today",
      w: 6,
      h: 5,
      body: '<p class="cv-muted">Your day lands here once widgets are bound to live data.</p>',
    },
    {
      title: "Scratch",
      w: 6,
      h: 5,
      body: '<p class="cv-muted">Drag me by the handle. Resize from the corner.</p>',
    },
    {
      title: "Notes",
      w: 12,
      h: 4,
      body: '<p class="cv-muted">Widgets are independent. Moving one never touches another.</p>',
    },
  ];
  for (const s of seeds) {
    board = addWidget(board, {
      id: nextWidgetId(board.widgets, s.title),
      title: s.title,
      x: board.widgets.length % 2 === 1 ? 6 : 0,
      w: s.w,
      h: s.h,
      collapsed: false,
      body: s.body,
    });
  }
  // The seed is the starting point, not something to undo back past.
  return { ...board, undo: [], redo: [] };
}

/** Parse defensively: a board that fails validation is replaced, never rendered. */
function readBoard(raw: unknown): Board {
  const parsed = boardSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_BOARD;
}

export async function getBoard(userId: string): Promise<StoredBoard> {
  const [row] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.userId, userId), eq(workspaces.isDefault, true)))
    .limit(1);

  if (row) {
    return { id: row.id, name: row.name, version: row.version, board: readBoard(row.board) };
  }

  const board = starterBoard();
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
