// The Interview, spoken (docs/understanding/SPEC.md §6 "Voice", §9
// "Interview"): the orb on the Interview tab starts a realtime call in the
// "interview" flavor. It is the same call, the same tools and the same
// answer path as every other call; what differs is the job. The session's
// instructions carry the open queue in the Interview tab's own order
// (listQuestions: rank, then oldest), and answer_question, called from such a
// call, hands back the next question in its result so the model moves on
// without a second round trip. Nothing here writes an answer: that is
// answer_question -> lib/understanding/answer.ts, as for a tap.
import { listQuestions, type QuestionRow } from "@/lib/understanding/questions";
import { KIND_LABELS, markSurfaced } from "@/lib/understanding/today";

/** The flavors a voice session can be started in. Only one so far. */
export const VOICE_FLAVORS = ["interview"] as const;
export type VoiceFlavor = (typeof VOICE_FLAVORS)[number];

/** How much of the queue rides in the instructions: enough to skip around in. */
export const INTERVIEW_QUEUE_COUNT = 10;

/**
 * One question as the model reads it: the id the tool needs, the kind, the
 * question, why it is asked, and its answers as `id=label` separated by
 * semicolons (a label may carry a comma). The briefing's OPEN QUESTIONS lines
 * and the interview's queue and next_question are all this one format.
 */
export function questionLine(q: Pick<QuestionRow, "id" | "kind" | "question" | "why" | "answers">): string {
  const answers = q.answers.map((a) => `${a.id}=${a.label}`).join("; ");
  return `question_id: ${q.id} · ${KIND_LABELS[q.kind]} · ${q.question} · why: ${q.why} · answers: ${answers}`;
}

/**
 * The interview block, appended last to the session instructions so it is
 * the job of the call. `queue` is the open queue in the Interview tab's
 * order; the first entry is the one asked first.
 */
export function interviewInstructions(queue: QuestionRow[], opts: { reconnect?: boolean } = {}): string {
  const lines = [
    "INTERVIEW MODE — this call was started from the orb on the Interview screen. The user sat down to answer your open questions about their projects; that is the whole job of this call. The screen shows the same question you are asking and moves on when an answer lands.",
  ];
  if (queue.length === 0) {
    lines.push(
      opts.reconnect
        ? "- The queue is empty now. If you have not said so yet, say that's everything for now, in one line."
        : "- There is nothing open to ask. Say so in one line (\"Nothing open to ask right now.\") and wait; do not invent questions or go through the day."
    );
    return lines.join("\n");
  }
  lines.push(
    opts.reconnect
      ? "- You are resuming after a reconnect: do not greet or restart; pick up with the question you were on (the first below unless you had skipped it)."
      : "- Open with the FIRST question below straight away. At most one word before it (\"Okay.\"); no greeting speech, no summary of the day, no nudges, no other topics.",
    "- One question at a time, in the order below. Say the question in your own words, briefly, then its answers as the choices (\"...: close it, or keep it?\"). Add the why only if it helps them answer, as one short clause. Never read ids, kind labels or the word \"question_id\" aloud.",
    "- Then listen. When they answer, call answer_question with the question_id and the answer_id their words match; anything extra they said goes in note. When what they said matches none of the answers — a qualification, a date, a reason, something else — leave answer_id out and put their words in own_words.",
    "- While answer_question runs, say at most \"One sec.\" — or nothing. The pause is you thinking; never fill it, never narrate it.",
    "- Its result says what happened (applied, failed, setAside, and reply for own words) and carries next_question. Acknowledge in a few words — what was applied, or reply in your own register — then ask next_question in the same breath. When next_question is null, say that's everything for now, in one line, and stop.",
    "- \"Skip\", \"come back to that\", \"not sure\": move to the next question below without calling anything. Skipped ones come back at the end: next_question wraps around to them.",
    "- \"Stop\", \"that's enough\": say \"Okay.\" and stop asking. They end the call with the orb.",
    "- A question they want to talk through is fine: answer briefly, then back to it. Never claim something was recorded unless answer_question returned it; an error means say so in one line and offer the answers again.",
    "- Professional, human on a call: no praise, no \"great\", no cheerleading, no recap of the interview.",
    `QUEUE (${queue.length} open${queue.length > INTERVIEW_QUEUE_COUNT ? `, first ${INTERVIEW_QUEUE_COUNT} shown` : ""}, in order):`
  );
  for (const q of queue.slice(0, INTERVIEW_QUEUE_COUNT)) lines.push(`- ${questionLine(q)}`);
  return lines.join("\n");
}

/**
 * The open queue for an interview session's instructions, with the first
 * question marked surfaced: it is about to be asked (SPEC §5, showing a
 * question is asking it), the same mark the Interview tab puts on its front.
 */
export async function interviewQueue(userId: string, now: Date = new Date()): Promise<QuestionRow[]> {
  const queue = await listQuestions(userId);
  if (queue[0]) await markSurfaced(userId, [queue[0]], now);
  return queue;
}

/**
 * The question to ask after `answeredId`: the next one in the queue order
 * the call was working through (`before`, read before the answer), that is
 * still open now; when none after it is left, the first still open, so
 * questions skipped earlier come back at the end, as "Skip for now" sends
 * them to the back on the screen. The one returned is marked surfaced: the
 * model asks it next.
 */
export async function nextInterviewQuestion(
  userId: string,
  answeredId: string,
  before: string[],
  now: Date = new Date()
): Promise<{ next: QuestionRow | null; remaining: number }> {
  const open = await listQuestions(userId);
  const at = before.indexOf(answeredId);
  const after = new Set(at === -1 ? [] : before.slice(at + 1));
  const next = open.find((q) => after.has(q.id)) ?? open[0] ?? null;
  if (next) await markSurfaced(userId, [next], now);
  return { next, remaining: open.length };
}

/**
 * What /api/realtime/token appends for an interview call: the queue read
 * now, its first question marked asked, as the block above. A resumed call
 * (a reconnect or a voice switch) marks nothing new; the model picks up.
 */
export async function interviewSessionBlock(
  userId: string,
  opts: { reconnect?: boolean; now?: Date } = {}
): Promise<string> {
  const queue = opts.reconnect ? await listQuestions(userId) : await interviewQueue(userId, opts.now);
  return interviewInstructions(queue, { reconnect: opts.reconnect });
}
