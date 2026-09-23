// The understanding loop's contracts — docs/understanding/SPEC.md §2, §4, §5.
//
// Everything a run reads or writes is typed here, and every shape the model
// produces is a zod schema first and a TS type second: the run output is
// parsed, never trusted. The one rule that makes the record worth storing is
// enforced at the schema level — a Claim with no sources does not parse.
//
// These are NOT voice tool schemas. A discriminated union is fine here because
// nothing in this file is ever handed to the Realtime API (see
// lib/workspace/types.ts opSchema for why voice schemas stay flat).
import { z } from "zod";

// --------------------------------------------------------------------------
// Sources and claims (SPEC §2)
// --------------------------------------------------------------------------

export const SOURCE_TYPES = [
  "task",
  "memory",
  "message",
  "event",
  "document",
  "expectation",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** A pointer into the bundle. Validation (§4 step 1) checks the id is real. */
export const sourceSchema = z.object({
  type: z.enum(SOURCE_TYPES),
  id: z.string().min(1).max(80),
  quote: z.string().max(300).optional(),
});
export type Source = z.infer<typeof sourceSchema>;

export const CONFIDENCES = ["high", "medium", "low"] as const;

/** Something the model believes AND can point at. No sources, no claim. */
export const claimSchema = z.object({
  text: z.string().min(1).max(400),
  sources: z.array(sourceSchema).min(1),
  confidence: z.enum(CONFIDENCES),
  at: z.string().max(64).optional(),
});
export type Claim = z.infer<typeof claimSchema>;

/** The nouns a project is about: a CPO, a track, a form. */
export const thingSchema = z.object({
  name: z.string().min(1).max(120),
  aliases: z.array(z.string().min(1).max(120)).default([]),
  ids: z.array(z.string().min(1).max(40)).default([]),
  state: claimSchema,
  waitingOn: claimSchema.optional(),
});
export type Thing = z.infer<typeof thingSchema>;

/** "Doesn't add up": two sourced facts that cannot both be true. */
export const contradictionSchema = z.object({
  text: z.string().min(1).max(400),
  sources: z.array(sourceSchema).min(1),
  questionId: z.string().max(80).optional(),
});
export type Contradiction = z.infer<typeof contradictionSchema>;

/**
 * "Need to know": a thing the model believes but cannot point at. Sources may
 * be empty here — that is exactly what makes it an unknown and not a claim.
 */
export const unknownSchema = z.object({
  text: z.string().min(1).max(400),
  why: z.string().min(1).max(400),
  sources: z.array(sourceSchema).default([]),
  questionId: z.string().max(80).optional(),
});
export type Unknown = z.infer<typeof unknownSchema>;

/** What was asked, when, and what the user said, so the next run reasons from it. */
export const askedSchema = z.object({
  questionId: z.string().min(1).max(80),
  /** The question as the user saw it, so the model can tell a rewording of
   *  an answered question from a new one; older entries lack it. */
  question: z.string().max(400).optional(),
  /** The "type:id" keys of its evidence, for the same reason. */
  evidence: z.array(z.string().max(120)).max(40).optional(),
  askedAt: z.string().min(1).max(64),
  answer: z.string().max(1000).optional(),
  answeredAt: z.string().max(64).optional(),
});
export type Asked = z.infer<typeof askedSchema>;

/**
 * The per-project record (SPEC §2). Every array defaults to [] so a first run
 * that has nothing to say about, say, decisions still produces a valid record.
 */
export const recordSchema = z.object({
  objective: claimSchema.optional(),
  things: z.array(thingSchema).default([]),
  rules: z.array(claimSchema).default([]),
  decisions: z.array(claimSchema).default([]),
  currentWork: z.array(claimSchema).default([]),
  nextAction: claimSchema.optional(),
  blockers: z.array(claimSchema).default([]),
  attempts: z.array(claimSchema).default([]),
  resumePointer: claimSchema.optional(),
  contradictions: z.array(contradictionSchema).default([]),
  unknowns: z.array(unknownSchema).default([]),
  asked: z.array(askedSchema).default([]),
  lastActivityAt: z.string().min(1).max(64),
});

/**
 * Named ProjectRecord rather than Record because `Record<K, V>` is a TS
 * built-in and a module-level `type Record` would shadow it in every file that
 * imports this one. The spec calls it Record; `Record` below is the alias for
 * readers coming from the spec.
 */
export type ProjectRecord = z.infer<typeof recordSchema>;
export type { ProjectRecord as Record };

// --------------------------------------------------------------------------
// Questions and the writes an answer may carry (SPEC §5)
// --------------------------------------------------------------------------

export const RECURRENCES = ["daily", "weekly", "monthly", "yearly"] as const;

const taskId = z.string().min(1).max(80);
const isoDateOrDateTime = z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]);

/**
 * The closed list of writes an answer can perform. A question can never
 * propose creating a task, moving money, sending anything, or touching another
 * user's data; `resolve` is the question closing itself and is always last.
 */
export const writeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("complete_task"), taskId }),
  z.object({ op: z.literal("drop_task"), taskId }),
  z.object({ op: z.literal("set_due"), taskId, dueAt: isoDateOrDateTime }),
  z.object({ op: z.literal("set_recurrence"), taskId, recurrence: z.enum(RECURRENCES) }),
  z.object({ op: z.literal("set_blocked_reason"), taskId, reason: z.string().min(1).max(300) }),
  // A project NAME, not an id: the bundle names one project, and the task
  // tools already resolve a name the way a spoken "file it under Caltrans"
  // is resolved (lib/secretary/tools.ts update_task), so an answer and a
  // voice command land the task in the same place.
  z.object({ op: z.literal("set_project"), taskId, project: z.string().trim().min(1).max(80) }),
  z.object({
    op: z.literal("remember_fact"),
    fact: z.string().min(1).max(400),
    tags: z.array(z.string().min(1).max(40)).max(8).default([]),
  }),
  z.object({ op: z.literal("clear_expectation"), expectationId: z.string().min(1).max(80) }),
  z.object({ op: z.literal("resolve") }),
]);
export type Write = z.infer<typeof writeSchema>;

export const answerSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case id"),
  label: z.string().min(1).max(40),
  writes: z.array(writeSchema).max(20).default([]),
});
export type Answer = z.infer<typeof answerSchema>;

export const QUESTION_KINDS = ["need_to_know", "doesnt_add_up", "done_yet"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** A question as the run proposes it; lib/understanding/questions.ts ranks and stores it. */
export const questionDraftSchema = z.object({
  kind: z.enum(QUESTION_KINDS),
  question: z.string().min(1).max(160),
  why: z.string().min(1).max(400),
  evidence: z.array(sourceSchema).min(1).max(20),
  answers: z.array(answerSchema).min(1).max(4),
});
export type QuestionDraft = z.infer<typeof questionDraftSchema>;

// --------------------------------------------------------------------------
// Run output (SPEC §4)
// --------------------------------------------------------------------------

export const runOutputSchema = z.object({
  record: recordSchema,
  questions: z.array(questionDraftSchema).max(20).default([]),
  words: z.object({
    todayLine: z.string().max(300).optional(),
    /** widgetId -> lede. Keys are checked against the bundle's widgets. */
    ledes: z.record(z.string().min(1).max(64), z.string().min(1).max(500)).default({}),
  }),
});
export type RunOutput = z.infer<typeof runOutputSchema>;

// --------------------------------------------------------------------------
// The bundle (SPEC §3) — what one run reads. Plain TS: it is built from
// Postgres by lib/understanding/gather.ts, never parsed from model output.
// Dates are ISO strings so the bundle serializes as-is into a prompt.
// --------------------------------------------------------------------------

export type TaskStage = { name: string; done: boolean; due_at?: string | null; blocked_by?: number | null };

export type BundleTask = {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  stages: TaskStage[];
  blockedReason: string | null;
  stakes: string | null;
  source: string;
  recurrence: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BundleMemory = {
  id: string;
  fact: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type BundleMessage = {
  id: string;
  content: string;
  createdAt: string;
  mode: string;
};

export type BundleExpectation = {
  id: string;
  taskId: string | null;
  commitment: string;
  expectedUpdateBy: string;
  onMiss: string;
  status: string;
};

export type BundleEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  notes: string | null;
  projectId: string | null;
};

export type BundleDocument = { id: string; title: string; updatedAt: string };

/** A bound board widget this project owns, with the row titles a lede may name. */
export type BundleWidget = {
  id: string;
  title: string;
  rows: { id: string; title: string }[];
};

export type Bundle = {
  userId: string;
  project: { id: string; name: string; status: string };
  /** "on the 22nd" resolves against this, never against server time. */
  clock: { nowIso: string; timezone: string; localDate: string; tomorrowLocalDate: string };
  tasksOpen: BundleTask[];
  tasksDone: BundleTask[];
  memories: BundleMemory[];
  messages: BundleMessage[];
  expectations: BundleExpectation[];
  events: BundleEvent[];
  documents: BundleDocument[];
  previousRecord: ProjectRecord | null;
  widgets: BundleWidget[];
  /**
   * Every project of the user's that is not archived, by name, this one
   * included: the only names a set_project write may use, because the apply
   * path resolves the name against the same list and never creates one.
   */
  projectNames: string[];
  /** Inputs that fell over a bound, so a run can say what it did not see. */
  dropped: { field: string; count: number }[];
  /** The mention terms memories and messages were matched on; visible for tests. */
  terms: string[];
};
