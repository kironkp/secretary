// Undo on the timeline means it never happened (SEC-A009, sec plan). A move
// through update_task can do more than change dates: a later due date counts
// a postponement, writes a "Postponed to …" check-in and silently clears the
// task's open expectations. Undo has to put every one of those back, not run
// a second update that can only count up.
//
// So the move route takes a snapshot before the tool runs and a diff after,
// and hands the browser a sealed token: the row's prior values, exactly which
// check-ins the move wrote and which expectations it cleared, and the dates
// it left behind. The token is HMAC-sealed (the sealProposal pattern), tied
// to the user and short-lived, so a browser can carry it but never edit it.
// The restore itself is in the tool layer (restoreTaskMove /
// restoreEventMove in lib/secretary/tools.ts), so a Google-synced event goes
// back to Google through the same path a move took.
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { checkins, events, expectations, tasks } from "@/lib/db/schema";

/** How long Undo stays offered: the toast is gone well before this. */
const TTL_MS = 15 * 60_000;

export type TaskBefore = {
  dueAt: string | null;
  startAt: string | null;
  reminders: string[];
  postponedCount: number;
  updatedAt: string;
};
export type EventBefore = { startsAt: string; endsAt: string | null; reminders: string[] };

export type UndoTicket =
  | {
      kind: "task";
      id: string;
      userId: string;
      exp: number;
      before: TaskBefore;
      /** The dates the move left; Undo refuses if the task has moved since. */
      after: { dueAt: string | null; startAt: string | null };
      checkinIds: string[];
      expectationIds: string[];
    }
  | {
      kind: "event";
      id: string;
      userId: string;
      exp: number;
      before: EventBefore;
      after: { startsAt: string; endsAt: string | null };
    };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function secret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (!s) throw new Error("BETTER_AUTH_SECRET is required to seal an undo");
  return `timeline-undo:${s}`;
}
const mac = (body: string) => createHmac("sha256", secret()).update(body).digest("base64url");

export function sealUndo(ticket: UndoTicket): string {
  const body = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return `${body}.${mac(body)}`;
}

/** The ticket, if the seal holds, it is this user's, and it has not expired. */
export function openUndo(token: string, userId: string, now: number = Date.now()): UndoTicket | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const ticket = JSON.parse(Buffer.from(body, "base64url").toString()) as UndoTicket;
    if (ticket.userId !== userId || ticket.exp < now) return null;
    return ticket;
  } catch {
    return null;
  }
}

/** What a task move could change, read before the tool runs. */
export async function taskSnapshot(userId: string, id: string) {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, userId)));
  if (!row) return null;
  const checkinIds = new Set(
    (await db.select({ id: checkins.id }).from(checkins).where(and(eq(checkins.userId, userId), eq(checkins.taskId, id)))).map((r) => r.id)
  );
  const openExpectations = new Set(
    (
      await db
        .select({ id: expectations.id })
        .from(expectations)
        .where(and(eq(expectations.userId, userId), eq(expectations.taskId, id), eq(expectations.status, "open")))
    ).map((r) => r.id)
  );
  return {
    before: {
      dueAt: iso(row.dueAt),
      startAt: iso(row.startAt),
      reminders: row.reminders,
      postponedCount: row.postponedCount,
      updatedAt: row.updatedAt.toISOString(),
    } satisfies TaskBefore,
    checkinIds,
    openExpectations,
  };
}

/** After the move: the ticket that undoes exactly what it did. */
export async function taskTicket(
  userId: string,
  id: string,
  snap: NonNullable<Awaited<ReturnType<typeof taskSnapshot>>>
): Promise<UndoTicket> {
  const [row] = await db.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, userId)));
  const written = (await db.select({ id: checkins.id }).from(checkins).where(and(eq(checkins.userId, userId), eq(checkins.taskId, id))))
    .map((r) => r.id)
    .filter((c) => !snap.checkinIds.has(c));
  const stillOpen = new Set(
    (
      await db
        .select({ id: expectations.id })
        .from(expectations)
        .where(and(eq(expectations.userId, userId), eq(expectations.taskId, id), eq(expectations.status, "open")))
    ).map((r) => r.id)
  );
  return {
    kind: "task",
    id,
    userId,
    exp: Date.now() + TTL_MS,
    before: snap.before,
    after: { dueAt: iso(row?.dueAt), startAt: iso(row?.startAt) },
    checkinIds: written,
    expectationIds: [...snap.openExpectations].filter((e) => !stillOpen.has(e)),
  };
}

export async function eventSnapshot(userId: string, id: string): Promise<EventBefore | null> {
  const [row] = await db.select().from(events).where(and(eq(events.id, id), eq(events.userId, userId)));
  if (!row) return null;
  return { startsAt: row.startsAt.toISOString(), endsAt: iso(row.endsAt), reminders: row.reminders };
}

export async function eventTicket(userId: string, id: string, before: EventBefore): Promise<UndoTicket> {
  const [row] = await db.select().from(events).where(and(eq(events.id, id), eq(events.userId, userId)));
  return {
    kind: "event",
    id,
    userId,
    exp: Date.now() + TTL_MS,
    before,
    after: { startsAt: row.startsAt.toISOString(), endsAt: iso(row.endsAt) },
  };
}
