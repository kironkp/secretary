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
  canterly: string;
  album: string;
  conversation: string;
  /** done 21 days ago, notes "new number is 0581" */
  doneCpo: string;
  /** blocked, due 2026-08-21, 0 of 4 stages done */
  blockedCpo: string;
  /** todo "Check what is blocking CPO 4513 and report back", 2 days overdue */
  checkCpo: string;
  /** todo "Do the NW Bank statement", due tomorrow */
  statement: string;
  /** the other project's overdue task, so the Overdue widget has a non-Canterly row */
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
  eventHaircut: string;
  document: string;
};

/**
 * Seed the scenario for `userId` (which must already exist) and return every
 * id. Cleaning up is the caller's job: deleting the user cascades everything.
 */
export async function seedCpoScenario(userId: string, now: Date = CPO_NOW): Promise<CpoIds> {
  const at = (n: number) => daysFrom(now, n);

  const [canterly] = await db
    .insert(projects)
    .values({ userId, name: "Canterly", status: "active" })
    .returning();
  const [album] = await db
    .insert(projects)
    .values({ userId, name: "Album", status: "active" })
    .returning();

  const [doneCpo] = await db
    .insert(tasks)
    .values({
      userId,
      projectId: canterly.id,
      title:
        "CPO 4513 — Projection screen: convert to FY2031, create new CPO, obtain Melissa signature, send to Warren Meala",
      notes: "new number is 0581",
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
      projectId: canterly.id,
      title: "Process CPO 4513 / Projection screen as an FY 2031 transaction this month",
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
      projectId: canterly.id,
      title: "Check what is blocking CPO 4513 and report back",
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
      projectId: canterly.id,
      title: "Do the NW Bank statement",
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
      title: "Pick the running order",
      status: "todo",
      dueAt: at(-1),
    })
    .returning();

  const [memStatement] = await db
    .insert(memories)
    .values({
      userId,
      fact: "The NW Bank statement is part of the user's CPO reconciliation process.",
      tags: ["Canterly", "inferred"],
    })
    .returning();
  const [memMonthly] = await db
    .insert(memories)
    .values({
      userId,
      fact: "User is paying off CPOs one a month, spaced apart.",
      tags: ["Canterly"],
    })
    .returning();
  const [memAlbum] = await db
    .insert(memories)
    .values({
      userId,
      fact: "The album needs a final listen before the release.",
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
      say("That one's for the CPO. It goes with squaring up the CPO", 21),
      say("On the 22nd the only thing left is the bank statement", 21),
      say("Okay, the rest of squaring up that CPO is done", 21),
      say("Nothing on the CPO side is blocked at the moment", 21),
      say("Remind me to pick up stamps on the way home", 1),
      // The assistant's turn is never an input, however many terms it carries.
      say("Noted: CPO 4513 for Canterly is squared up once the statement is in.", 21, "assistant"),
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

  const [eventLinked, eventTerm, eventHaircut] = await db
    .insert(events)
    .values([
      { userId, projectId: canterly.id, title: "Sign the new form with Melissa", startsAt: at(3) },
      // Not linked to the project; joins the bundle only by the words in it.
      { userId, title: "Call Warren about CPO 4513", startsAt: at(4) },
      { userId, title: "Haircut", startsAt: at(5) },
    ])
    .returning();

  const [document] = await db
    .insert(documents)
    .values({ userId, projectId: canterly.id, title: "CPO reconciliation notes" })
    .returning();

  return {
    canterly: canterly.id,
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
    eventHaircut: eventHaircut.id,
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
 * The Canterly run as SPEC §2's worked example would have it, reduced to what
 * the tests assert on: one thing (CPO 4513) sourced to the done task, one
 * contradiction sourced to both 4513 copies, one unknown, the doesnt_add_up
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
          name: "Projection screen",
          aliases: ["CPO 4513"],
          ids: ["4513", "0581"],
          state: {
            text: "Converted to FY 2031 and signed; the new number is 0581.",
            sources: [{ type: "task", id: ids.doneCpo, quote: "new number is 0581" }],
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
          text: "CPO 4513 is finished as one task and still open and blocked as another.",
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
        question: "CPO 4513 is on your list twice?",
        why: `"${doneTitle}" is finished and says the new number is 0581, but "${blockedTitle}" is still open with 0 of 4 steps done.`,
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
        question: "Is the NW Bank statement the last step before CPO 4513 is reconciled?",
        why: `"${statementTitle}" is due tomorrow, and you said "the rest of squaring up that CPO is done".`,
        evidence: [
          { type: "task", id: ids.statement },
          {
            type: "message",
            id: ids.msgFinished,
            quote: "the rest of squaring up that CPO is done",
          },
        ],
        answers: [
          {
            id: "yes-last-step",
            label: "Yes, last step",
            writes: [
              {
                op: "remember_fact",
                fact: "The NW Bank statement is the last step of reconciling CPO 4513.",
                tags: ["Canterly"],
              },
              { op: "resolve" },
            ],
          },
          { id: "not-yet", label: "Not yet", writes: [{ op: "resolve" }] },
        ],
      },
    ],
    words: {
      todayLine: "Nothing is due today. The NW Bank statement is due tomorrow.",
      ledes: ledesFor(bundle),
    },
  };
}
