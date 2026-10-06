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
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
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

/** The user saying yes, plainly, at the start of their message. */
const YES = /^\s*(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|do it|add it|confirm(ed)?|please do|sounds good)\b(?![^.!?]*\b(no|don'?t|not|wait|cancel)\b)/i;
export const isPlainYes = (text: string) => YES.test(text);

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

/** Store a write as a proposal. */
export async function propose(
  ctx: { userId: string; conversationId?: string; anchorMessageId?: string },
  tool: string,
  args: unknown
) {
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

type Said = { id: string; role: string; content: string; createdAt: Date };
type Pending = typeof pendingActions.$inferSelect;

/**
 * The user's answer to a proposal: their first message after the first
 * reply of the secretary's that came after the proposal (the turn that
 * asked). Undefined while that reply, or the answer, hasn't landed.
 */
export function answerTo(p: Pending, said: Said[]): Said | undefined {
  const asked = said.find((m) => m.role === "assistant" && m.createdAt > p.createdAt);
  return asked && said.find((m) => m.role === "user" && m.createdAt > asked.createdAt);
}

/**
 * The proposals the user's current message confirms: those it is the answer
 * to, if it says yes. The current message is the user's newest; on a call
 * it can land a moment after the model acts on it, so it is waited for,
 * briefly. A proposal whose answer was anything else is refused for good.
 */
export async function confirmable(userId: string, conversationId: string): Promise<{ ok: true; rows: Pending[] } | { ok: false; error: string }> {
  const open = await db
    .select()
    .from(pendingActions)
    .where(
      and(
        eq(pendingActions.userId, userId),
        eq(pendingActions.conversationId, conversationId),
        eq(pendingActions.status, "pending"),
        gt(pendingActions.expiresAt, new Date())
      )
    );
  if (open.length === 0) return { ok: false, error: "There's nothing waiting for a yes." };

  const conversation = () =>
    db
      .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.userId, userId)))
      .orderBy(asc(messages.createdAt));
  let said = await conversation();
  const awaitingAnswer = () =>
    open.some((p) => said.some((m) => m.role === "assistant" && m.createdAt > p.createdAt) && !answerTo(p, said));
  for (let waited = 0; awaitingAnswer() && waited < 3000; waited += 300) {
    await new Promise((r) => setTimeout(r, 300));
    said = await conversation();
  }

  const current = said.filter((m) => m.role === "user").at(-1);
  const answered = open.filter((p) => answerTo(p, said));
  const dead = answered.filter((p) => answerTo(p, said)!.id !== current?.id || !isPlainYes(current.content));
  if (dead.length) {
    await db.update(pendingActions).set({ status: "refused" }).where(inArray(pendingActions.id, dead.map((p) => p.id)));
  }
  const rows = answered.filter((p) => !dead.includes(p));
  if (rows.length) return { ok: true, rows };
  if (answered.length === 0) return { ok: false, error: "Nothing is confirmed until the user has heard the question and answered. Ask them." };
  if (current && answered.some((p) => answerTo(p, said)!.id === current.id)) {
    return { ok: false, error: "The user didn't say yes. Nothing was done." };
  }
  return { ok: false, error: "That yes doesn't answer anything waiting now; ask again." };
}
