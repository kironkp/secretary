// The gate on a conversation that read mail (SEC-A005, 2026-10-06). Mail is
// outside text that can say anything, "add this to the calendar" included,
// and once it is in a conversation the model has read it. So from then on,
// in that conversation, a tool that would write anything is not run: it is
// stored as a proposal (pending_actions), the reply says what it would do,
// and it runs only when the user's own next message says yes. Their message
// is the one thing in the conversation mail cannot write.
//
// Two rules make the yes the user's (sec plan, D1): only the user's next
// message after the assistant turn that stated the proposal can confirm it,
// within ten minutes, so an old yes cannot be replayed onto a new proposal;
// and what runs is exactly the stored row, sealed with an HMAC, so nothing
// can change it in between. "Next" is read from the stored order of the
// conversation, not from which message a tool call saw: on a call the
// browser posts each transcript when it is ready, so the words that led to
// a proposal can land after it, but never after the reply that asked.
import { createHmac } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages, pendingActions } from "@/lib/db/schema";

/** What a conversation that read mail may still do without asking: reading, looking, drafting. */
export const UNTRUSTED_OK: ReadonlySet<string> = new Set([
  "get_tasks",
  "list_projects",
  "list_documents",
  "read_document",
  "get_agenda",
  "get_current_datetime",
  "get_current_plan",
  "list_items",
  "packet_status",
  "search_history",
  "email_summary",
  "search_email",
  "read_email",
  // D2: a draft is the feature, goes only to the original sender, and is never sent.
  "draft_email_reply",
  "confirm_pending",
  "paint_canvas",
  "edit_canvas",
  "arrange_canvas",
  "show_canvas",
  "consult_brain",
]);

export const PROPOSAL_TTL_MS = 10 * 60_000;

const CONSENT = "yes|yeah|yep|sure|ok|okay|do it|go ahead|add it|confirm";
const COURTESY = "please|thanks|thank you|now";
const ONLY_CONSENT = new RegExp(`^(?:(?:${CONSENT}|${COURTESY})(?: |$))+$`);
const SOME_CONSENT = new RegExp(`(?:^| )(?:${CONSENT})(?: |$)`);

/**
 * The whole message is a yes (sec rev R1): once case and punctuation are
 * gone, nothing is left but consent words ("yes", "yes add it", "okay go
 * ahead") and courtesy ("please", "thanks", "now"), six words at most.
 * "Okay, read me the next one" and "do it later" are not a yes: in speech
 * "okay" often opens a new request.
 */
export function isPlainYes(text: string): boolean {
  const said = text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  return said.split(" ").length <= 6 && ONLY_CONSENT.test(said) && SOME_CONSENT.test(said);
}

/** Keys sorted, so the same arguments always seal the same. */
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(walk)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, walk(x)]))
        : v;
  return JSON.stringify(walk(value));
}

export function sealProposal(id: string, tool: string, args: unknown): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required to seal proposals");
  return createHmac("sha256", `proposal:${secret}`).update(`${id}\n${tool}\n${canonical(args)}`).digest("hex");
}

/** What a proposal would do, in a few words. */
export function describeProposal(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const what = [a.title, a.name, a.fact, a.query, a.event, a.task, Array.isArray(a.items) ? a.items.join(", ") : undefined].find(
    (v) => typeof v === "string" && v.trim()
  );
  const when = [a.starts_at, a.due_at].find((v) => typeof v === "string");
  return [tool.replaceAll("_", " "), what ? `"${String(what).slice(0, 80)}"` : null, when ? `at ${when}` : null].filter(Boolean).join(" ");
}

/**
 * Since when a conversation holds mail: from the first read into it, or,
 * for an intake thread (channel "email", SEC-A005b), from its start, since
 * the mail itself is stored there as its first message. Null = clean.
 */
export function untrustedSince(conv: { untrustedAt: Date | null; channel: string | null }): Date | null {
  return conv.untrustedAt ?? (conv.channel === "email" ? new Date(0) : null);
}

/**
 * A stored line that may carry mail (SEC-A005 R3): anything but the user's
 * own words, in a conversation that holds mail, from the time it did. In a
 * chat that read mail that is the secretary's lines; in an intake thread it
 * is also the mail itself, stored as a user message without origin "app".
 */
export function carriesMail(
  m: { role: string; origin: string | null; createdAt: Date },
  conv: { untrustedAt: Date | null; channel: string | null }
): boolean {
  const since = untrustedSince(conv);
  if (!since || m.createdAt < since) return false;
  if (m.role !== "user") return true;
  return conv.channel === "email" && m.origin !== "app";
}

/**
 * For readers of the user's turns (understanding, layout signals, ASR): the
 * row is the user's own words, not mail an intake thread stores as a user
 * message (SEC-A005b). Rows typed or spoken in such a thread still count.
 */
export function notIntakeMail() {
  return or(
    eq(messages.origin, "app"),
    notInArray(messages.conversationId, db.select({ id: conversations.id }).from(conversations).where(eq(conversations.channel, "email")))
  );
}

/**
 * Mark a conversation as having read mail. The first read sets the time and
 * later ones keep it: everything the secretary said from then on may carry
 * mail (extraction reads by it).
 */
export async function markUntrusted(conversationId: string): Promise<void> {
  await db
    .update(conversations)
    // The database's clock, the one every message is stamped with.
    .set({ untrustedAt: sql`now()` })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.untrustedAt)));
}

/**
 * Where a turn happens: a chat turn, or a call with its key and the item
 * number of the tool call (null when the client couldn't tell).
 */
export type Place = { via: "chat" } | { via: "voice"; session: string | null; seq: number | null };
export const placeOf = (ctx: { voice?: { session: string | null; seq: number | null } }): Place =>
  ctx.voice ? { via: "voice", ...ctx.voice } : { via: "chat" };

/** Store a write as a proposal. */
export async function propose(
  ctx: { userId: string; conversationId?: string; anchorMessageId?: string; voice?: { session: string | null; seq: number | null } },
  tool: string,
  args: unknown
) {
  const place = placeOf(ctx);
  const id = crypto.randomUUID();
  const summary = describeProposal(tool, args);
  await db.insert(pendingActions).values({
    id,
    userId: ctx.userId,
    conversationId: ctx.conversationId ?? null,
    tool,
    args: (args ?? {}) as object,
    summary,
    afterMessageId: ctx.anchorMessageId ?? null,
    via: place.via,
    voiceSession: place.via === "voice" ? place.session : null,
    voiceSeq: place.via === "voice" ? place.seq : null,
    digest: sealProposal(id, tool, args ?? {}),
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
  });
  return {
    result: {
      proposed: true,
      will_do: summary,
      say: "This conversation has read mail, so nothing is written without the user's yes. Ask them in one sentence whether to do it; it happens only if their next message says yes (then call confirm_pending).",
    },
    // In the server's words, not the model's: what a yes would do.
    toast: { icon: "?", text: `Needs your yes: ${summary}`.slice(0, 120) },
  };
}

/** Take a proposal to run it: true for exactly one caller, however many race. */
export async function claimProposal(id: string): Promise<boolean> {
  const [claimed] = await db
    .update(pendingActions)
    .set({ status: "done" })
    .where(and(eq(pendingActions.id, id), eq(pendingActions.status, "pending")))
    .returning({ id: pendingActions.id });
  return Boolean(claimed);
}

type Said = {
  id: string;
  role: string;
  content: string;
  origin: string | null;
  mode: string;
  voiceSession: string | null;
  voiceSeq: number | null;
  createdAt: Date;
};
type Pending = typeof pendingActions.$inferSelect;

/** The user, in their own words in the app: never mail stored as a user message. */
const ownWords = (m: Said) => m.role === "user" && m.origin === "app";

/**
 * The lines of one place, in its own order. A chat is the typed thread in
 * the order the server stored it (it writes each turn whole). A call is
 * that call's lines in Realtime item order, never arrival time; a line
 * without a number has no place in it. A call the client couldn't number
 * has no lines at all, so nothing there can be answered.
 */
function linesOf(place: Place, said: Said[]): Said[] {
  if (place.via === "chat") return said.filter((m) => m.mode === "text" && m.voiceSession === null);
  if (!place.session) return [];
  return said
    .filter((m) => m.voiceSession === place.session && m.voiceSeq !== null)
    .toSorted((a, b) => a.voiceSeq! - b.voiceSeq!);
}

const placeOfProposal = (p: Pending): Place =>
  p.via === "voice" ? { via: "voice", session: p.voiceSession, seq: p.voiceSeq } : { via: "chat" };

/**
 * After a proposal, in the place it was made: the secretary's first line
 * after it (the one that asked), and the line that came next from either
 * side. The user's answer is that next line, if it is theirs; if the
 * secretary spoke again first (a second question, or the answer's
 * transcript never arrived), the question went unanswered and a later yes
 * can't stand in for it (sec rev, round 2).
 */
function afterQuestion(p: Pending, said: Said[]): { asked?: Said; next?: Said } {
  const place = placeOfProposal(p);
  const lines = linesOf(place, said);
  const after = (m: Said, than: Said | Pending) =>
    place.via === "voice" ? m.voiceSeq! > (than as { voiceSeq: number | null }).voiceSeq! : m.createdAt > than.createdAt;
  if (place.via === "voice" && place.seq === null) return {};
  const asked = lines.find((m) => m.role === "assistant" && after(m, p));
  const next = asked && lines.find((m) => (m.role === "assistant" || ownWords(m)) && after(m, asked));
  return { asked, next };
}

/** The user's answer to a proposal: their own words, right after the line that asked. */
export function answerTo(p: Pending, said: Said[]): Said | undefined {
  const { next } = afterQuestion(p, said);
  return next && ownWords(next) ? next : undefined;
}

/** The secretary spoke again before the user answered: the question lapsed. */
const lapsed = (p: Pending, said: Said[]) => afterQuestion(p, said).next?.role === "assistant";

/**
 * The proposals the user's current words confirm: those made in the same
 * place (the same chat, or the same call) that the current words are the
 * answer to, if they say yes. On a call the current words are the user's
 * last line before the confirming tool call, and can be posted a moment
 * after it, so they are waited for, briefly. A proposal whose answer was
 * anything else is refused for good.
 */
export async function confirmable(
  userId: string,
  conversationId: string,
  at: Place
): Promise<{ ok: true; rows: Pending[] } | { ok: false; error: string }> {
  if (at.via === "voice" && (!at.session || at.seq === null)) {
    return { ok: false, error: "I can't tell the order of this call, so I can't take that as a yes. Ask again in the chat." };
  }
  const open = (
    await db
      .select()
      .from(pendingActions)
      .where(
        and(
          eq(pendingActions.userId, userId),
          eq(pendingActions.conversationId, conversationId),
          eq(pendingActions.status, "pending"),
          gt(pendingActions.expiresAt, new Date())
        )
      )
  ).filter((p) => (at.via === "voice" ? p.via === "voice" && p.voiceSession === at.session : p.via === "chat"));
  if (open.length === 0) return { ok: false, error: "There's nothing waiting for a yes here." };

  const conversation = async () => {
    const rows = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        origin: messages.origin,
        mode: messages.mode,
        voiceSession: messages.voiceSession,
        voiceSeq: messages.voiceSeq,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.userId, userId)))
      .orderBy(asc(messages.createdAt));
    // On a call, the conversation as of the confirming tool call: nothing after it counts.
    return at.via === "voice" ? rows.filter((m) => m.voiceSession !== at.session || (m.voiceSeq !== null && m.voiceSeq < at.seq!)) : rows;
  };
  let said = await conversation();
  const awaitingAnswer = () =>
    open.some((p) => {
      const { asked, next } = afterQuestion(p, said);
      return Boolean(asked) && !next;
    });
  for (let waited = 0; awaitingAnswer() && waited < 3000; waited += 300) {
    await new Promise((r) => setTimeout(r, 300));
    said = await conversation();
  }

  const current = linesOf(at, said).filter(ownWords).at(-1);
  const answered = open.filter((p) => answerTo(p, said));
  const dead = [
    ...answered.filter((p) => answerTo(p, said)!.id !== current?.id || !isPlainYes(current.content)),
    ...open.filter((p) => lapsed(p, said)),
  ];
  if (dead.length) {
    await db.update(pendingActions).set({ status: "refused" }).where(inArray(pendingActions.id, dead.map((p) => p.id)));
  }
  const rows = answered.filter((p) => !dead.includes(p));
  if (rows.length) return { ok: true, rows };
  if (answered.length === 0 && dead.length) {
    return { ok: false, error: "That question went unanswered before something else was said, so nothing was done. If it's still wanted, propose it again and ask." };
  }
  if (answered.length === 0) return { ok: false, error: "Nothing is confirmed until the user has heard the question and answered. Ask them." };
  if (current && answered.some((p) => answerTo(p, said)!.id === current.id)) {
    return { ok: false, error: "The user didn't say yes. Nothing was done." };
  }
  return { ok: false, error: "That yes doesn't answer anything waiting now; ask again." };
}
