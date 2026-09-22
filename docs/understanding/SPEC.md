# The understanding loop

**Status: designed 2026-09-22; phases 1–6 built 2026-09-22 (§11).** This is the design behind the
fourth mockup pass (the "Secretary on iPhone" artifact). It replaces the
"narrator" sketched in the third pass. Kiron's verdict on the third pass was
the brief: *"this thing needs to be smart. It can't just be a database."* And
on 2026-09-08, in a voice session already in the database: *"if you don't
know why, you should ask me why."*

Read `docs/secretary-agent-guide.md` §4.3 first. This document gives that
Project Intelligence record a store, a writer, and a reader, and adds the
three things the guide did not specify: contradictions, unknowns, and the
questions that come from them.

## 1. Why the narrator was still a database

The third pass fed a model the *resolved rows* of a widget: titles, due
labels, projects, stages, blockers. Rows are what got filed. A row titled
"Do the US Bank statement" cannot know that the statement is the last step of
reconciling CPO 2073 and the gate to paying the next CPO. That knowledge
exists in the database, but not in the row:

| Where it is | What it says |
|---|---|
| `messages`, user, 2026-09-01 14:xx | "It's for that CPO. Yeah, it's a part of reconciling the CPO" |
| `messages`, user, 2026-09-01 15:xx | "All I need to do on the 22nd is change the bank statement" |
| `tasks.notes` on a task that is `done` | "User finished everything else for reconciling; new number is 0394. Remaining dependency is bank statement change on the 22nd" |
| `memories` (tag `inferred`) | "The US Bank statement is part of the user's CPO reconciliation process." |
| `memories` | "User is handling CPOs by doing/paying one each month and spacing them out." |

Nothing in the app reads those five things together. The fix is the input,
not the prose.

The same data holds contradictions nobody has been asked about:

- CPO 2073 exists as a `done` task (2026-09-01, "new number is 0394") **and**
  as a `blocked` task due 2026-08-21 with 0 of 4 stages ticked, **and** as a
  `todo` "Check what is blocking CPO 2073" from 2026-09-08, after the user
  said on 2026-09-01 "nothing is blocked".
- CPO 2110 exists as a `done` task (2026-09-01) **and** as a `todo` with 0 of
  4 stages ticked.
- 15 of the 23 past-due tasks have `source = suggested` and were never
  accepted. Three of them are "this week's WSR" and one is "this week's
  timesheet", weekly things filed as one-offs.
- `expectations` holds "Canva quote received from Mary", `open`, expected by
  2026-09-16. Nothing asked.
- `clarifications` holds 242 `open`/`asked` rows, all of the ASR kinds
  ("I heard CPO — is that CPS, or someone new?"). None is about meaning.

Every one of these is a question the app should have asked. The loop below
asks them.

## 2. The record

One row per project, table `records`:

```ts
export const records = pgTable("records", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  body: jsonb("body").$type<Record>().notNull(),
  // Hash of the gathered inputs the body was written from. Same hash, no run.
  inputsHash: text("inputs_hash").notNull(),
  version: integer("version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("records_project_idx").on(t.userId, t.projectId)]);
```

`Record` is the guide's §4.3 contract plus the three new sections:

```ts
type Source = { type: "task" | "memory" | "message" | "event" | "document" | "expectation"; id: string; quote?: string };

type Record = {
  objective?: Claim;                 // one sentence
  things: Thing[];                   // the nouns the project is about: CPOs, tracks, forms
  rules: Claim[];                    // "one CPO payment a month", "Marissa signs, then Walter"
  decisions: Claim[];                // choices made, dated
  currentWork: Claim[];
  nextAction?: Claim;
  blockers: Claim[];                 // what is stuck and on what
  attempts: Claim[];                 // date, what, outcome, lesson
  resumePointer?: Claim;
  contradictions: Contradiction[];   // "doesn't add up"
  unknowns: Unknown[];               // "need to know"
  asked: Asked[];                    // what was asked, when, and what the user said
  lastActivityAt: string;
};

type Claim = { text: string; sources: Source[]; confidence: "high" | "medium" | "low"; at?: string };
type Thing = { name: string; aliases: string[]; ids: string[]; state: Claim; waitingOn?: Claim };
type Contradiction = { text: string; sources: Source[]; questionId?: string };
type Unknown = { text: string; why: string; sources: Source[]; questionId?: string };
type Asked = { questionId: string; askedAt: string; answer?: string; answeredAt?: string };
```

The rule that makes this trustworthy: **a `Claim` with an empty `sources`
array is invalid and is rejected before storage.** A thing the model believes
but cannot point at is not a claim; it is an `Unknown`, and it becomes a
question.

Worked example, the CPO part of the Caltrans record as the data stands today:

| Section | Line | Source |
|---|---|---|
| rules | One CPO payment a month, spaced out | memory, 2026-08-19 |
| rules | The US Bank statement is part of reconciling a CPO | message 2026-09-01, memory |
| rules | Marissa signs a new CPO, then Walter Myala | memory, 2026-08-19 |
| rules | CPO work needs the Caltrans-issued laptop | memory, 2026-08-25 |
| things | Production monitor · 2073 → 0394 · converted, signed; reconcile after statement | task done 2026-09-01 |
| things | Lenses and camera accessories · 2110 · converted 09-01, signed by 09-09; ready to pay | tasks done 09-01, 09-09 |
| things | Antenna · 2079 · waiting on the TASCAM item | task, memory |
| things | Beacon glue and components · no number · Marissa's first priority | message 2026-09-10, task |
| things | Comms · 1992 → 0035 · paid August | tasks done 08-19, memory |
| contradictions | 2073 filed twice; open copy 0/4 steps; "check blocker" after "nothing is blocked" | 3 tasks, 1 message |
| contradictions | 2110 filed twice; open copy 0/4 steps | 2 tasks |
| unknowns | Which CPO is paid next | rule + no decision |
| unknowns | Whether beacon glue has a number yet | task open since 09-10 |

## 3. Inputs (gather)

`lib/understanding/gather.ts` builds one bundle per project:

| Input | Query | Why |
|---|---|---|
| open tasks | `status not in (done, dropped)` for the project, with `notes`, `stages`, `blocked_reason`, `stakes`, `source`, `due_at`, `updated_at` | the current list |
| finished tasks | `status in (done, dropped)`, `completed_at` or `updated_at` in the last 60 days | evidence that open copies are stale |
| memories | tag `project:<id>`, or `fact` mentions any of the project's names, aliases or thing ids | rules and nicknames |
| user messages | `role = user`, last 30 days, content mentions a project name, alias, thing name or thing id | where the meaning is |
| expectations | `status = open` or `missed` for tasks in the project | promised follow-ups |
| events | next 14 days, linked or name-matched | what "tomorrow" holds |
| documents | titles and `updated_at` | resume pointers |
| previous record | `records.body` | continuity; the model edits, it does not start over |
| clock | now in the user's timezone, plus "tomorrow" and "this week" boundaries | so "on the 22nd" resolves |

Mentions are matched by `lib/understanding/terms.ts`, which applies the
normalization `resolveProject` uses (`lib/secretary/tools.ts`: case-blind,
punctuation-blind, whole words) to prose rather than to a spoken name. The
terms are the project's name, every `things[].name`, alias and id from the
previous record, and the numbers and proper nouns in the project's task
titles (numbers from task notes too, because on a first run the notes are
the only place a new number lives), so "0394" finds the CPO 2073 thread once
the record knows they are the same thing.

Bundle size is bounded: 60 tasks, 60 memories, 80 messages, 20 events, 20
documents. Over the bound, the newest win and the run logs the drop. The hash
in `records.inputs_hash` is over the bundle's ids and `updated_at`s, not its
text, so a re-run on unchanged data is a hash compare and nothing else.

## 4. The run

`lib/understanding/run.ts`. One model call per project. Cached prefix:
the persona (`lib/secretary/persona.ts`, same register: professional,
plain, no fluff) and the schema. Then the bundle. Output, one JSON:

```ts
type RunOutput = {
  record: Record;
  questions: QuestionDraft[];
  words: {
    todayLine?: string;          // only for the project that owns the day, see §7
    ledes: Record<string, string>; // widgetId → lede, for widgets bound to this project
  };
};
```

Validation, in order, all mechanical:

1. Every `Source.id` in the output exists in the bundle. Unknown id → the
   whole output is rejected and the run retried once with the error quoted.
   Second failure → keep the previous record, log, move on.
2. Every `Claim.sources` is non-empty.
3. Every `QuestionDraft.answers[].writes[]` uses an op from the closed list in
   §5 and ids from the bundle.
4. Plain-language rules on every `text`, `todayLine`, lede and question:
   no word from the banned list (`slipped`, `stale`, `agenda`, `leverage`,
   `bandwidth`, `circle back`), days as digits, ≤ 3 sentences per lede,
   ≤ 2 sentences for the Today line, ≤ 2 sentences per question `why`, and
   a `why` names at least one evidence item by its title or a quote from it
   (§7). A failure regenerates that field only.
5. A lede may only name titles that are rows of that widget's current
   binding (the same check the third pass proposed). A name is a number of
   three or more digits or a capitalized word; a capitalized word that opens
   a sentence is prose unless written in all caps; month and weekday names,
   today/tomorrow/yesterday, the project name and the widget title are never
   names; a plural and its singular are the same name.

## 5. Questions

`clarifications` gains three kinds and four columns:

```ts
kind: "referent" | "asr_span" | "new_name" | "entity_conflict"   // existing, voice-flow only
    | "need_to_know" | "doesnt_add_up" | "done_yet";               // new, surfaced on Today
projectId: text("project_id").references(() => projects.id),
evidence: jsonb("evidence").$type<Source[]>().notNull().default([]),
answers: jsonb("answers").$type<Answer[]>().notNull().default([]),
rank: integer("rank").notNull().default(0),
surfacedAt: timestamp("surfaced_at", { withTimezone: true }),
```

```ts
type Answer = { id: string; label: string; writes: Write[] };
type Write =
  | { op: "complete_task"; taskId: string }
  | { op: "drop_task"; taskId: string }
  | { op: "set_due"; taskId: string; dueAt: string }
  | { op: "set_recurrence"; taskId: string; recurrence: "daily" | "weekly" | "monthly" | "yearly" }
  | { op: "set_blocked_reason"; taskId: string; reason: string }
  | { op: "set_project"; taskId: string; project: string }  // a project NAME, never a new one
  | { op: "remember_fact"; fact: string; tags: string[] }
  | { op: "clear_expectation"; expectationId: string }
  | { op: "resolve"; }; // this question only; always appended
```

That list is closed. A question cannot propose creating a task, moving money,
sending anything, or touching another user's data. Answering a question with
an answer whose writes name an id not in `evidence` is refused by the API.

`set_project` files a task under a project by its name, for a task that sits
in the wrong project or in none. The bundle carries every non-archived
project name of the user's (`projectNames`, rendered as PROJECTS in the
input); the validator refuses a name that lands on none of them, matched the
way a spoken "file it under Caltrans" is matched (`lib/project-names.ts`:
exact, then punctuation-blind, then contained), and the apply path resolves
the name with the same matcher and creation off, so an answer can never mint
a project. The receipt names the project as it is really called.

What each kind is for, with the detection the prompt asks for and the example
from today's data:

| Kind | Detect when | Today |
|---|---|---|
| `need_to_know` | a stated rule needs a value nothing holds; a name has no meaning; a milestone date passed with no new date; a `blocked` task has no `blocked_reason` | "Which CPO are you paying for next?" · "The album with Jazz was due August 18. Is there a new date?" |
| `doesnt_add_up` | a done copy and an open copy of the same job; `blocked` after the user said it is not; weekly things filed as one-offs; `source = suggested` items past due and never accepted; an open task whose notes say it is done | "CPO 2073 and 2110 are each on your list twice." · "The weekly report and timesheet keep getting filed as one-offs." |
| `done_yet` | an open item where a later message, a finished sibling, a passed milestone, or a missed expectation says it probably happened | "Did Find It go to the App Store? You had it ready on August 31." · "Did Mary's Canva quote come in? You expected it by the 16th." |

Ranking (`lib/understanding/questions.ts`), mechanical, not model-chosen:

1. `need_to_know` whose evidence includes a date within 48 hours (the
   statement tomorrow) — the hero.
2. `doesnt_add_up`, because a wrong list poisons every other sentence.
3. `done_yet`, oldest evidence first.
4. Within a tier, more evidence first.

Today shows one hero and up to six rows. The rest keep their rank and wait.

Dedup and memory of asking: a question's identity is the hash of
`(kind, sorted evidence ids)`. A question with the same identity as a
`resolved` or `dismissed` row is never re-created. `asked[]` on the record
carries the answer text so the next run can reason from it ("you said the
album is October 10" is a decision, sourced to the answer).

The 242 open ASR-kind rows are not surfaced on Today. The first run of the
loop dismisses any ASR-kind row whose `subject` matches a `confirmed`
entity or a name used in three or more later user messages, which is what
"confirmed by use" means. They stay in the voice pause flow only if still
open after that.

## 6. Answering

`POST /api/questions/:id/answer { answerId, note?, source? }`:

1. Load the clarification; refuse unless `status in (open, asked)`.
2. Find the answer; apply its `writes` in order through the existing tool
   implementations (`complete_task`, `update_task`, `remember_fact`, …) so the
   honesty rule, the recurrence spawner and the audit path all apply.
3. Append `resolve`; store `note` as `resolution`. A note on an answer whose
   only write is `resolve` ("Keep them", with a line saying why) is also
   kept as a memory, prefixed with the question and the label so it names
   what it is about, tagged with the project's name (how §3 finds a memory
   for a project) and with `source` (`today`, `interview` or `voice`) when
   the caller gave one. Nothing else reads the resolution column.
4. Run that project immediately (§8). Return the writes that succeeded. The
   client says "Closed" only for those.

Voice: one new tool, `answer_question`, flat schema, bounded strings:

```ts
{ question_id: string, answer_id: string, note?: string }
```

The briefing already injects one open clarification per pause
(`lib/secretary/briefing.ts:558`) and tells the model to call
`resolve_clarification`. It keeps doing that, but reads the new kinds first,
in rank order, and offers `answer_question` with the answer labels spoken as
choices. "The beacon glue one" maps to an answer label; the voice model does
the mapping, the API does the writes. Still one question a session: while
an understanding question is open the ASR clarification queue waits, its row
left open rather than marked asked, and is reached again in a session with
none open.

## 7. Words

`lib/understanding/narrate.ts` is not a second model call. The run in §4
already returns the ledes and, for one project, the Today line. Rules:

- The **Today line** is one or two sentences under the title: what is due
  today (or that nothing is), then what lands tomorrow. It is written by the
  project that owns the nearest dated item; the Today route picks that
  project's line and falls back to a mechanical "Nothing is due today."
- A **lede** is ≤ 3 sentences above a widget's rows: what the rows have in
  common, which is oldest or first, what each is waiting on. It may only name
  titles present in the widget's current rows. It is stored on the record
  keyed by widget id and shipped in the workspace payload as `ledes[widgetId]`
  with the hash it was written from; the client renders a stale lede dimmed
  until the fresh one lands.
- The **question `why`** is ≤ 2 sentences and must reference at least one
  item in `evidence` by its real title or quote.

Plain-language rules (validated in §4 step 4): the real title the first time
a thing is named; nickname and number together for anything with both
("Lenses (2110)"); days as digits; no shorthand the user has not used in
their own titles or messages; no banned words.

## 8. Triggers

There is no dirty table. The design is a **sweep**: every
`UNDERSTANDING_SWEEP_MINUTES` (default 10) the app gathers every `active`
project of every user, hashes each bundle (`records.inputs_hash` is over the
bundle's ids, `updated_at`s and the local date, never its text — §3), and
calls the model only for a project whose hash differs from the stored one.
A project nothing touched costs a handful of indexed reads and a hash
compare, and nothing else. The earlier draft of this section had every write
mark its project dirty in a `record_dirty` table; that table has no writer
and never will, because the hash compare already answers "did anything this
run would read change" and a flag would have to be kept honest at every
write site to say the same thing less reliably.

- **The sweep.** Every `UNDERSTANDING_SWEEP_MINUTES`, `runAll` for each user:
  gather every active project once (the board, the memories and the 30-day
  messages are read once and shared), compare hashes, run the ones that
  changed, then retire ASR clarifications confirmed by use (§5). One sweep
  per user at a time; a second that starts while one is running returns at
  once and does nothing.

  Built: `lib/understanding/sweep.ts` `sweepUnderstanding`, started from the
  boot hook (`instrumentation.ts`) two minutes after the server starts and
  then every `UNDERSTANDING_SWEEP_MINUTES` minutes (default 10, never under
  2, never over a day), with a process-wide latch on top of the per-user
  one. A user with no model available is skipped whole rather than logging
  a `no-model` row per project per sweep; the ASR retire, which needs no
  model, still runs for them. Environment: `UNDERSTANDING_SWEEP_MINUTES`
  (the cadence), `UNDERSTANDING_DISABLED=true` (the sweep, every run and
  the "Understand now" route return at once, nothing is read),
  `UNDERSTANDING_PROVIDER` (`anthropic`,
  `openai`, or `auto`, the default: Claude with OpenAI behind it),
  `UNDERSTANDING_MODEL` and `UNDERSTANDING_EFFORT` (the Claude model and
  effort; defaults `claude-sonnet-5`, `medium`), `UNDERSTANDING_OPENAI_MODEL`
  and `UNDERSTANDING_OPENAI_EFFORT` (the OpenAI model and reasoning effort;
  defaults `gpt-5.5`, `medium`). Settings shows the provider, the model, the
  cadence and the last run per project, and its "Understand now" button runs
  `runAll` for the signed-in user (one per minute).
- **Once a day regardless.** The local calendar date is part of the hash,
  so the first sweep after midnight in the user's timezone re-runs every
  active project even when no row moved, because a day passing changes what
  "today" and "tomorrow" mean.
- **Answering a question** (§6) runs that project immediately, so the next
  screen reflects the answer; it does not wait for the sweep.
- **The interview run** (`mode: "interview"`, `POST /api/interview/more`,
  the Interview tab's "Ask me more"): `runAll` forced past the hash for
  every active project, with one paragraph appended to the rendered bundle
  after the closing line, never to the system prompt, so the cached prefix
  is the same in both modes. The paragraph says the user is sitting down to
  organize their data one question at a time, asks beyond the usual kinds
  (tasks with no project, two tasks that look like one job, a task with no
  date that needs one, suggestions never taken up, anything the model cannot
  place) and allows up to twelve questions for the project. Same
  one-per-minute quota as "Understand now"; while a sweep for the user is
  already running the route answers 409 "Already reading your projects"
  without spending the quota, and the tab polls the queue for that run to
  finish.
- **Never on read.** Today and the Workspace render the last record. They
  never wait for a run.
- **Every run is logged** in `understanding_runs`: which project, when, the
  hash it read, the model, the tokens, and how it ended (`ok`, `failed` with
  the validator's errors, or `skipped` with the reason). The one exception
  is a hash match, which is the sweep's normal state and would drown the
  rows that matter.

Cost on today's data: 8 projects, 45 open tasks, 85 memories, 212 user
messages. A bundle is 5–15k tokens; the daily re-run is 8 calls; a busy day
adds 20–40 change runs. On a fast model with a cached prefix this is cents a
day and under a second a run.

## 9. Surfaces

- **Today** (`app/(app)/today`, new): the Today line, the hero question card
  (kind label, question, why, answers), the question rows (question text,
  kind label, chevron), then past due and coming up as now. Tapping a row
  opens the question with its evidence: quotes labelled "You, Sep 1", tasks
  labelled "Done Sep 1" or "Still open", each with its full title, and one
  sentence per answer saying what it will write.
- **Workspace**: `ledes[widgetId]` in the payload; a `lede` slot at the top
  of each widget body; the CPO widget in the mockup is an ordinary widget
  bound to `tasks where project = Caltrans and search = CPO`, with rows
  templated as `name / number / state`.
- **Voice**: `answer_question`; the briefing reads the ranked queue.
- **Interview** (`app/(app)/interview`, the second tab): the whole open
  queue across projects in rank order, one question at a time as Today's
  hero card, with the evidence behind a disclosure and a note field, then
  "Skip for now". Showing a question is asking it (§5): the server marks the
  question at the front surfaced on every read, and a skip, which reorders
  only the screen and writes nothing about the skipped question, refetches
  with `?front=<id>` naming the question it brought forward so that one is
  marked instead. Answers go through §6 with `source: "interview"`. When
  the queue is empty, "Ask me more" runs the interview mode (§8) and "Done
  for now" goes to Today.

### Nothing is cut off

A rendering rule for the shell, enforced by a test, not a prompt:

- No `text-overflow: ellipsis`, no `-webkit-line-clamp`, no fixed row
  height on any title, lede, question or evidence line.
- A widget grows to its content when the user has not sized it; when they
  have, the body scrolls inside the widget and never clips a line.
- The Playwright suite renders a 140-character title in a 2-column widget at
  the iPhone profile and asserts the full text is visible.

Today, `components/workspace/workspace-board.tsx` inherits row styles that
clip; that is the first change in phase 1 below.

## 10. Safety

- The loop **reads** everything and **writes** only `records`,
  `understanding_runs`, `usage` and `clarifications`. Every other write
  happens only when the user answers, through the existing tools.
- A run can never complete, drop, move or reschedule a task by itself.
  "I'd close all three" is a proposal on a question, not an action.
- Suggested tasks (`source = suggested`) are labelled as the app's own in
  every surface, excluded from "past due" counts of the user's work, and
  become one `doesnt_add_up` question after 14 days, then dropped if the
  answer is "drop" or silence for another 14.
- Output is text and JSON; nothing from the model reaches `innerHTML`. Ledes
  render through `textContent` into a slot, the same as bound fields.
- The honesty rule from the persona applies: "closed" is said only for
  writes that returned success.

## 11. Build order

**Phase 1 — nothing cut off + the record store.** Remove clipping from the
board's row styles; add the Playwright assertion. Add `records`; add the four
columns and three kinds to `clarifications`. Gather and hash, no model call
yet. Judged by: the CI fixture (which seeds "E2E overdue task" and friends)
produces a bundle with the expected ids.
Built 2026-09-22, commit "Understanding phase 1".

**Phase 2 — the run, offline.** `run.ts` with validation and the retry;
`questions.ts` with identity, rank and storage; `records.words` and
`understanding_runs`; `scripts/understand.ts` run against a copy of
production data (the `copy-db.ts` path exists), output to stdout, `--dry`
writing nothing. Judged by: on today's data, the Caltrans run produces the
two duplicate-CPO contradictions, the next-payment unknown and the
Lenses/Antenna/beacon-glue states with correct sources, and zero claims
without sources. This is the gate; nothing ships until this is true.
Built 2026-09-22, commit "Understanding phase 2".

**Phase 3 — questions on Today.** The route, the page, the answer endpoint,
the writes, and the immediate re-run of the answered project. Judged by:
answering "Close all three" on the fixture marks three tasks done and the
question disappears on the next run without being dismissed.
Built 2026-09-22, commit "Understanding phase 3".

**Phase 4 — ledes on the board, the Today line.** Payload field, slot,
stale dimming.
Built 2026-09-22 (the Today line in phase 3; the ledes with phase 6).

**Phase 5 — voice.** `answer_question`, briefing order, the ASR-kind retire
on the sweep.
Built 2026-09-22: `answer_question` on the voice tool list, the OPEN
QUESTIONS block ahead of the clarification queue in the briefing, the
clarification queue narrowed to the four voice-flow kinds, the ASR retire
in `runAll`.

**Phase 6 — the sweep.** `runAll` every `UNDERSTANDING_SWEEP_MINUTES`
(default 10) for every user. Until then, runs are triggered manually from a
settings button and from the script, so cost and quality are watched before
they are automatic.
Built 2026-09-22: `lib/understanding/sweep.ts` from the boot hook, the
Settings section with "Understand now", `GET/POST /api/understanding`.

## 12. Open questions

- Which project owns a memory with no project tag and no alias match? The
  default above is "Personal"; it may be better to let such memories join
  every project's bundle at lower priority.
- The user's morning is assumed 06:00 local. It should be the hour they
  usually first open the app, learned from `messages`.
- Whether `Thing` should be its own table once records exist for a month.
  Not before: the point of the JSON body is to let the shape settle first.
