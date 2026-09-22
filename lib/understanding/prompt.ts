// The run's prompt — docs/understanding/SPEC.md §4.
//
// Three things live here and nowhere else: the system prompt the model reads,
// the rendering of one bundle into the user message, and the MODEL-FACING
// output schema. That last one is deliberately not runOutputSchema from
// types.ts: structured output constrains the model to a JSON schema, and a
// discriminated union or a z.record turns into an anyOf or a free-form object
// the model can wander inside. Flat objects with enums keep the shape the
// model fills small and obvious, and toRunOutput maps it back onto the union
// shape the validator checks — anything it cannot map is passed through so
// validateRunOutput, not this file, is the one that says what is wrong.
import { z } from "zod";
import { CONFIDENCES, QUESTION_KINDS, RECURRENCES, SOURCE_TYPES, type Bundle } from "./types";
import { localDateInTz } from "./gather";

// --------------------------------------------------------------------------
// The system prompt (SPEC §4, §5, §7, §8): every rule the validator checks is
// stated here, so a rejection quotes a rule the model has already read.
// --------------------------------------------------------------------------

export const UNDERSTANDING_SYSTEM = `You are the understanding layer of Secretary, a personal assistant. You are given everything Secretary holds about ONE of the user's projects: open and finished tasks, memories, the user's own words from recent conversations, promised follow-ups, events, documents, the widgets on the user's board, and the record you wrote last time. Your job: understand the project, keep the record current, notice what does not add up, notice what you do not know, and write the few words the app shows.

Rules that a machine checks; output that breaks them is rejected:

1. Every claim cites sources: the bracketed ids from the input, exactly as written. A belief with no source is not a claim; put it in unknowns and, if it matters, ask about it.

2. Never invent a task, date, person, number or rule. If the input does not say it, you do not know it.

3. Three kinds of question.
   need_to_know: a decision a stated rule requires and nothing holds; a name with no meaning; a date that passed with no new one; a blocked task with no reason. Look for the choice a rule implies before anything else: a rule like "one X a month" with no X chosen for the coming period is a question, and its answers are the candidates from your things, leaving out the ones whose state rules them out and saying why in the why.
   doesnt_add_up: a finished copy and an open copy of the same job; a task marked blocked after the user said it is not; a weekly thing filed as one-offs; tasks Secretary suggested that sit past their date and were never taken up; an open task whose notes say it is done.
   done_yet: an open item where a later message, a finished sibling, a passed milestone or a missed follow-up says it probably happened.

4. A question is one sentence in plain words ending with a question mark. Its why is at most two sentences and names at least one piece of evidence by its real title or a quote from it. evidence lists the source ids it rests on. answers: one to four; each has a label of at most 40 characters and the writes it makes, using only ids from the input and only these ops: complete_task, drop_task, set_due, set_recurrence, set_blocked_reason, remember_fact, clear_expectation, resolve. The first answer is the one you recommend. The last answer is always a way out with no writes except resolve ("Keep them", "Something else", "Not yet"). At most eight questions per project; when there are more, keep the ones whose answer changes what happens next.

5. Do not ask what the previous record's asked list shows was already asked and answered, and never ask twice about the same evidence.

6. Words. For each widget in the input write a lede of at most three sentences: what its rows have in common, which is first or oldest and why, what each is waiting on; name only rows that are in that widget, and never more than three of them: a lede is what the rows mean, not the list read back. todayLine: one or two sentences about this project's items due today or tomorrow and what they mean for the user, in the same voice as the questions; omit it when there are none.

7. Plain language: address the user as "you", never as "the user"; the real title the first time a thing is named; nickname and number together for anything that has both, like "Lenses (2110)"; days as digits ("42 days late", "the 22nd"); never the words slipped, stale, agenda, leverage, bandwidth, circle back; no shorthand the user has not used in their own titles or messages; say "I" for Secretary; never claim that anything was done; call a task Secretary suggested "my suggestion".

8. The record. things are the nouns the project is about, each with its name, aliases, ids such as CPO numbers, its state and what it waits on. rules are what the user has stated about how the work goes. decisions are choices made, with dates. blockers, currentWork, nextAction, attempts and resumePointer only as evidenced. Edit the previous record rather than starting over: keep what is still true, drop what is contradicted, update states. Copy the previous record's asked list unchanged.`;

// --------------------------------------------------------------------------
// The model-facing schema
// --------------------------------------------------------------------------

/** The closed op list from SPEC §5, as the flat write object names it. */
export const WRITE_OPS = [
  "complete_task",
  "drop_task",
  "set_due",
  "set_recurrence",
  "set_blocked_reason",
  "remember_fact",
  "clear_expectation",
  "resolve",
] as const;

const sourceOut = z.object({
  type: z.enum(SOURCE_TYPES).describe("The type before the colon in the bracketed id"),
  id: z.string().describe("The id after the colon in the bracketed id, exactly as written"),
  quote: z.string().optional().describe("Verbatim words from that source, when a quote is the point"),
});

const claimOut = z.object({
  text: z.string(),
  sources: z.array(sourceOut).describe("At least one; a claim with none is rejected"),
  confidence: z.enum(CONFIDENCES),
  at: z.string().optional().describe("A date, YYYY-MM-DD, when the claim is dated"),
});

const thingOut = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
  ids: z.array(z.string()).describe("Numbers such as a CPO number; strings, not integers"),
  state: claimOut,
  waitingOn: claimOut.optional(),
});

const contradictionOut = z.object({
  text: z.string(),
  sources: z.array(sourceOut),
});

const unknownOut = z.object({
  text: z.string(),
  why: z.string(),
  sources: z.array(sourceOut).describe("May be empty: an unknown is what you cannot point at"),
});

const askedOut = z.object({
  questionId: z.string(),
  askedAt: z.string(),
  answer: z.string().optional(),
  answeredAt: z.string().optional(),
});

const recordOut = z.object({
  objective: claimOut.optional(),
  things: z.array(thingOut),
  rules: z.array(claimOut),
  decisions: z.array(claimOut),
  currentWork: z.array(claimOut),
  nextAction: claimOut.optional(),
  blockers: z.array(claimOut),
  attempts: z.array(claimOut),
  resumePointer: claimOut.optional(),
  contradictions: z.array(contradictionOut),
  unknowns: z.array(unknownOut),
  asked: z.array(askedOut).describe("The previous record's asked list, copied unchanged"),
  lastActivityAt: z.string().describe("The latest date any input shows activity, YYYY-MM-DD"),
});

/**
 * One flat object for every op. Which fields matter depends on op: taskId for
 * the five task ops, dueAt (YYYY-MM-DD) for set_due, recurrence for
 * set_recurrence, reason for set_blocked_reason, fact and tags for
 * remember_fact, expectationId for clear_expectation, nothing for resolve.
 */
const writeOut = z.object({
  op: z.enum(WRITE_OPS),
  taskId: z.string().optional().describe("A task id from the input, for the task ops"),
  dueAt: z.string().optional().describe("set_due only: YYYY-MM-DD in the user's timezone"),
  recurrence: z.enum(RECURRENCES).optional().describe("set_recurrence only"),
  reason: z.string().optional().describe("set_blocked_reason only"),
  fact: z.string().optional().describe("remember_fact only"),
  tags: z.array(z.string()).optional().describe("remember_fact only"),
  expectationId: z.string().optional().describe("clear_expectation only"),
});

const answerOut = z.object({
  id: z.string().describe("kebab-case, unique within the question"),
  label: z.string().describe("At most 40 characters"),
  writes: z.array(writeOut),
});

const questionOut = z.object({
  kind: z.enum(QUESTION_KINDS),
  question: z.string(),
  why: z.string(),
  evidence: z.array(sourceOut),
  answers: z.array(answerOut).describe("One to four; the first is recommended, the last is the way out"),
});

export const modelOutputSchema = z.object({
  record: recordOut,
  questions: z.array(questionOut),
  words: z.object({
    todayLine: z.string().optional(),
    ledes: z.array(
      z.object({
        widgetId: z.string().describe("A widget id from WIDGETS ON THE BOARD"),
        lede: z.string(),
      })
    ),
  }),
});
export type ModelOutput = z.infer<typeof modelOutputSchema>;

// --------------------------------------------------------------------------
// Model shape -> RunOutput shape
// --------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Drop null-valued keys everywhere. The schema marks optional fields
 * optional, but a model answering a flat object sometimes writes `null` where
 * it means "not this one", and runOutputSchema's `.optional()` refuses null.
 * Absence and null mean the same thing here.
 */
function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (val === null) continue;
    out[k] = stripNulls(val);
  }
  return out;
}

/**
 * A flat write to the union member its op names. Fields the op does not use
 * are dropped so a stray `reason` on a complete_task cannot fail the strict
 * union; an op the union does not know is returned as it came, for the
 * validator to name.
 */
function flatToWrite(w: unknown): unknown {
  if (!isRecord(w)) return w;
  switch (w.op) {
    case "complete_task":
    case "drop_task":
      return { op: w.op, taskId: w.taskId };
    case "set_due":
      return { op: w.op, taskId: w.taskId, dueAt: w.dueAt };
    case "set_recurrence":
      return { op: w.op, taskId: w.taskId, recurrence: w.recurrence };
    case "set_blocked_reason":
      return { op: w.op, taskId: w.taskId, reason: w.reason };
    case "remember_fact":
      return { op: w.op, fact: w.fact, tags: w.tags ?? [] };
    case "clear_expectation":
      return { op: w.op, expectationId: w.expectationId };
    case "resolve":
      return { op: "resolve" };
    default:
      return w;
  }
}

/**
 * Map the model-facing shape onto the RunOutput shape runOutputSchema parses:
 * the ledes array becomes a record keyed by widget id and each flat write
 * becomes its union member. Nothing is validated here; a shape this cannot
 * map is passed through untouched so validateRunOutput reports it with its
 * path, and the retry can quote that.
 */
export function toRunOutput(modelOutput: unknown): unknown {
  const stripped = stripNulls(modelOutput);
  if (!isRecord(stripped)) return stripped;
  const out: Record<string, unknown> = { ...stripped };

  if (isRecord(out.words) && Array.isArray(out.words.ledes)) {
    const ledes: Record<string, unknown> = {};
    out.words.ledes.forEach((entry, i) => {
      if (!isRecord(entry)) {
        ledes[`invalid-${i}`] = entry;
        return;
      }
      const key = typeof entry.widgetId === "string" ? entry.widgetId : `invalid-${i}`;
      ledes[key] = entry.lede;
    });
    out.words = { ...out.words, ledes };
  }

  if (Array.isArray(out.questions)) {
    out.questions = out.questions.map((q) => {
      if (!isRecord(q) || !Array.isArray(q.answers)) return q;
      return {
        ...q,
        answers: q.answers.map((a) =>
          isRecord(a) && Array.isArray(a.writes) ? { ...a, writes: a.writes.map(flatToWrite) } : a
        ),
      };
    });
  }

  return out;
}

// --------------------------------------------------------------------------
// The user message: one bundle, rendered (SPEC §3 order)
// --------------------------------------------------------------------------

const NOTE_CHARS = 300;
const MESSAGE_CHARS = 400;
const DAY_MS = 86_400_000;

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()} (cut)`;

/** One line, however the source row was typed. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Days between two YYYY-MM-DD strings, b - a, on the calendar. */
function dayDiff(a: string, b: string): number {
  const toUtc = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

function localDateTime(iso: string, tz: string): string {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${localDateInTz(tz, d)} ${time}`;
}

function weekday(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date(iso));
}

/**
 * "due 2026-09-22 (today)", "due 2026-09-16 (6 days overdue)". Relative words
 * only when they are true; the model must not have to do calendar math to
 * know what tomorrow is.
 */
function dueLabel(dueAt: string | null, clock: Bundle["clock"]): string {
  if (!dueAt) return "no due date";
  const local = localDateInTz(clock.timezone, new Date(dueAt));
  const diff = dayDiff(local, clock.localDate);
  if (diff > 0) return `due ${local} (${diff} day${diff === 1 ? "" : "s"} overdue)`;
  if (local === clock.localDate) return `due ${local} (today)`;
  if (local === clock.tomorrowLocalDate) return `due ${local} (tomorrow)`;
  return `due ${local}`;
}

const sourceLabel = (source: string): string =>
  source === "suggested" ? "suggested by Secretary" : source;

export function renderBundle(bundle: Bundle): string {
  const tz = bundle.clock.timezone;
  const date = (iso: string) => localDateInTz(tz, new Date(iso));
  const lines: string[] = [];
  const section = (title: string, body: string[], droppedField?: string) => {
    lines.push("", `${title}:`);
    if (body.length === 0) lines.push("none");
    else lines.push(...body);
    const drop = droppedField && bundle.dropped.find((d) => d.field === droppedField);
    if (drop) lines.push(`(${drop.count} more not shown; the newest are above)`);
  };

  lines.push(`PROJECT: ${bundle.project.name} (${bundle.project.status})`);
  lines.push(
    "",
    "CLOCK:",
    `now: ${weekday(bundle.clock.nowIso, tz)} ${localDateTime(bundle.clock.nowIso, tz)}`,
    `today: ${bundle.clock.localDate}`,
    `tomorrow: ${bundle.clock.tomorrowLocalDate}`,
    `timezone: ${tz}`
  );

  section(
    "OPEN TASKS",
    bundle.tasksOpen.flatMap((t) => {
      const head =
        `[task:${t.id}] ${t.status} | ${sourceLabel(t.source)} | ${dueLabel(t.dueAt, bundle.clock)} | ` +
        `created ${date(t.createdAt)} | updated ${date(t.updatedAt)} | ${oneLine(t.title)}`;
      const rest: string[] = [];
      if (t.notes) rest.push(`  notes: ${cut(oneLine(t.notes), NOTE_CHARS)}`);
      if (t.stages.length) {
        rest.push(`  stages: ${t.stages.map((s) => `${s.done ? "✓" : "○"} ${s.name}`).join(" → ")}`);
      }
      if (t.blockedReason) rest.push(`  blocked: ${oneLine(t.blockedReason)}`);
      if (t.stakes) rest.push(`  stakes: ${oneLine(t.stakes)}`);
      if (t.recurrence) rest.push(`  recurrence: ${t.recurrence}`);
      return [head, ...rest];
    }),
    "tasksOpen"
  );

  section(
    "FINISHED IN THE LAST 60 DAYS",
    bundle.tasksDone.map((t) => {
      const when = t.completedAt ?? t.updatedAt;
      const notes = t.notes ? ` | notes: ${cut(oneLine(t.notes), NOTE_CHARS)}` : "";
      return `[task:${t.id}] ${t.status} ${date(when)} | ${oneLine(t.title)}${notes}`;
    }),
    "tasksDone"
  );

  section(
    "MEMORIES",
    bundle.memories.map((m) => {
      const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
      return `[memory:${m.id}] ${date(m.createdAt)} ${oneLine(m.fact)}${tags}`;
    }),
    "memories"
  );

  section(
    "WHAT THE USER SAID",
    bundle.messages.map(
      (m) =>
        `[message:${m.id}] ${localDateTime(m.createdAt, tz)} "${cut(oneLine(m.content), MESSAGE_CHARS)}"`
    ),
    "messages"
  );

  section(
    "PROMISED FOLLOW-UPS",
    bundle.expectations.map(
      (e) =>
        `[expectation:${e.id}] ${oneLine(e.commitment)} | expected by ${date(e.expectedUpdateBy)} | ${e.status}`
    )
  );

  section(
    "EVENTS",
    bundle.events.map((e) => {
      const where = e.location ? ` | ${oneLine(e.location)}` : "";
      return `[event:${e.id}] ${oneLine(e.title)} | starts ${localDateTime(e.startsAt, tz)}${where}`;
    }),
    "events"
  );

  section(
    "DOCUMENTS",
    bundle.documents.map((d) => `[document:${d.id}] ${oneLine(d.title)} | updated ${date(d.updatedAt)}`),
    "documents"
  );

  // Widget rows are whatever the binding resolved: usually tasks, sometimes
  // events or documents. A row is written with the bracketed id the rest of
  // the input uses for it, so the model can cite the same row from a lede's
  // widget and from the task list without learning two names for it.
  const taskIds = new Set([...bundle.tasksOpen, ...bundle.tasksDone].map((t) => t.id));
  const eventIds = new Set(bundle.events.map((e) => e.id));
  const documentIds = new Set(bundle.documents.map((d) => d.id));
  const rowRef = (id: string): string => {
    if (taskIds.has(id)) return `[task:${id}]`;
    if (eventIds.has(id)) return `[event:${id}]`;
    if (documentIds.has(id)) return `[document:${id}]`;
    return `row ${id}`;
  };
  section(
    "WIDGETS ON THE BOARD",
    bundle.widgets.flatMap((w) => [
      `widget ${w.id} "${oneLine(w.title)}":`,
      ...w.rows.map((r) => `  ${rowRef(r.id)} ${oneLine(r.title)}`),
    ])
  );

  section("PREVIOUS RECORD", [
    bundle.previousRecord ? JSON.stringify(bundle.previousRecord) : "none (first run)",
  ]);

  lines.push("", "Write the record, the questions and the words for this project now.");
  return lines.join("\n");
}
