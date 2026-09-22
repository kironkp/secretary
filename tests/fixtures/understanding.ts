// The duplicate-CPO scenario from docs/understanding/SPEC.md §1, seeded into
// the local database for one throwaway user, plus the two helpers every run
// test needs: a fake model (no live model is ever called under vitest) and a
// run output that passes validateRunOutput against the bundle gather builds.
//
// The seeds mirror tests/understanding-gather.test.ts on purpose: the point of
// the scenario is that the meaning of the CPO thread lives in rows with no
// project link (a memory, three messages) and the bundle finds them by the
// words in them. Everything is relative to CPO_NOW so "due tomorrow", "20 days
// ago" and the local date are the same in every assertion.
import {
  conversations,
  documents,
  events,
  expectations,
  memories,
  messages,
  projects,
  tasks,
} from "@/lib/db/schema";
import { db } from "@/lib/db";
import type { Bundle, RunOutput } from "@/lib/understanding/types";

/** 2026-09-22 08:00 in Los Angeles: a Tuesday morning, so "tomorrow" is the 23rd. */
export const CPO_NOW = new Date("2026-09-22T15:00:00.000Z");
export const CPO_TZ = "America/Los_Angeles";

const DAY_MS = 86_400_000;
const daysFrom = (now: Date, n: number) => new Date(now.getTime() + n * DAY_MS);

export type CpoIds = {
  caltrans: string;
  album: string;
  conversation: string;
  /** done 21 days ago, notes "new number is 0394" */
  doneCpo: string;
  /** blocked, due 2026-08-21, 0 of 4 stages done */
  blockedCpo: string;
  /** todo "Check what is blocking CPO 2073 and report back", 2 days overdue */
  checkCpo: string;
  /** todo "Do the US Bank statement", due tomorrow */
  statement: string;
  /** the other project's overdue task, so the Overdue widget has a non-Caltrans row */
  albumOverdue: string;
  memStatement: string;
  memMonthly: string;
  memAlbum: string;
  msgCpo: string;
  msgStatement: string;
  msgFinished: string;
  msgNothingBlocked: string;
  msgMilk: string;
  expectation: string;
  eventLinked: string;
  eventTerm: string;
  eventDentist: string;
  document: string;
};

/**
 * Seed the scenario for `userId` (which must already exist) and return every
 * id. Cleaning up is the caller's job: deleting the user cascades everything.
 */
export async function seedCpoScenario(userId: string, now: Date = CPO_NOW): Promise<CpoIds> {
  const at = (n: number) => daysFrom(now, n);

  const [caltrans] = await db
    .insert(projects)
    .values({ userId, name: "Caltrans", status: "active" })
    .returning();
  const [album] = await db
    .insert(projects)
    .values({ userId, name: "Album", status: "active" })
    .returning();

  const [doneCpo] = await db
    .insert(tasks)
    .values({
      userId,
      projectId: caltrans.id,
      title:
        "CPO 2073 — Production monitor: convert to FY2027, create new CPO, obtain Marissa signature, send to Walter Myala",
      notes: "new number is 0394",
      status: "done",
      completedAt: at(-21),
      updatedAt: at(-21),
      createdAt: at(-40),
    })
    .returning();
  const [blockedCpo] = await db
    .insert(tasks)
    .values({
      userId,
      projectId: caltrans.id,
      title: "Process CPO 2073 / Production monitor as an FY 2027 transaction this month",
      status: "blocked",
      // SPEC §1: the open copy is due 2026-08-21 with 0 of 4 stages ticked.
      dueAt: new Date("2026-08-21T19:00:00.000Z"),
      stages: [
        { name: "Update", done: false },
        { name: "Sign", done: false },
        { name: "Pay", done: false },
        { name: "Reconcile and submit", done: false },
      ],
      updatedAt: at(-30),
      createdAt: at(-45),
    })
    .returning();
  const [checkCpo] = await db
    .insert(tasks)
    .values({
      userId,
      projectId: caltrans.id,
      title: "Check what is blocking CPO 2073 and report back",
      status: "todo",
      dueAt: at(-2),
      updatedAt: at(-14),
      createdAt: at(-14),
    })
    .returning();
  const [statement] = await db
    .insert(tasks)
    .values({
      userId,
      projectId: caltrans.id,
      title: "Do the US Bank statement",
      status: "todo",
      // 08:00 tomorrow in Los Angeles: the hero question's 48-hour window.
      dueAt: at(1),
      updatedAt: at(-21),
      createdAt: at(-21),
    })
    .returning();
  const [albumOverdue] = await db
    .insert(tasks)
    .values({
      userId,
      projectId: album.id,
      title: "Master the title track",
      status: "todo",
      dueAt: at(-1),
    })
    .returning();

  const [memStatement] = await db
    .insert(memories)
    .values({
      userId,
      fact: "The US Bank statement is part of the user's CPO reconciliation process.",
      tags: ["Caltrans", "inferred"],
    })
    .returning();
  const [memMonthly] = await db
    .insert(memories)
    .values({
      userId,
      fact: "User is handling CPOs by doing/paying one each month and spacing them out.",
      tags: ["Caltrans"],
    })
    .returning();
  const [memAlbum] = await db
    .insert(memories)
    .values({
      userId,
      fact: "The album cover needs a new photo before the release.",
      tags: ["Album"],
    })
    .returning();

  const [conv] = await db
    .insert(conversations)
    .values({ userId, mode: "voice", startedAt: at(-21) })
    .returning();
  const say = (content: string, daysAgo: number, role: "user" | "assistant" = "user") => ({
    userId,
    conversationId: conv.id,
    role,
    mode: "voice" as const,
    content,
    createdAt: at(-daysAgo),
  });
  const [msgCpo, msgStatement, msgFinished, msgNothingBlocked, msgMilk] = await db
    .insert(messages)
    .values([
      say("It's for that CPO. Yeah, it's a part of reconciling the CPO", 21),
      say("All I need to do on the 22nd is change the bank statement", 21),
      say("All right, I finished everything else that reconciling that CPO", 21),
      say("Nothing is blocked right now on the CPO side", 21),
      say("Remind me to buy milk on the way home", 1),
      // The assistant's turn is never an input, however many terms it carries.
      say("Noted: CPO 2073 for Caltrans is reconciled once the statement changes.", 21, "assistant"),
    ])
    .returning();

  const [expectation] = await db
    .insert(expectations)
    .values({
      userId,
      taskId: blockedCpo.id,
      commitment: "report on what is blocking the CPO",
      expectedUpdateBy: at(2),
      status: "open",
    })
    .returning();

  const [eventLinked, eventTerm, eventDentist] = await db
    .insert(events)
    .values([
      { userId, projectId: caltrans.id, title: "Sign the new form with Marissa", startsAt: at(3) },
      // Not linked to the project; joins the bundle only by the words in it.
      { userId, title: "Call Walter about CPO 2073", startsAt: at(4) },
      { userId, title: "Dentist", startsAt: at(5) },
    ])
    .returning();

  const [document] = await db
    .insert(documents)
    .values({ userId, projectId: caltrans.id, title: "CPO reconciliation notes" })
    .returning();

  return {
    caltrans: caltrans.id,
    album: album.id,
    conversation: conv.id,
    doneCpo: doneCpo.id,
    blockedCpo: blockedCpo.id,
    checkCpo: checkCpo.id,
    statement: statement.id,
    albumOverdue: albumOverdue.id,
    memStatement: memStatement.id,
    memMonthly: memMonthly.id,
    memAlbum: memAlbum.id,
    msgCpo: msgCpo.id,
    msgStatement: msgStatement.id,
    msgFinished: msgFinished.id,
    msgNothingBlocked: msgNothingBlocked.id,
    msgMilk: msgMilk.id,
    expectation: expectation.id,
    eventLinked: eventLinked.id,
    eventTerm: eventTerm.id,
    eventDentist: eventDentist.id,
    document: document.id,
  };
}

// --------------------------------------------------------------------------
// The fake model
// --------------------------------------------------------------------------

/** Structurally lib/understanding/run.ts's ModelCall input, spelled out here so the fixture does not depend on it. */
export type FakeModelInput = {
  system: string;
  user: string;
  bundle: Bundle;
  attempt: number;
  previousErrors: string[];
};

export type FakeModelResult = {
  output: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/** What the fake saw on each call, in order. */
export type FakeCall = {
  attempt: number;
  previousErrors: string[];
  user: string;
  system: string;
  bundle: Bundle;
};

export type FakeModel = ((input: FakeModelInput) => Promise<FakeModelResult>) & {
  calls: FakeCall[];
};

/**
 * A ModelCall that never leaves the process: `builder` gets the bundle the run
 * gathered (and which attempt this is, so a test can be wrong once and right
 * the second time) and returns the raw output the run will validate. Every
 * call is recorded on `.calls`.
 */
export function fakeModel(
  builder: (
    bundle: Bundle,
    call: { attempt: number; previousErrors: string[] }
  ) => unknown | Promise<unknown>
): FakeModel {
  const calls: FakeCall[] = [];
  const fn = async (input: FakeModelInput): Promise<FakeModelResult> => {
    calls.push({
      attempt: input.attempt,
      previousErrors: [...input.previousErrors],
      user: input.user,
      system: input.system,
      bundle: input.bundle,
    });
    const output = await builder(input.bundle, {
      attempt: input.attempt,
      previousErrors: input.previousErrors,
    });
    return { output, model: "fake", inputTokens: 10, outputTokens: 5 };
  };
  return Object.assign(fn, { calls });
}

// --------------------------------------------------------------------------
// Outputs that pass validation
// --------------------------------------------------------------------------

/**
 * One lede per widget in the bundle, worded so it names nothing: SPEC §4 step
 * 5 rejects a lede that names a title outside its widget's rows, and the
 * default board's widgets carry different rows for every project.
 */
export function ledesFor(bundle: Bundle): Record<string, string> {
  return Object.fromEntries(
    bundle.widgets.map((w) => [w.id, "Every row here is still open. The oldest is first."])
  );
}

function emptyRecord(bundle: Bundle): RunOutput["record"] {
  return {
    things: [],
    rules: [],
    decisions: [],
    currentWork: [],
    blockers: [],
    attempts: [],
    contradictions: [],
    unknowns: [],
    asked: [],
    lastActivityAt: bundle.clock.nowIso,
  };
}

/** A valid output that says nothing: for the project a test does not care about. */
export function minimalOutputFor(bundle: Bundle): RunOutput {
  return { record: emptyRecord(bundle), questions: [], words: { ledes: ledesFor(bundle) } };
}

/**
 * The Caltrans run as SPEC §2's worked example would have it, reduced to what
 * the tests assert on: one thing (CPO 2073) sourced to the done task, one
 * contradiction sourced to both 2073 copies, one unknown, the doesnt_add_up
 * question about the duplicate and the need_to_know question about the
 * statement due tomorrow. Titles are read from the bundle, not retyped, so the
 * `why` quotes exactly what validate.ts will look for.
 */
export function validOutputFor(bundle: Bundle, ids: CpoIds): RunOutput {
  const all = [...bundle.tasksOpen, ...bundle.tasksDone];
  const titleOf = (id: string) => all.find((t) => t.id === id)?.title ?? id;
  const doneTitle = titleOf(ids.doneCpo);
  const blockedTitle = titleOf(ids.blockedCpo);
  const statementTitle = titleOf(ids.statement);

  return {
    record: {
      ...emptyRecord(bundle),
      things: [
        {
          name: "Production monitor",
          aliases: ["CPO 2073"],
          ids: ["2073", "0394"],
          state: {
            text: "Converted to FY 2027 and signed; the new number is 0394.",
            sources: [{ type: "task", id: ids.doneCpo, quote: "new number is 0394" }],
            confidence: "high",
          },
        },
      ],
      rules: [
        {
          text: "One CPO payment a month, spaced out.",
          sources: [{ type: "memory", id: ids.memMonthly }],
          confidence: "high",
        },
      ],
      contradictions: [
        {
          text: "CPO 2073 is finished as one task and still open and blocked as another.",
          sources: [
            { type: "task", id: ids.blockedCpo },
            { type: "task", id: ids.doneCpo },
          ],
        },
      ],
      unknowns: [
        {
          text: "Which CPO is paid next.",
          why: "The rule is one a month and nothing names the next one.",
          sources: [{ type: "memory", id: ids.memMonthly }],
        },
      ],
    },
    questions: [
      {
        kind: "doesnt_add_up",
        question: "CPO 2073 is on your list twice?",
        why: `"${doneTitle}" is finished and says the new number is 0394, but "${blockedTitle}" is still open with 0 of 4 steps done.`,
        evidence: [
          { type: "task", id: ids.doneCpo },
          { type: "task", id: ids.blockedCpo },
          { type: "task", id: ids.checkCpo },
        ],
        answers: [
          {
            id: "close-both",
            label: "Close both",
            writes: [
              { op: "complete_task", taskId: ids.blockedCpo },
              { op: "complete_task", taskId: ids.checkCpo },
              { op: "resolve" },
            ],
          },
          { id: "keep-them", label: "Keep them", writes: [{ op: "resolve" }] },
        ],
      },
      {
        kind: "need_to_know",
        question: "Is the US Bank statement the last step before CPO 2073 is reconciled?",
        why: `"${statementTitle}" is due tomorrow, and you said "I finished everything else that reconciling that CPO".`,
        evidence: [
          { type: "task", id: ids.statement },
          {
            type: "message",
            id: ids.msgFinished,
            quote: "I finished everything else that reconciling that CPO",
          },
        ],
        answers: [
          {
            id: "yes-last-step",
            label: "Yes, that is the last step",
            writes: [
              {
                op: "remember_fact",
                fact: "The US Bank statement is the last step of reconciling CPO 2073.",
                tags: ["Caltrans"],
              },
              { op: "resolve" },
            ],
          },
          { id: "not-yet", label: "Not yet", writes: [{ op: "resolve" }] },
        ],
      },
    ],
    words: {
      todayLine: "Nothing is due today. The US Bank statement is due tomorrow.",
      ledes: ledesFor(bundle),
    },
  };
}
