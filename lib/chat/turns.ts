// The row behind each written chat turn (docs/chat/SPEC.md §2). The page names
// a turn; a resend of one that is done or still running gets that turn, and a
// turn is run again only when it failed or its process is gone, and then by
// exactly one ask. Every "is it gone" is judged by the database's clock, the
// same clock that wrote the time the turn was last heard from.
import { and, eq, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { chatTurns, messages } from "@/lib/db/schema";

const knob = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** How often a running turn says it is alive, on a timer of its own. */
export const aliveEveryMs = () => knob("CHAT_TURN_ALIVE_MS", 12_000);
/** A running turn not heard from for this long is gone (the process that ran it ended). */
export const goneAfterMs = () => knob("CHAT_TURN_GONE_MS", 60_000);
/** How often an ask waiting on someone else's run of the turn looks again. */
const WAIT_POLL_MS = 250;

export type TurnRow = typeof chatTurns.$inferSelect;
/** A turn as an ask finds it: gone is true for a running turn silent past the limit. */
export type FoundTurn = TurnRow & { gone: boolean };

const mine = (userId: string, id: string) => and(eq(chatTurns.userId, userId), eq(chatTurns.id, id));
const silentPastLimit = () => sql`${chatTurns.aliveAt} < now() - make_interval(secs => ${goneAfterMs() / 1000})`;

/** A new turn. The row when this ask made it (and so runs the turn); null when the turn already exists. */
export async function claimNewTurn(userId: string, id: string): Promise<TurnRow | null> {
  const [row] = await db.insert(chatTurns).values({ userId, id, status: "running" }).onConflictDoNothing().returning();
  return row ?? null;
}

/**
 * Runs a failed turn again, or takes over one whose process is gone. One
 * conditional update: of two asks that arrive together, the one whose update
 * changed the row runs it; the other finds it running and alive, and waits.
 */
export async function takeOverTurn(userId: string, id: string): Promise<TurnRow | null> {
  const [row] = await db
    .update(chatTurns)
    .set({ status: "running", aliveAt: sql`now()`, error: null, finishedAt: null })
    .where(and(mine(userId, id), or(eq(chatTurns.status, "failed"), and(eq(chatTurns.status, "running"), silentPastLimit()))))
    .returning();
  return row ?? null;
}

export async function findTurn(userId: string, id: string): Promise<FoundTurn | null> {
  const [row] = await db
    .select({ turn: chatTurns, gone: sql<boolean>`${chatTurns.status} = 'running' and ${silentPastLimit()}` })
    .from(chatTurns)
    .where(mine(userId, id));
  return row ? { ...row.turn, gone: row.gone } : null;
}

/** Waits on a turn another ask is running, until it is done, failed or gone. Null if the row went away. */
export async function waitOnTurn(userId: string, id: string): Promise<FoundTurn | null> {
  for (;;) {
    const found = await findTurn(userId, id);
    if (!found || found.status !== "running" || found.gone) return found;
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
}

/**
 * Says the turn is alive, every aliveEveryMs, until the returned stop is
 * called: while it waits on a model, a tool or the database, whatever the
 * model sends and whether or not anyone is listening.
 */
export function keepTurnAlive(userId: string, id: string): () => void {
  const timer = setInterval(() => {
    void db
      .update(chatTurns)
      .set({ aliveAt: sql`now()` })
      .where(and(mine(userId, id), eq(chatTurns.status, "running")))
      .catch((e) => console.error("chat turn: could not say it is alive:", e instanceof Error ? e.message : e));
  }, aliveEveryMs());
  return () => clearInterval(timer);
}

/** His conversation and message, once stored, so a later run of the turn uses the same ones. */
export async function noteTurnMessage(userId: string, id: string, conversationId: string, userMessageId: string) {
  await db.update(chatTurns).set({ conversationId, userMessageId }).where(mine(userId, id));
}

/** The database, or a transaction the write is part of (the reply and the done mark go in one). */
type Writer = Pick<typeof db, "update">;

export async function finishTurn(
  userId: string,
  id: string,
  end: { replyMessageId: string; toasts: unknown[]; uiActions: unknown[] } | { error: string },
  writer: Writer = db
) {
  await writer
    .update(chatTurns)
    .set(
      "error" in end
        ? { status: "failed", error: end.error, finishedAt: sql`now()` }
        : { status: "done", replyMessageId: end.replyMessageId, toasts: end.toasts, uiActions: end.uiActions, error: null, finishedAt: sql`now()` }
    )
    .where(mine(userId, id));
}

/** What a done turn answered, as the route first sent it: the reply read back from its message row. */
export async function savedAnswer(turn: TurnRow) {
  if (!turn.replyMessageId) return null;
  const [reply] = await db.select().from(messages).where(and(eq(messages.id, turn.replyMessageId), eq(messages.userId, turn.userId)));
  if (!reply) return null;
  return {
    conversationId: turn.conversationId,
    userMessageId: turn.userMessageId,
    assistantMessage: { id: reply.id, role: "assistant" as const, content: reply.content, createdAt: reply.createdAt },
    toasts: turn.toasts ?? [],
    uiActions: turn.uiActions ?? [],
  };
}
