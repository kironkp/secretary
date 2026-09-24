// docs/understanding/SPEC.md §4 steps 1-5: the mechanical checks on a run's
// output. Pure — a hand-built bundle, no database, no model.
import { describe, expect, it } from "vitest";
import { termMatcher } from "@/lib/understanding/terms";
import {
  BANNED_WORDS,
  countSentences,
  inflections,
  ledeNames,
  spelledDayIn,
  validateRunOutput,
} from "@/lib/understanding/validate";
import type { Bundle, RunOutput } from "@/lib/understanding/types";

const T_BLOCKED = "task-blocked";
const T_CHECK = "task-check";
const T_DONE = "task-done";
const M_STATEMENT = "memory-statement";
const MSG_CPO = "message-cpo";
const EXP_OPEN = "expectation-open";
const EV_CALL = "event-call";
const DOC_PLAN = "document-plan";

function makeBundle(): Bundle {
  const at = "2026-09-22T17:00:00.000Z";
  return {
    userId: "u1",
    project: { id: "p1", name: "Caltrans", status: "active" },
    clock: {
      nowIso: at,
      timezone: "America/Los_Angeles",
      localDate: "2026-09-22",
      tomorrowLocalDate: "2026-09-23",
    },
    tasksOpen: [
      {
        id: T_BLOCKED,
        title: "Process CPO 2073 / Production monitor as an FY 2027 transaction this month",
        notes: null,
        status: "blocked",
        stages: [],
        blockedReason: null,
        stakes: null,
        source: "spoken",
        recurrence: null,
        dueAt: "2026-08-21T07:00:00.000Z",
        completedAt: null,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: T_CHECK,
        title: "Check what is blocking CPO 2073 and report back",
        notes: null,
        status: "todo",
        stages: [],
        blockedReason: null,
        stakes: null,
        source: "spoken",
        recurrence: null,
        dueAt: null,
        completedAt: null,
        createdAt: at,
        updatedAt: at,
      },
    ],
    tasksDone: [
      {
        id: T_DONE,
        title:
          "CPO 2073 — Production monitor: convert to FY2027, create new CPO, obtain Marissa signature, send to Walter Myala",
        notes: "new number is 0394",
        status: "done",
        stages: [],
        blockedReason: null,
        stakes: null,
        source: "spoken",
        recurrence: null,
        dueAt: null,
        completedAt: at,
        createdAt: at,
        updatedAt: at,
      },
    ],
    memories: [
      {
        id: M_STATEMENT,
        fact: "The US Bank statement is part of the user's CPO reconciliation process.",
        tags: ["Caltrans"],
        createdAt: at,
        updatedAt: at,
      },
    ],
    messages: [
      {
        id: MSG_CPO,
        content: "I finished everything else that reconciling that CPO",
        createdAt: at,
        mode: "voice",
      },
    ],
    expectations: [
      {
        id: EXP_OPEN,
        taskId: T_BLOCKED,
        commitment: "report on the CPO",
        expectedUpdateBy: at,
        onMiss: "nag",
        status: "open",
      },
    ],
    events: [
      {
        id: EV_CALL,
        title: "Call Walter about CPO 2073",
        startsAt: at,
        endsAt: null,
        location: null,
        notes: null,
        projectId: "p1",
      },
    ],
    documents: [{ id: DOC_PLAN, title: "CPO plan", updatedAt: at }],
    previousRecord: null,
    widgets: [
      {
        id: "overdue",
        title: "Past due",
        rows: [
          {
            id: T_BLOCKED,
            title: "Process CPO 2073 / Production monitor as an FY 2027 transaction this month",
          },
          { id: T_CHECK, title: "Check what is blocking CPO 2073 and report back" },
        ],
      },
    ],
    projectNames: ["Album", "Caltrans", "Find It app"],
    dropped: [],
    terms: ["Caltrans", "CPO", "2073"],
  };
}

const task = (id: string) => ({ type: "task" as const, id });
const memory = (id: string) => ({ type: "memory" as const, id });
const message = (id: string) => ({ type: "message" as const, id });

/** A small, fully sourced output that should pass every check. */
function validOutput(): RunOutput {
  return {
    record: {
      objective: {
        text: "Pay one CPO a month and keep each reconciled.",
        sources: [memory(M_STATEMENT)],
        confidence: "medium",
      },
      things: [
        {
          name: "Production monitor",
          aliases: ["CPO 2073"],
          ids: ["2073", "0394"],
          state: {
            text: "Converted and signed; reconcile after the bank statement.",
            sources: [task(T_DONE), message(MSG_CPO)],
            confidence: "high",
            at: "2026-09-01",
          },
        },
      ],
      rules: [
        {
          text: "The US Bank statement is part of reconciling a CPO.",
          sources: [memory(M_STATEMENT)],
          confidence: "high",
        },
      ],
      decisions: [],
      currentWork: [],
      blockers: [],
      attempts: [],
      asked: [],
      contradictions: [
        {
          text: "CPO 2073 is filed as done and also as blocked with 0 of 4 stages ticked.",
          sources: [task(T_DONE), task(T_BLOCKED)],
        },
      ],
      unknowns: [
        {
          text: "Which CPO is paid next.",
          why: "The one-a-month rule needs a value nothing holds.",
          sources: [],
        },
      ],
      lastActivityAt: "2026-09-08",
    },
    questions: [
      {
        kind: "doesnt_add_up",
        question: "CPO 2073 is on your list twice. Close the open copies?",
        // Names an evidence item by its real title (SPEC §7).
        why: "It is done on Sep 1, and Check what is blocking CPO 2073 and report back is still open.",
        evidence: [task(T_DONE), task(T_BLOCKED), task(T_CHECK)],
        answers: [
          {
            id: "close-both",
            label: "Close both",
            writes: [
              { op: "complete_task", taskId: T_BLOCKED },
              { op: "complete_task", taskId: T_CHECK },
              { op: "resolve" },
            ],
          },
          { id: "keep", label: "Keep them", writes: [{ op: "resolve" }] },
        ],
      },
    ],
    words: {
      todayLine: "Nothing is due today. Tomorrow is the bank statement.",
      ledes: {
        overdue:
          "Both rows are the same CPO 2073. The Production monitor copy has been blocked since August 21.",
      },
    },
  };
}

function errorsOf(output: unknown, bundle = makeBundle()): string[] {
  const res = validateRunOutput(output, bundle);
  return res.ok ? [] : res.errors;
}

describe("a sourced output passes", () => {
  it("accepts the hand-written output as-is", () => {
    const res = validateRunOutput(validOutput(), makeBundle());
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) expect(res.value.record.things[0].ids).toEqual(["2073", "0394"]);
  });

  it("fills every omitted array with [] — a first run with little to say is still a record", () => {
    const res = validateRunOutput(
      { record: { lastActivityAt: "2026-09-01" }, words: {} },
      makeBundle()
    );
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) {
      expect(res.value.record.decisions).toEqual([]);
      expect(res.value.record.asked).toEqual([]);
      expect(res.value.questions).toEqual([]);
      expect(res.value.words.ledes).toEqual({});
    }
  });

  it("a lede may say when — month and weekday names are not names of things", () => {
    const out = validOutput();
    out.words.ledes.overdue = "Both have sat since August 21. The check was filed on a Tuesday in September.";
    expect(errorsOf(out)).toEqual([]);
  });

  it("a lede naming a row title passes", () => {
    const out = validOutput();
    out.words.ledes.overdue = "The oldest is Process CPO 2073 / Production monitor. Check it first.";
    expect(errorsOf(out)).toEqual([]);
  });

  it("a sentence-initial common word is prose, not a name", () => {
    const out = validOutput();
    out.words.ledes.overdue = "Three of these are past due. Both mention the same CPO.";
    expect(errorsOf(out)).toEqual([]);
  });
});

describe("step 1 and 2: sources", () => {
  it("an unsourced claim fails", () => {
    const out = validOutput();
    out.record.rules[0].sources = [];
    const errors = errorsOf(out);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(/record\.rules\.0\.sources/);
  });

  it("a source id not in the bundle fails and the error names the id", () => {
    const out = validOutput();
    out.record.rules[0].sources = [memory("memory-that-does-not-exist")];
    const errors = errorsOf(out);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("memory-that-does-not-exist");
    expect(errors[0]).toContain("record.rules[0]");
  });

  it("an id of the wrong type fails — a task id is not a message id", () => {
    const out = validOutput();
    out.questions[0].evidence = [message(T_DONE), task(T_CHECK)];
    const errors = errorsOf(out);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`unknown message id "${T_DONE}"`);
  });

  it("a contradiction with no sources fails", () => {
    const out = validOutput();
    out.record.contradictions[0].sources = [];
    expect(errorsOf(out).join("\n")).toMatch(/contradictions\.0\.sources/);
  });

  it("returns every error, not the first", () => {
    const out = validOutput();
    out.record.rules[0].sources = [memory("nope-1")];
    out.questions[0].evidence = [task("nope-2")];
    out.words.ledes.overdue = "It is waiting on the Antenna. Agenda for the week is set.";
    const errors = errorsOf(out);
    expect(errors.join("\n")).toContain("nope-1");
    expect(errors.join("\n")).toContain("nope-2");
    expect(errors.join("\n")).toContain("Antenna");
    expect(errors.join("\n")).toMatch(/banned word "Agenda"/);
  });
});

describe("step 3: writes", () => {
  it("a write with a foreign taskId fails", () => {
    const out = validOutput();
    out.questions[0].answers[0].writes = [
      { op: "complete_task", taskId: "someone-elses-task" },
      { op: "resolve" },
    ];
    const errors = errorsOf(out);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown task id "someone-elses-task"');
  });

  it("a clear_expectation naming an unknown expectation fails", () => {
    const out = validOutput();
    out.questions[0].answers[1].writes = [
      { op: "clear_expectation", expectationId: "not-in-bundle" },
      { op: "resolve" },
    ];
    expect(errorsOf(out)[0]).toContain('unknown expectation id "not-in-bundle"');
  });

  it("a set_step must name one of the user's processes and a step it has; a run never saves one", () => {
    const bundle = { ...makeBundle(), processes: [{ name: "CPO purchase cycle", steps: ["Quotes", "Form", "Sign"] }] };
    const withWrite = (w: unknown) => {
      const out = validOutput();
      out.questions[0].answers[0].writes = [w as never, { op: "resolve" }];
      return out;
    };
    expect(errorsOf(withWrite({ op: "set_step", taskId: T_CHECK, process: "cpo purchase cycle", step: 3 }), bundle)).toEqual([]);
    expect(errorsOf(withWrite({ op: "set_step", taskId: T_CHECK, process: "Grant cycle", step: 1 }), bundle)[0]).toContain(
      'no process named "Grant cycle"'
    );
    expect(errorsOf(withWrite({ op: "set_step", taskId: T_CHECK, process: "CPO purchase cycle", step: 4 }), bundle)[0]).toContain(
      "has 3 steps"
    );
    expect(
      errorsOf(withWrite({ op: "save_process", name: "Anything", steps: ["a", "b"] }), bundle)[0]
    ).toContain("save_process is not a run's to write");
  });

  it("a set_project must name one of the user's projects, matched the way a spoken name is", () => {
    const withProject = (project: string) => {
      const out = validOutput();
      out.questions[0].answers[0].writes = [{ op: "set_project", taskId: T_CHECK, project }, { op: "resolve" }];
      return out;
    };
    // Exact, case-blind, punctuation-blind and contained names all land,
    // because the apply path (resolveProject) would land them the same way.
    for (const name of ["Album", "caltrans", "find-it app", "Find It"]) {
      expect(errorsOf(withProject(name)), name).toEqual([]);
    }
    const errors = errorsOf(withProject("Nowhere Land"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('no project named "Nowhere Land"');
    expect(errors[0]).toContain("Album, Caltrans, Find It app");
  });

  it("one answer may not carry the same (op, id) twice", () => {
    const out = validOutput();
    out.questions[0].answers[0].writes = [
      { op: "complete_task", taskId: T_BLOCKED },
      { op: "complete_task", taskId: T_BLOCKED },
      { op: "resolve" },
    ];
    expect(errorsOf(out)[0]).toContain(`duplicate write complete_task:${T_BLOCKED}`);
  });

  it("two different answers may write the same task — they are alternatives", () => {
    const out = validOutput();
    out.questions[0].answers[1].writes = [{ op: "complete_task", taskId: T_BLOCKED }, { op: "resolve" }];
    expect(errorsOf(out)).toEqual([]);
  });

  it("an op outside the closed list is refused by the schema", () => {
    const out = validOutput();
    (out.questions[0].answers[0].writes as unknown[]).push({ op: "create_task", title: "x" });
    const errors = errorsOf(out);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(/questions\.0\.answers\.0\.writes\.3/);
  });
});

describe("step 4: plain language", () => {
  it("a banned word fails", () => {
    const out = validOutput();
    out.questions[0].why =
      "Check what is blocking CPO 2073 and report back slipped and nothing says why.";
    const errors = errorsOf(out);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('questions[0].why: banned word "slipped"');
  });

  it("the banned list is the spec's, no more and no less", () => {
    expect([...BANNED_WORDS]).toEqual([
      "slipped",
      "stale",
      "agenda",
      "leverage",
      "bandwidth",
      "circle back",
    ]);
  });

  it("banned words are whole words — 'stalemate' is not 'stale'", () => {
    const out = validOutput();
    out.record.rules[0].text = "The stalemate with the vendor holds.";
    expect(errorsOf(out)).toEqual([]);
  });

  it("a lede with 4 sentences fails", () => {
    const out = validOutput();
    out.words.ledes.overdue =
      "Both are CPO 2073. One is blocked. One is a check. Neither has moved since August.";
    expect(errorsOf(out)).toEqual(["words.ledes.overdue: more than 3 sentences"]);
  });

  it("a why with 3 sentences fails", () => {
    const out = validOutput();
    out.questions[0].why =
      "Check what is blocking CPO 2073 and report back is open. It is also done. Nothing says which is right.";
    expect(errorsOf(out)).toEqual(["questions[0].why: more than 2 sentences"]);
  });

  it("the Today line is one or two sentences", () => {
    const out = validOutput();
    out.words.todayLine = "Nothing is due today. Tomorrow is the bank statement. Then the form.";
    expect(errorsOf(out)).toEqual(["words.todayLine: more than 2 sentences"]);
    out.words.todayLine = "One. Two. Three. Four. Five.";
    expect(errorsOf(out)).toEqual(["words.todayLine: more than 2 sentences"]);
    out.words.todayLine = "Nothing is due today.";
    expect(errorsOf(out)).toEqual([]);
  });

  it("a question must end with ? or .", () => {
    const out = validOutput();
    out.questions[0].question = "Close the open copies";
    expect(errorsOf(out)).toEqual(["questions[0].question: must end with ? or ."]);
  });

  it("counts sentences the way a reader would", () => {
    expect(countSentences("")).toBe(0);
    expect(countSentences("One sentence")).toBe(1);
    expect(countSentences("One. Two. Three.")).toBe(3);
    expect(countSentences("Lenses (2110). Antenna (2079)?")).toBe(2);
    expect(countSentences("The U.S. Bank statement is due.")).toBe(1);
  });
});

describe("step 4: days as digits", () => {
  it("a spelled-out day fails on the Today line, a lede, a question and its why", () => {
    const out = validOutput();
    out.words.todayLine = "The statement is due on the twenty-second.";
    out.words.ledes.overdue = "Both wait on the fifteenth.";
    out.questions[0].question = "Was the check filed by the fifth?";
    out.questions[0].why =
      "Check what is blocking CPO 2073 and report back is dated September second.";
    expect(errorsOf(out)).toEqual([
      'questions[0].question: days as digits, not "by the fifth"',
      'questions[0].why: days as digits, not "September second"',
      'words.todayLine: days as digits, not "on the twenty-second"',
      'words.ledes.overdue: days as digits, not "on the fifteenth"',
    ]);
  });

  it("a spelled-out day in a record claim fails too", () => {
    const out = validOutput();
    out.record.rules[0].text = "The statement changes on the twenty second of the month.";
    expect(errorsOf(out)).toEqual([
      'record.rules[0].text: days as digits, not "on the twenty second"',
    ]);
  });

  it("ordinary ordinals are prose: first, the second copy, the third stage", () => {
    expect(spelledDayIn("Marissa signs first, then Walter.")).toBeNull();
    expect(spelledDayIn("The second copy shows 0 of 4 stages.")).toBeNull();
    expect(spelledDayIn("Check it first.")).toBeNull();
    expect(spelledDayIn("It is the third stage of four.")).toBeNull();
    expect(spelledDayIn("Pay after the first CPO is reconciled.")).toBeNull();
    expect(spelledDayIn("The state of the first one is unknown.")).toBeNull();
    // And digits are what the rule asks for.
    expect(spelledDayIn("All that is left on the 22nd is the statement.")).toBeNull();
    expect(spelledDayIn("Due September 2.")).toBeNull();
  });

  it("recognises the date constructions", () => {
    expect(spelledDayIn("due on the twenty-second")).toBe("on the twenty-second");
    expect(spelledDayIn("the eleventh is the deadline")).toBe("eleventh");
    expect(spelledDayIn("by the first of October")).toBe("by the first");
    expect(spelledDayIn("the first of October")).toBe("first of October");
    expect(spelledDayIn("Sept. the fourth")).toBe("Sept. the fourth");
    expect(spelledDayIn("thirtieth")).toBe("thirtieth");
  });
});

describe("step 4: a why names its evidence (SPEC §7)", () => {
  it("a why that names nothing from the evidence fails", () => {
    const out = validOutput();
    out.questions[0].why = "Something happened and it does not add up.";
    const errors = errorsOf(out);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^questions\[0\]\.why: does not name any of its evidence items\./);
    // The retry is told what it could have named.
    expect(errors[0]).toContain("Its evidence: [task:");
  });

  it("the full title of any evidence row satisfies it, whatever the case", () => {
    const out = validOutput();
    out.questions[0].why = "check what is blocking cpo 2073 and report back is still open.";
    expect(errorsOf(out)).toEqual([]);
  });

  it("a quote counts only when it is really in the source it is attached to", () => {
    const out = validOutput();
    out.questions[0].evidence = [
      { type: "task", id: T_CHECK, quote: "blocking CPO 2073" },
      task(T_DONE),
    ];
    out.questions[0].why = "Something is still blocking CPO 2073 after the done copy closed on Sep 1.";
    expect(errorsOf(out)).toEqual([]);

    // Words attributed to a row that never said them, in a why that names
    // nothing else about that row either (no number, no name, no run of its
    // words): the quote alone cannot carry it.
    out.questions[0].evidence = [{ type: "task", id: T_DONE, quote: "blocking it still" }];
    out.questions[0].why = "Something is blocking it still, after the other copy closed on Sep 1.";
    const errors = errorsOf(out);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/does not name any of its evidence items/);
  });

  it("a why can name a task the way a person does: its number, a name in it, or a run of its words", () => {
    const out = validOutput();
    out.questions[0].evidence = [task(T_DONE)];
    out.questions[0].why = "The 2073 copy you finished on Sep 1 is still on the list.";
    expect(errorsOf(out)).toEqual([]);

    out.questions[0].why = "It still needs a signature from Marissa according to the finished copy.";
    expect(errorsOf(out)).toEqual([]);

    out.questions[0].why = "You already did convert to FY2027, create new CPO and the rest of it.";
    expect(errorsOf(out)).toEqual([]);

    // Three words in a row is not a quotation.
    out.questions[0].why = "You already did create new CPO paperwork of some kind.";
    expect(errorsOf(out)).toHaveLength(1);
  });

  it("a message quote works the same way — the user's own words", () => {
    const out = validOutput();
    out.questions[0].evidence = [{ type: "message", id: MSG_CPO, quote: "finished everything else" }];
    out.questions[0].why = 'You said you "finished everything else" on Sep 1.';
    expect(errorsOf(out)).toEqual([]);
  });

  it("a quote too short to name anything does not count", () => {
    const out = validOutput();
    out.questions[0].evidence = [{ type: "message", id: MSG_CPO, quote: "CPO" }];
    out.questions[0].why = "The CPO is done.";
    expect(errorsOf(out)).toHaveLength(1);
  });
});

describe("step 5: a lede names only what is in its widget", () => {
  it("a lede naming Antenna when no row contains it fails", () => {
    const out = validOutput();
    out.words.ledes.overdue = "The oldest is the Antenna (2079).";
    const errors = errorsOf(out);
    expect(errors).toEqual([
      'words.ledes.overdue: lede names something not in the widget: "2079"',
      'words.ledes.overdue: lede names something not in the widget: "Antenna"',
    ]);
  });

  it("the project name and the widget title are always allowed", () => {
    const out = validOutput();
    out.words.ledes.overdue = "Everything Past Due here is Caltrans work on CPO 2073.";
    expect(errorsOf(out)).toEqual([]);
  });

  it("a lede for a widget not in the bundle fails", () => {
    const out = validOutput();
    (out.words.ledes as Record<string, string>)["coming-up"] = "Nothing this week.";
    expect(errorsOf(out)).toEqual(['words.ledes.coming-up: "coming-up" is not a widget in the bundle']);
  });

  it("ledeNames keeps all-caps words at the start of a sentence and exempts the rest", () => {
    // "Lenses" opens a sentence and is exempt as prose; its number still
    // names it, which is why "nickname and number together" (SPEC §7) matters.
    expect(ledeNames("CPO 2073 is oldest. Lenses (2110) is ready.")).toEqual(["2073", "2110", "CPO"]);
    expect(ledeNames("Three are late. Check the Antenna.")).toEqual(["Antenna"]);
    expect(ledeNames("Antenna is late.")).toEqual([]);
  });

  it("a plural of a row-title word is the same name — 'Both CPOs' passes", () => {
    const out = validOutput();
    out.words.ledes.overdue = "Both CPOs here are the same job.";
    expect(errorsOf(out)).toEqual([]);
  });

  it("and the singular of a plural in a row title passes", () => {
    const bundle = makeBundle();
    bundle.widgets[0].rows = [{ id: T_BLOCKED, title: "Send the Lenses and the Copies" }];
    const out = validOutput();
    out.words.ledes.overdue = "One Lens is in. Every Copy is in.";
    expect(errorsOf(out, bundle)).toEqual([]);
  });

  it("inflections go both ways and never lose the word itself", () => {
    expect(inflections("CPOs")).toContain("cpo");
    expect(inflections("cpo")).toContain("cpos");
    expect(inflections("copies")).toContain("copy");
    expect(inflections("copy")).toContain("copies");
    expect(inflections("lenses")).toContain("lens");
    expect(inflections("2073")).toContain("2073");
  });
});

describe("terms: mentions are matched the way resolveProject normalizes", () => {
  it("is case- and punctuation-blind inside a term, whole-word at its edges", () => {
    const find = termMatcher(["Find It app", "Prod. monitor", "CPO"]);
    expect(find("the find-it app is ready")).toBe(true);
    expect(find("FIND IT APP")).toBe(true);
    expect(find("the prod monitor")).toBe(true);
    expect(find("that CPO")).toBe(true);
    // Not glued to other letters or digits.
    expect(find("CPOs")).toBe(false);
    expect(find("the findit app")).toBe(false);
    expect(termMatcher(["..."])("...")).toBe(false);
  });
});

describe("an answer's targets are evidence by definition (SPEC §6)", () => {
  it("adds a task a write names to the question's evidence instead of leaving the answer unusable", () => {
    const out = validOutput();
    out.questions[0].evidence = [{ type: "task", id: T_DONE }];
    out.questions[0].why = `The finished copy "${out.questions[0].why}"`;
    out.questions[0].answers = [
      { id: "close", label: "Close it", writes: [{ op: "complete_task", taskId: T_CHECK }, { op: "resolve" }] },
      { id: "keep", label: "Keep it", writes: [{ op: "resolve" }] },
    ];
    const res = validateRunOutput(out, makeBundle());
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.questions[0].evidence).toContainEqual({ type: "task", id: T_CHECK });
      // Listed once, whatever the number of writes that name it.
      expect(res.value.questions[0].evidence.filter((s) => s.id === T_CHECK)).toHaveLength(1);
    }
  });

  it("still refuses a write naming a task the bundle does not have", () => {
    const out = validOutput();
    out.questions[0].answers[0].writes = [{ op: "complete_task", taskId: "task-nowhere" }, { op: "resolve" }];
    const errors = errorsOf(out);
    expect(errors.some((e) => e.includes("task-nowhere"))).toBe(true);
  });
});

describe("a question is one breath and an answer is an action (SPEC §7)", () => {
  it("rejects a question longer than 14 words and names the count", () => {
    const out = validOutput();
    out.questions[0].question =
      "Should I clean up the CPO 2073 Production monitor tasks that still say blocked even though the notes and finished task say the work is done?";
    const errors = errorsOf(out).filter((e) => e.includes(".question:"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\d+ words; say it in at most 14/);
  });

  it("rejects a pasted title with a slash in the question", () => {
    const out = validOutput();
    out.questions[0].question = "Close CPO 2073 / Production monitor?";
    expect(errorsOf(out).some((e) => e.includes("contains a slash"))).toBe(true);
  });

  it("rejects an answer label that is a code or too long, and accepts an action", () => {
    const out = validOutput();
    out.questions[0].answers[0].label = "Mark FY2027 done";
    expect(errorsOf(out).some((e) => e.includes("carries a code"))).toBe(true);

    out.questions[0].answers[0].label = "Close the old copy and keep the new one";
    expect(errorsOf(out).some((e) => e.includes("not an action in plain words"))).toBe(true);

    out.questions[0].answers[0].label = "Close the old one";
    expect(errorsOf(out)).toEqual([]);
  });
});
describe("a question about my own suggestions must offer to drop them (SPEC §7)", () => {
  /** The bundle with T_CHECK marked as a task Secretary suggested and nobody took up. */
  const suggestedBundle = (): Bundle => {
    const b = makeBundle();
    b.tasksOpen = b.tasksOpen.map((t) => (t.id === T_CHECK ? { ...t, source: "suggested" } : t));
    return b;
  };

  it("rejects answers that can only complete or reschedule it, and names the row to drop", () => {
    // The 2026-09-23 shape: four stale suggestions, and every answer either
    // says they happened or moves their dates. Nothing bins them, so "old
    // suggestions you can get rid of" had nothing behind it.
    const out = validOutput();
    out.questions[0].evidence = [{ type: "task", id: T_CHECK }];
    out.questions[0].why = "Check what is blocking CPO 2073 and report back is 22 days late.";
    out.questions[0].answers = [
      { id: "done", label: "Yes, done", writes: [{ op: "complete_task", taskId: T_CHECK }, { op: "resolve" }] },
      { id: "later", label: "Not yet", writes: [{ op: "set_due", taskId: T_CHECK, dueAt: "2026-09-30" }] },
      { id: "keep", label: "Keep it", writes: [{ op: "resolve" }] },
    ];
    const res = validateRunOutput(out, suggestedBundle());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const hit = res.errors.find((e) => e.includes("never took up"));
    expect(hit).toBeDefined();
    expect(hit).toContain(T_CHECK);
    expect(hit).toContain("drop_task");
  });

  it("passes once one answer drops it", () => {
    const out = validOutput();
    out.questions[0].evidence = [{ type: "task", id: T_CHECK }];
    out.questions[0].why = "Check what is blocking CPO 2073 and report back is 22 days late.";
    out.questions[0].answers = [
      { id: "drop", label: "Drop it", writes: [{ op: "drop_task", taskId: T_CHECK }, { op: "resolve" }] },
      { id: "keep", label: "Keep it", writes: [{ op: "resolve" }] },
    ];
    expect(validateRunOutput(out, suggestedBundle()).ok).toBe(true);
  });

  it("leaves a question about the user's own tasks alone", () => {
    // T_CHECK is "spoken" in the plain bundle: the user's work, not my guess.
    const out = validOutput();
    out.questions[0].evidence = [{ type: "task", id: T_CHECK }];
    out.questions[0].why = "Check what is blocking CPO 2073 and report back is 22 days late.";
    out.questions[0].answers = [
      { id: "done", label: "Yes, done", writes: [{ op: "complete_task", taskId: T_CHECK }, { op: "resolve" }] },
      { id: "keep", label: "Keep it", writes: [{ op: "resolve" }] },
    ];
    expect(validateRunOutput(out, makeBundle()).ok).toBe(true);
  });
});

describe("the words never promise what the loop cannot do (SPEC §7)", () => {
  it("rejects a lede that says it will clear things, and says why", () => {
    // Verbatim from the Overdue widget on 2026-09-23. Nothing in a run
    // touches the user's rows, so this was a promise nobody could keep.
    const out = validOutput();
    const widgetId = Object.keys(out.words.ledes)[0];
    out.words.ledes[widgetId] =
      "You said these are old suggestions rather than real remaining work, so I'll clear them rather than chase the dates.";
    const res = validateRunOutput(out, makeBundle());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const hit = res.errors.find((e) => e.includes("promises something you cannot do"));
    expect(hit).toBeDefined();
    expect(hit).toContain("I'll");
  });

  it("rejects the same promise in a question's why", () => {
    const out = validOutput();
    out.questions[0].why = `${out.questions[0].why} I will close the old copy.`;
    const errors = errorsOf(out);
    expect(errors.some((e) => e.includes("promises something you cannot do"))).toBe(true);
  });

  it("allows the user's own first person, quoted, which the prompt asks for", () => {
    // referencesEvidence rewards a why that copies the user's words, and
    // decisions is where a commitment they made belongs. Refusing those
    // failed the whole run and locked the project out for six hours.
    const out = validOutput();
    out.questions[0].why = `You wrote "I'll finish reconciling that CPO once the statement lands".`;
    const errors = errorsOf(out);
    expect(errors.some((e) => e.includes("promises something you cannot do"))).toBe(false);

    const quoted = validOutput();
    quoted.record.decisions = [
      {
        text: `You decided: "I will pay CPO 2073 after the US Bank statement".`,
        sources: [{ type: "task", id: T_DONE }],
        confidence: "high",
      },
    ];
    expect(
      errorsOf(quoted).some((e) => e.includes("promises something you cannot do"))
    ).toBe(false);
  });

  it("refuses a claim that the work is already done, not only a promise", () => {
    const out = validOutput();
    const widgetId = Object.keys(out.words.ledes)[0];
    out.words.ledes[widgetId] = "I have cleared the old suggestions for you.";
    expect(
      errorsOf(out).some((e) => e.includes("promises something you cannot do"))
    ).toBe(true);
  });

  it("allows a recommendation, which is how a why is supposed to read", () => {
    const out = validOutput();
    out.questions[0].why = `${out.questions[0].why} I would close the old copy.`;
    expect(validateRunOutput(out, makeBundle()).ok).toBe(true);
  });
});
