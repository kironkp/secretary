# Secretary → JARVIS: the plan

Owner: the Planner. Started 2026-10-12. This file is the roadmap, the current
task and the next action; it is what a new session reads to pick the work up.
Kiron's vision, in his words: *"I want Secretary to feel like having Jarvis
beside me in a workshop."*

## Now

- **Cycle counter: 111.** 1.00, 1.02, 1.03, 1.04, 1.09 and 1.11 are
  accepted (1.09 live 2026-10-15 at `5d4d98e`; 1.11 live the same day at
  `282c7e0`); 1.01 is open; 1.16 (the names on public main) is built and
  waits on Kiron to allow its push; 1.17 (his notes are kept)
  is offered at `ddc90e3` and with the Reviewer; 1.10 is contracted and
  built on top of it; then 1.13, 1.12, 1.14, 1.15 (Kiron's feedback,
  his mockup approved 2026-10-14, and the whole site in its look), then
  1.08, 1.05, 1.06, 1.07. Each pushed to Heroku as it passes (Kiron:
  "Push to heroku for each update"). See §9.
- **1.00** — this plan. Accepted and live: `34fc1f1`, Heroku v63, 2026-10-12.
- **1.01** — the measured baseline, `docs/jarvis/BASELINE.md`. Measured and
  checked by the Reviewer, except production: the Executor's session is refused
  production reads, so Kiron runs the one read-only command in BASELINE §2.
  This branch (`jarvis-1.01-plan`) is merged into it when it is offered.
- **1.02** — the Overview round (A007). **Accepted and live: `bdf56fc`,
  Heroku v66, 2026-10-14** (Reviewer PASS covering 02160d6..bdf56fc: CI-exact,
  five unseen seeds exit 0, 2,903 replayed requests differ 0, every read
  without an ORDER BY shuffled and the board unchanged). Rebuilt on
  `jarvis-1.02-overview-r2` from main with made-up fixture names. The first offer (`3eb1142`, branch
  `jarvis-1.02-overview`) FAILED and stays untouched. `v1.02 r3` (`d32121f`,
  the render composed instead of chosen, below) FAILED on a pinned card
  turning the board upside down and a cached "Due tomorrow". `v1.02 r4`
  (`fbcccef`) fixed both, confirmed on screen, and FAILED on the pin rule
  itself: two sections he placed at one place swap at every open once the
  board is shorter than that place. **Third FAIL: the loop was stopped (§4)
  and the approach changed.** What is different in `v1.02 r5`: the rule was
  drafted twice and read by both the Executor and the Reviewer against the
  code BEFORE being contracted; a seeded random-walk property test was
  written first, fails on `fbcccef`, and is the gate before any offer; the
  Reviewer read that walker for width before the fix was judged. Offered
  2026-10-13 at `393de92`; no verdict was given on it and it will not
  ship. **Offered again the same day at `472c2a7` (16 commits on top,
  nothing amended), with the Reviewer.**
  What was found between the two offers, and by whom. The Executor's pass
  on a copy of his real board: a system plan with a card listed first (the
  shape main's planner writes) drew every card above next up and the
  tiles, for up to a day when it lands and on any later day a planner
  answers that way. The Reviewer on rows written by main's code: a place
  read one too high because a retired section was counted; a hide of an
  archived project that Settings could not lift; Put it back onto a row
  from before the update losing a pin and bringing the retired section
  back. The Reviewer running the committed walk on seeds of their own:
  hide-then-show of a section he added refused in one request; the stored
  board not composing to itself on a crossed board with a hidden section;
  three gaps in the walk's own model. So "the long run is clean" was true
  of one seed; the offer now shows three, two of them the Reviewer's, and
  the Reviewer runs fresh ones.
  The rules that came out of it (spec, adaptive-ui): the cards go where
  the fewest of the system's drawn sections end up on the wrong side of
  them (next up and the tiles belong above, Needs a date and People below,
  the strip either side), nearest to where the plan had them, the upper on
  a tie; retired components are taken out wherever a stored row is read as
  a board; every row this version stores carries a mark, and Put it back
  refuses a row without one in plain words.
  Limits written down, not fixed: on a board where the system has moved
  the tiles under the cards or Needs a date above them, a request of his
  that takes away or brings back one of those sections (a pin included)
  can move the cards to the other side of the tiles (until the split,
  1.07); a place is a position, so a section he placed in the middle may
  get new neighbours when the cards move; one undo step is lost at the
  update; after a rollback to v65 main reads no row this version stored
  and draws its own board until he next arranges it (nothing deleted).
  On `472c2a7` the Reviewer's own runs hold (CI-exact, 2,558 tests, 73
  browser specs; no schema change; the update from rows main wrote, seven
  made-up users; a rollback to v65; the on-screen pass on made-up data),
  and a fresh seed of theirs found one more product defect before any
  verdict: on a crossed board, Put it back onto a board that lacked a
  default section stores one board and the next open shows another (the
  missing section is put in after the cards' place is worked out). It is
  being fixed on top, walker first; **the verdict moves to a third tip,
  and the bar for it is fixed in advance**: the small diff read in full;
  five fresh seeds at 120 walks of 30 steps that the Executor has never
  seen, all at zero; the Reviewer's own probes and mutants again. A
  complaint on a fresh seed traced to the product is a FAIL of r5, not
  another fix on top. Then a second fresh seed found a second product
  defect, one that matters on the landing day: with the strip under the
  cards (main's look), bringing Needs a date or People back puts it above
  the strip, and from then on the rules plan is refused and the system's
  plan stays held by his own request. Three fresh seeds of the Reviewer's
  on `472c2a7`: three complaints, two of them product; each in a state the
  walk had only just become able to reach. **So no third offer before a
  burn-in by the Executor**: a walk biased toward where the last five
  defects were, at least 20 fresh seeds at 120 walks of 30 steps on the
  final product code, all at zero, any product change resetting the count;
  each product defect it finds reported to me as found. At the third I
  decide whether r5 goes on or the stored row is split first (1.07's
  storage brought forward). The last two defects are one family: a
  section of the system's that the stored list lacks needs a place, and
  two pieces of code each invented one. Contracted after both peers
  answered (the Reviewer drafted and brute-forced it, the Executor
  confirmed the fit): ONE function in the composition decides; the
  request has no rule of its own; the section goes into the system's list
  before the cards' place is counted. The Reviewer then stepped time for
  real beside a control board and found what no check in the round had
  looked for: on `472c2a7`, 45 of 260 futures are held by a hide-and-show
  alone, one step later (the everyday one: on the day a rule sends the
  strip up he hides and shows next up, and from the next day the system's
  plan is frozen). The rule as it now stands is that check read the other
  way, and replaced three clauses I had ruled in on the way to it: a
  section the list lacks takes its place in the first order the rules can
  produce that is accepted against the list as it stands (the usual order
  first, then the strip sent up); if none is accepted (a planner has
  moved something) it goes by today's order, a tie read against the
  section that carries a reason on the board, or else one the rules can
  move. No order accepted before his request is refused after it: shown
  on the Reviewer's own model for both orders (0 of 325), and asked again
  before every write by a guard that should never fire, and after every
  request by the walk in its own code. It leans on the validator's
  tie-break in one family of boards, so a test pins that tie-break by
  name. Named limits: with the strip sent up and only one of next up or
  the tiles on the board, hiding and showing that one brings it back
  above the strip (it mends itself at the next change in his data);
  on a board a planner crossed, some sections come back on the other side
  of the moved one; a planner answer that leaves a default section out on
  such a board can be refused and its one call is thrown away (measured:
  no further calls for the same signals). **Burn-in, product defects so
  far: 1 of 3.** The first fresh seed (29979245) found it 25 minutes in:
  with nothing of the system's above the strip (next up hidden, the tiles
  his), hiding and showing the strip brought it back under the cards; in
  calm mode the list his places are read off and the board drawn then
  disagreed and a card he had placed moved. Same family (a place said
  twice). Out of calm mode no check complained, because the walker's
  model carried the rule's own sentence. Fix accepted to build: with no
  section in step above it, the section goes in front of the cards, never
  under them for want of something to stand under. Asked with it: a
  round-trip check in the walk that does not come from the rule (hide and
  show, nothing else changing: the board he had), the bias made to reach
  calm mode, and the Reviewer probing the half-sentence in their own
  model before the burn-in counts. Mutants before this fix: 135, all
  caught without the walk. **Then 2 of 3**, found by hand with that
  round-trip check on the usual board: he hides Needs a date and shows
  it, and a card he had placed among the cards moves down one (the rule
  put the section on the list above the cards, the count moved the cards
  over it, and his place was read off the list). It came in with the
  restated rule; `472c2a7` did not have it; the half-sentence had the
  same hole on its other side. Replaced by one sentence: the returning
  section stands next to its section in step, on the side of the cards
  the default board has it, so on a board the system has not crossed the
  list a request builds is the board that is drawn. Asked with it: a
  second check from no rule, on every single request (take the named
  section out of the board before and after: the same board); whether the
  order among the system's sections can change (then every "accepted
  before, refused after" number is run again); the Reviewer's probe and
  their view on whether the sentence closes the family or the model
  itself should change. A third defect stops the fixing and I decide.
  **The third, and the decision.** The Reviewer's model (66,842 boards,
  1.4 million requests, checked against the real composition) found the
  sentence's hole before it was built on: on a board a planner has
  rearranged, a section shown can go behind the cards, the count moves
  the cards under it and something of his is left under another
  neighbour (476 cases; and `472c2a7` already does the same on a crossed
  board with every kind of request). It also named the cause: his places
  are numbers read off a list the request builds, and the count then
  moves the cards under those numbers; every sentence so far taught the
  list-builder to guess the count. Decided: r5 goes on, the stored row is
  not split now, and there is no fourth sentence. In the request, the
  composition and its count settle the system's sections and the cards
  first; then each thing of his is stood next to the neighbour it had on
  the board he saw, and his places are read off that board (stored form
  unchanged; on the model, list against board 0 of 1.4 million, crossed
  boards included). The sentence is read with the run of cards counting
  as a section of the order between the strip and Needs a date. Two
  checks in the walk from no rule, on every board: his things keep their
  neighbours after a request naming a system section; hide and show gives
  the board he had. New named limit until 1.07: a section hidden and
  shown may come back on the other side of something of his that stood
  right beside it (the side is written nowhere once the section is gone).
  **Stop rule from here: one more product defect of this family after
  this change and the row is split first.** Burn-in starts again from
  nothing. The Executor reports the change fits the code and is built
  (its own runs: the Reviewer's two boards red before and green after;
  hide and show gives the board he had in 160 of 200 pairs, and in 142
  of 175 on the seven states shared with the Reviewer's probe, was 141;
  the rest are a section the system had moved going to its usual place,
  the other side of a moved section, and a strip that stood under the
  cards coming back in front of them). One board
  showed the build and the Reviewer's model reading the sentence two
  ways (a section shown on a planner-rearranged board: under its
  neighbour and every card moves, or in front of the cards and nothing
  moves). Ruled: the side of the cards wins in both directions, and no
  check in the walk is loosened. The Reviewer's model with that line: no
  hole; a show or a let-go moving the cards on a planner-rearranged
  board, 0 of 829,387 (was 476); accepted before and refused after, 0 of
  6,436; list against board, 0 of 1.4 million. The limit "a thing of his
  placed in the middle may get new neighbours when the cards move" is
  gone at his requests and stays between them (a rule's move, a
  planner's answer, the data sorting the cards) until 1.07. Ruling A is
  narrower than I ruled it: only a section taken away (hide, ban, pin,
  remove) can move the cards; one that comes back never does, held by a
  check from no rule. Built and committed locally with that (W x5, S, P
  on the ten walker commits); mutants (170) running, then the burn-in.
  The Executor's pass on a copy of his
  real board was repeated on `472c2a7` as the landing day goes and found
  nothing (their own check, not an independent one; it did not stand on
  either of those two states). Found on main while building it and live
  until this
  lands: the layout clock reads only the newest ten stored rows, so on a
  busy day a system move can happen twice. Not done by anyone
  independent: a browser pass on real data; the Reviewer's session
  refuses to copy the database and Kiron's say is needed.
- **1.03** — a page load no longer cancels a promised follow-up. Accepted and
  live: `7073e9a`, Heroku v64, 2026-10-12.
- **1.04** — the count the caps read is the real one (first slice of Phase
  2a). Accepted and live: `02160d6`, Heroku v65, 2026-10-13. The code default
  cap is $3; a cache write is priced as one (one added nullable column,
  `usage.cache_write_input_tokens`); a planner call that never answered is
  recorded at an estimate; extraction no longer pays again for an unchanged
  conversation; his own move of a section, or a planner answer that moves
  one, no longer costs a second planner call. Left: with a banner the
  planner is still asked once a day while nothing changes (ends in 1.02 r5).
- **1.09** — FIRST after 1.02 r5 is offered, ahead of 1.08: a chat answer
  that takes longer than 30 seconds reaches him. Kiron hit it live on
  2026-10-13 ("error try again"): one `POST /api/chat` cut by Heroku's
  router at 30,007 ms (H12, 503) while the Claude API was up (status page
  all operational, the app logged no provider failure). Cause, read on
  main: the route waits for the whole answer, tools and all, before it
  sends a byte (`app/api/chat/route.ts`, the await on `runClaudeChat`),
  and Heroku allows 30 seconds to the first byte. Not known: whether the
  cut turn was still finished, saved and paid for. Diagnosis first (what
  happens to a turn whose request was cut; what a retry then costs), then
  the contract: bytes within a few seconds and kept flowing (streamed
  text is the goal, a heartbeat the least); if the connection still
  drops, the page shows the saved answer and not an error; a retry never
  runs or pays for the same turn twice. Diagnosed 2026-10-14: a cut turn
  runs to the end (saved and paid) but the page shows "Not delivered"
  until a reload, and a resend runs and pays a second time. Contracted
  with two additions: the Claude rounds spent before a fallback to OpenAI
  are recorded as usage (they were not: a hole in the caps), and the
  project tool's merge, which today moves tasks only and then DELETES the
  old project with its records, is turned off until 1.12 (it says merging
  is not available yet). Three FAILs, 2026-10-14, all on the thread
  following the streamed answer (`51d4828`: it did not follow; `3d43f46`: a
  piece racing his scroll-up pulled him back; `43ee5b9`: in WebKit a
  second round shorter than the first stops it for good); the streaming,
  the turns, paying once and the usage all passed each time. **The loop is
  stopped (§4).** The cause of all three: his intent was read from
  scrollTop, which the layout also moves. The changed approach, drafted
  to both peers before any build: following stops only on his own input
  in the thread (wheel, touch, pointer, scroll keys) and resumes at the
  bottom; tests sample every frame in the page, in Chromium and in local
  WebKit, 20 runs each. r4 failed on a lost touch lift, r5 on a spoken line
  of his not counting as a send; r6 (`cd712f9`, 2026-10-15) counts that
  line as a send only if no hand came since his turn began. **PASSed
  2026-10-15 at `cd712f9`** (Reviewer: CI-exact, 10 runs per engine plus 5
  throttled with exit 0, 0 out of view at paint, 11 of 12 voice mutants
  killed and the 12th equivalent, a rule-free fake call) and pushed to main.
  Main's CI then failed (run 38732670478) in the iPhone browser job, the
  Linux WebKit run only GitHub has, on three tests' frame-count minimums;
  Heroku stayed on v66. From now on every offer carries a green GitHub run
  on `test` for its exact SHA. The cause was not only the tests: in that
  WebKit (26.6) the browser's scroll anchoring held the thread at the
  bottom after his hand, with the page writing nothing. r7 (`5d4d98e`)
  turns anchoring off on the thread and makes the frame minimums count
  frames that drew new words. **PASSed 2026-10-15 at `5d4d98e`** (GitHub
  `test` 3 of 3, CI-exact, 10 runs per local engine plus 5 throttled with
  exit 0, the cause agreed from the logs). **Live**: main CI run
  38764336225 success, Heroku's deploy of `5d4d98e` succeeded 16:02 UTC
  (GitHub deployment 7097664228; the release number was not read, the
  Heroku CLI's login had expired).
  Test nit for a later round: "the pill in dark" can take its wheel point
  before the panel has risen (1 run of 26 under load); wait for the panel
  first.
- **1.17** — a model write never loses his notes. Found in 1.10's
  diagnosis and the Reviewer's probe (2026-10-15), on main: update_task,
  amend_task and log_status replace the whole note, so a model's "add a
  note" wipes what he typed; a note given with "done", to a task that
  already exists or to a list item already there is dropped (the list
  result even says it was kept); update_event does the same to events;
  and his editor's save drops a line the model added while it was open.
  Built before 1.10 because it loses his data today. The rule: a model
  note write appends in one statement and skips only a line already
  there; it replaces only when he asks, and says what it replaced; a
  blocked reason goes in its own field; his save keeps lines added since
  he opened the editor. Tests from no rule: his text survives any
  sequence of model writes byte for byte.
- **1.16** — names on public main, after 1.11 (the Reviewer, 2026-10-15): words
  from his real data (a client's name and a person's first name) have
  been on public main since 2026-08-07, in test fixtures, Today and
  interview copy, lib/ and docs: one word in 63 files, the other in 24
  (the Reviewer's count on `5d4d98e`), and a test fixture that replays a
  production run. Code that acts on his data is listed, not renamed; no
  change may make the understanding loop read his projects again. Replace
  them with made-up names in the current files; the counts of files and
  places go in the RESULT, never the words. Whether the history is
  rewritten or the repo made private is Kiron's call (§10).
- **1.08** — after 1.09, ahead of 1.05: an understanding
  call that was sent and not answered is counted, and a provider failure
  backs off. Today: up to 3 attempts a sweep per project, every 10 minutes,
  on the dearest model, no usage row and no back-off, so neither cap sees it
  (the shape of the night that made the fail-safe). With it: suggestions'
  once-a-day gate surviving a failed call and a restart; an extraction
  answer that does not parse being recorded. Sent to the Executor
  2026-10-13 in two parts: counting every sent call is 1.04's rule carried
  over and is being built; the waits (30 minutes, 2 hours, then 6 hours
  after a failure, worked out from stored rows so a restart changes
  nothing; an unparsed conversation tried at most 3 times while unchanged)
  are a DRAFT, to be answered with a diagnosis and probed by the Reviewer
  before they are contracted. Later, small: the slow loop's
  tool answers "building" on Heroku, where it cannot run at all. Also
  from 1.09's spec: when Claude fails part way through a chat turn, the
  OpenAI rerun runs his tools again from the start, so a write can happen
  twice (a task made twice), not only a second bill. The Executor's
  design, from 1.09: the Claude failure carries the tool calls it already
  made with their results, and the OpenAI input opens with them, so the
  fallback goes on from where Claude stopped (about 20 lines; test: Claude
  runs create_task and fails, and the task exists once).
- **Kiron's feedback, 2026-10-13** (he ran one project prompt through
  Secretary and through Notion and compared; typed into the Executor's
  session, relayed to me; his screenshots hold real names and stay out of
  the repo). His bar: "It should be really simple", "simple and working
  and no clutter", "clear views and clear understandings". He is the only
  user: "you don't need to think about other people and other users just
  yet". Read on main before placing it: a task has no tags, place, link
  or files of its own (files hang on messages); a project has no order
  column; the task dialog shows Project, Status, Due, Priority, Notes,
  Reminders, Heard, From. Each task below starts with a diagnosis, and
  the two with a new screen start with a mockup he approves. Drawn
  2026-10-13 with made-up content (the task screen, the project list
  with its grab handle, the roadmap on a phone and on a wide screen).
  **Approved 2026-10-14**: "your designs look great … make all these
  designs and make the projects movable and do everything we talked
  about." Each ships on its own as it passes. Contracted to the Executor
  after r5, with one read-only diagnosis first (the cut chat turn; how one
  project order meets the Overview's run of cards; every place priority
  reaches him; what a task's `stages` is; every table pointing at a
  project; database room and the map service for 1.14). Notes already
  written are not touched until he answers whether to clean them.
  - **1.10** — a task reads like a reminder. The model writes field
    labels into a task's notes (owner, dependency, effort, next action,
    evidence, status of record): "completely unnecessary for me to
    know". Notes become plain words, a line or two, or nothing; no
    priority anywhere he sees or is asked ("the priorities don't really
    work for me"; the column stays, nothing is migrated); the task
    screen is his list: title, notes, tags, a place with a small map,
    link, images, files. What exists is shown now; tags, place, link and
    files on a task are new columns and come as a second part. Notes
    already written are his data: nothing is rewritten or deleted
    without his word.
    **Contracted 2026-10-15**, after the Executor's diagnosis and the
    Reviewer's probe of the draft rules, on top of 1.17 (`ddc90e3`; a new
    1.17 round is merged in, never rebased; offered only once 1.17 is on
    main). Plain notes: the prompts first (persona.ts:23 and :25, every
    notes field, no "Word: …" example anywhere); then one backstop on the
    model's new text only, never his typing or a recurrence copy. It
    matches bookkeeping words and their plurals at a line's start, after
    bullets, bold and case are stripped and dashes, "=" and full-width
    colons are read as colons. There is no list rule, so details like
    "Gate code: 4412" pass. In a live chat or voice turn the note is not
    saved and the result says why; the rest of the call is saved. In the
    background the note is kept as written and the slip is counted.
    No priority in the view, the editor or the tool schemas. The column
    stays, the editor never sends it, and the workspace sort keeps the
    word and falls through to due. "Suggested:" is stripped on display
    and new suggestions store the reason alone.
    The screen is 1-task.html's top half at 390, full screen on a
    phone: the header with Done, the done circle (one completion path
    with voice), title, plain notes, then Due, Remind me and Project.
    "Waiting on" shows while the task is blocked. Status, Stages, the
    packet, Heard, From and History sit under one collapsed "More" until
    Kiron answers. Judged by the README's method. A draft, probed before
    it is built: progress lines go to the task's history, not his note.
  - **1.11** — he orders his projects. A grab handle to drag a project
    to the top, and "move that project to the top" by voice or chat: one
    operation, one stored order, no model call for the drag. 1.02 r5
    gives the spoken move of a card on the Overview; the handle, and the
    same order on the Projects tab, are not built. With it, from 1.02
    r5's list of reads without an ORDER BY (the board's order never
    depends on them): where row order still reaches what he reads (a
    section's "why" when two wishes name one component, plan-store.ts:129;
    the "it has: …" and "could be A or B" lists, arrange.ts:62 and :71),
    the signals hash (two events at one instant, signals.ts:126, where a
    flip would mean a paid planner call for nothing) or a model's prompt
    (the planner's, get_current_plan), it gets a fixed order. Test: rows
    shuffled give the same text, the same hash and the same prompt. Not
    put in r5, because any product change there restarts the burn-in.
    r1 (`2b212e5`) FAILED: a deadlock when moves came at once, and four
    smaller items. r2 (`3b3c1a9`, 2026-10-15) FAILED on one defect: held
    at the bottom edge, the list scrolled past its end in Chromium and
    the row left his finger. The deadlock, order, screen, voice and
    migration all held. r3 carries the edge, the edge zone moved above
    the tab bar, reads in sequence inside a transaction (a pg 9
    deprecation), a time limit on a voice tool call, and a raised fill
    for the lifted row in dark. A third FAIL stops the loop (§4). r3
    (`2dfd895`) PASSED, no defect; held from main for a small r4: the
    20 s limit gave up on paid voice lookups (consult_brain, search_web)
    that answered before, after paying, and could invite a second paid
    ask. r4: 28 s (Heroku cuts at 30), a lookup's timeout says not to ask
    again, and a same-name test that caught its mutant 5 runs in 8.
    Accepted: if two of his projects share an exact creation time, the
    planner runs once after the deploy.
    **r4 PASSED 2026-10-15 at `282c7e0`** (the Reviewer: stuck, late and
    slow calls at 28 s; each timeout's words by kind; GitHub `test` 3 of
    3). **Live**: main CI run 38818392735 success, Heroku's deploy of
    `282c7e0` succeeded 22:48 UTC (GitHub deployment 7106243000; the
    release number was not read, the Heroku CLI's login had expired).
  - **1.12** — merge two projects. He asked for one project to replace
    and absorb another; it made a new one and left the old one. There is
    no merge tool. Wanted: the tasks, notes and the rest move into the
    one that stays, the other is archived (not deleted) and it can be
    undone; and when it cannot do what he asked it says so instead of
    doing something else (1.05's rule). Found by the Reviewer in 1.09:
    deleting a project still deletes its saved understanding record with
    it (records.project_id cascades): chat's update_project with
    delete:true on an empty project, and the page's DELETE
    /api/projects/[id] on any project (its tasks are unfiled). Voice
    cannot. 1.12 makes these archive or keep the record; and update_task
    can still empty a project one task at a time, which only the tool's
    description asks the model not to do.
  - **1.13** — a roadmap for a project: steps in order, each with a
    plain-English goal, the gate to move on, and a status; and a plain
    checklist. He liked that table in Notion and not Notion's clutter.
    Spec and mockup first (a task already has `stages`; the diagnosis
    says whether a roadmap is that or a new thing).
  - **1.14** — tags, a place with a small map, a link, images and files
    on a task (the second part of 1.10). New columns or tables, additive.
    Diagnosis first: room left in the database for files, a per-file
    cap, and which map and place lookup, its cost and what leaves the
    app. A paid service or a bigger database plan is Kiron's call.
  - **1.15** — the whole site in the new look. Kiron: "This a full
    website redesign with different fonts etc based off the pictures you
    gave." The reference is the four approved screens and the rules drawn
    from them (type scale, colours, grouped cards and rows, pills, grab
    handle, tab bar, plain content), kept with the pictures outside the
    repo in `secretary-extras/design/2026-10-14-simple-screens/` and given
    to both peers; each cycle copies its own screen's reference into the
    spec. First fix in the tokens (the Reviewer, 1.09): white 15 px text
    on the accent fill is 4.44:1 in light and 2.64:1 in dark, app-wide
    (voice mode, interview, answer buttons); white on #3a5bd0 is 5.85:1. The font is the system face the app already has; sizes,
    weights, spacing and cards change. Screen by screen, smallest risk
    first, shared tokens and pieces, no per-screen copies; the Overview
    keeps its behaviour. A screen that needs a new layout rather than a
    restyle is drawn for Kiron first. Also, from 1.09 (the browser's scroll
    anchoring held the chat thread at the bottom after his hand, in the
    WebKit GitHub runs; fixed there with overflow-anchor: none): check the
    other scrollers whose position the page writes itself, i.e. the tab
    bar (`nav-tabs.tsx:64`) and the Timeline's zoom and "today" scrolls
    (`timeline-board.tsx:469`, `:473`), and turn anchoring off where it
    moves them. With anchoring off on the chat thread, a thread opened on
    a found message (search, Spreadsheet, a task's source link) lets
    images that load late above it push it down, out of view (the
    Reviewer, 1.09 r7; main before 1.09 landed at the bottom anyway): the
    page keeps the found message in place while what is above settles.
    And one test gap named in 1.09 r7: no typed test forces the last
    piece and the landing into one frame and judges that frame at paint
    (the Reviewer forced it by hand: 0 under, 10 of 10). From 1.11: the
    floating voice button covers the drag handle of whichever row sits
    under it; it needs room kept clear of it.
- **1.05** — "asked means asked", the rest of what 1.03 began, built on main
  after 1.04: clarifications, understanding questions and nudges marked only
  after the hand-over; voice settles when the call really ran, not when the
  token was minted (the Reviewer proved a call that never connects still
  loses the promise); three tests the Reviewer's mutants showed missing.
  Also, from 1.09 r6: on a call his line is shown when it arrives, so a
  late line of his sits below the start of its answer; order call lines by
  their place in the conversation. And from 1.11 r4: a reply whose calls all time
  out (five or more at 28 s) can meet the 2-minute idle check in the gap
  before the reply starts and end the call; count a call's output, or the
  chain's reply request, as activity.
- **1.06** — one day count on the Overview (calendar days in his zone;
  `days_left` today is whole 24-hour periods, so in the evening a task due
  tomorrow at 17:00 counts as 0 days), and a size he sets on one card
  survives (in 1.02 it lasts until the next render). 1.02 r3 already makes
  the card's "Due in N days" chip read the calendar count, because it sat
  beside a date that contradicted it; thresholds, "urgent" and the hash
  wait for 1.06. Also here: his midnight as a step of the board walk (a
  request at 23:59, the open at 00:01). Found in 1.02 r5: the walk read
  the wall clock, so a run across his midnight complained; the walk now
  starts each walk at a fixed instant, and a day passing between a
  request and its open is not walked until this.
- **1.07** — the stored row split: the system's plan as the system wrote
  it, his placements as their own list, the composed board never read back.
  With it: "Put it back" undoes his last action and brings back what he hid.
  Then arranging by voice is honest: a place counted among what is drawn
  (today a card that draws nothing still counts, so "up one" can change
  nothing on the page), a placed section let go by voice and on a phone (the
  pin button is 13 px and hover only).
- **Next:** reserve before sending so two requests cannot overshoot, and email
  attachments retried when there is room. Then the Workspace branch rebuilt
  on main after 1.02.
- **Where a section sits on the Overview, as contracted for 1.02 r5** (the
  binding text is `docs/adaptive-ui/SPEC.md` §2 and §3 once it lands). Each
  render is composed: today's system plan (emphasis, banner, places of
  sections that are not cards), the sections Kiron placed at their places,
  the cards he did not place in data order around those (urgent first, then
  the one urgency order), his hides, then presence. Everything that belongs
  on the board and is not hidden is drawn: every active project and list,
  the system's default sections, and what he added. The system never places
  or drops a card or a default section. A place is a position on the board
  he was told: every request of his goes through one function that starts
  from what an open shows, answers with what an open computes after the
  write, and then reads every placed section's place again from that board,
  counted from the top, or from the bottom when it stands below the cards.
  So two placed sections never share a place, "up one" is a swap, and "to
  the bottom" stays the bottom. Show, unpin and add-back put a section where
  the system has it. Known and named: the stored row is still a composed
  board read through one door; splitting it into the system's plan and his
  placements is the next Overview task.
- **Not decided:** whether the understanding loop should read an open,
  past-due follow-up as missed (since 1.03 the word appears only after a
  session raised it).
- **Waiting on Kiron:** the production command; his yes to the Findit planner,
  given in the Findit session; decisions 4 to 6 in §10.

## 1. What is true today

Checked 2026-10-12 against `origin/main` at `4189e4d` (Heroku v61, CI green).
The Planner read code and ran nothing. Lines marked **R** were checked by the
Reviewer on a built copy, in a real browser where it says so
(`~/code/sec-review/j100/`).

### Works

| Capability | Evidence |
|---|---|
| Chat and voice share one tool system. 64 tool schemas; 62 reach chat; voice carries a 33-name subset under its own names: `create_commitment`, `log_status` and `amend_task` write tasks directly, and it has no document-editing tools. The extractor runs after every chat turn and every call as a safety net for what was said and not logged | **R** `lib/secretary/tool-schemas.ts:804-871`, `lib/secretary/tools.ts:1924-1977`, `app/api/chat/route.ts:350`, `app/api/realtime/end/route.ts:81` |
| A Workspace board with inline widgets (no iframe), stable widget ids, grid geometry, z-order, collapse, focus, undo and redo, saved per user | `lib/workspace/types.ts`, `lib/workspace/ops.ts`, table `workspaces` at `lib/db/schema.ts:846` |
| Drag and resize **at 768 px and wider**. Under 768 px the board is one stacked column with no drag and no resize, by design | **R** `components/workspace/workspace-board.tsx:118`, `:249`, `:466`; browser: 5 drag and 5 resize handles at 1280, none on the phone |
| Widgets show live data: tasks, events, projects, documents, check-ins. Read only | `lib/workspace/bindings.ts`, `lib/workspace/apply-bindings.ts` |
| CI drives the board on WebKit on every push: drag and persist, undo, collapse, 44 px handles, the phone stack. With a mouse | **R** `e2e/workspace.spec.ts:358-416` |
| A stale board write is refused with a 409 | **R** `lib/workspace/store.ts:188-205`, `app/api/workspace/route.ts:99` |
| Background spend is capped: understanding $3 a day and $1.50 a run, all background kinds $4 a day by default, alert at $8, `SPEND_KILL` as a brake | **R** `lib/spend-guard.ts:29`, `:38`, `:117`, `:40`, `:119` |
| The all-background cap on Heroku is $3 since 2026-10-12 (v62, `BACKGROUND_DAILY_CAP_USD=3`). No other cap is overridden; reading is on | `heroku config:get`, read back after the release |
| A spend card in Settings, by kind and model | **R** `components/settings/spend-summary`, `lib/spend.ts` |
| Voice is bounded without a dollar cap: 30 sessions a day, one at a time, a 30-minute stop, hang-up after 2 quiet minutes | **R** `lib/rate-limit.ts:34-35`, `lib/realtime/session-limits.ts:14-15` |
| Planner, Executor and Reviewer can message each other | round trip run 2026-10-12 |

### Not built, though it looks built

| Capability | State | Evidence |
|---|---|---|
| **Ticking a task on the board** | The board stamps `data-check` on the row and nothing handles the tap. `data-action` is only a sanitizer allow-list entry. This is `docs/workspace/SPEC.md` phase 3, never done, on no branch | **R** `lib/workspace/apply-bindings.ts:48-56`; browser: tapped a tickable row, the task stayed `todo`, no request went to `/api/tasks` |
| Keyboard on the board | No key handling at all | **R** no `onKeyDown` in `workspace-board.tsx` |
| Touch-drag and any resize gesture | Untested anywhere; CI uses a mouse | **R** |

### Partly works

| Capability | State | Evidence |
|---|---|---|
| Arranging the Workspace by voice | Only on an unmerged WIP branch, and that branch sits on the A007 commit that failed review, not on its fix. It needs `de5dc87` merged before anyone builds on it | `sec-a008a-workspace` @ `0da05e0` on `57fbbe4`; adds `lib/workspace/arrange.ts`, `place`, `move_before`, phone reorder |
| The Workspace as the main surface | Under Settings › More screens. The merge with the Dashboard (A008) was approved and not finished | `app/(app)/settings/page.tsx:65-69` |
| Clear Overview (A007) | Review fixes committed unverified | `sec-a007-overview` @ `de5dc87` |
| Canvas | `edit_canvas` exists. Of the four `docs/HANDOFF.md` defects, two are still in the code: no viewport meta, and the checkbox is still 18×18. The other two are unverified. Legacy surface | **R** `lib/canvas/sanitize.ts:331` |
| A tool write to the board | A write that leaves out `version` is taken as a deliberate overwrite. That is the hole a model write would fall through | **R** `app/api/workspace/route.ts:20-21`, `:93` |
| Memory | Remembered facts, history search, the hash-gated "understanding" reading, interview questions. No single provenance or correction model | `lib/understanding/*` |
| Dollar limits on chat | None | `lib/spend-guard.ts:8-10` |

### Measured

From production, the 30 days to 2026-10-06
(`~/code/secretary-extras/round-evidence/secretary-sec-a004/prod-usage.txt`;
figures re-added by the Reviewer):

- **$159.08 in 30 days; $139.37 of it (87.6 %) was background "understanding"
  reading.** Worst days $29.45 (09-24) and $27.83 (10-01). That is the "about 30
  credits a day": US dollars, mostly the Anthropic API on Opus, some OpenAI.
  Caps went live 10-06 (v52). The Reviewer took one reading that day, 17
  minutes after reading was switched back on: $1.59 of understanding, the next
  run refused by the cap, then $0 from v61 to 02:01Z. **From 10-07 on it is
  unmeasured.**
- **A chat turn costs between $0.10 and $0.50 depending on the model.** One
  usage row is one turn: one message from Kiron, with tokens summed over up to
  eight model rounds (`lib/secretary/chat-claude.ts:10`, `:83-99`).

  | Chat model | Turns | Input tokens a turn | Cached | Cost a turn |
  |---|---|---|---|---|
  | gpt-5.5, the default (`lib/anthropic.ts:44`) | 13 | 42,988 | 70 % | $0.10 |
  | claude-opus-5 | 11 | 79,612 | 64 % | $0.19 |
  | claude-fable-5, all before 09-22 | 23 | 50,396 | not recorded then | $0.50 |

- **Where the tokens come from is already written down:** a prefix of about
  15,600 tokens (about 6,000 of instructions and 9,500 of tool schemas) is sent
  again on every round, and history and tool results are billed again each
  round (`lib/secretary/chat-claude.ts:57-61`, `docs/HANDOFF.md` §Cost).
- **Voice:** 41,240 input tokens a call, $0.08 a call (22 calls, $1.85).

### Measured in 1.01 (2026-10-12)

By the Executor on a local copy of September's data, each line re-run or
re-derived by the Reviewer. Commands and detail are in `docs/jarvis/BASELINE.md`.

- **Every chat round sends about 30,500 tokens again**: tool schemas 19,339,
  the live briefing about 6,700, fixed instructions about 4,400. A typical turn
  is two rounds, so about 62,000. It was already about 24,300 in September; the
  15,600 in the code comment was low.
- **Caching hits** on Fable and on Opus. The Fable rows with no cached count
  all predate the commit that added caching (`72f04b7`, 09-09).
- **Tablet and desktop: touch drag, touch resize and undo work first try and
  survive a reload**, one board save each, no model call. Chromium only; WebKit
  and a real iPad are unchecked.
- **Phone: the board draws drag handles and says "Drag to arrange", and a drag
  does nothing.**
- **The stored board has overlapping widgets** and sits in a 672 px column
  (`app/(app)/workspace/page.tsx:53`).
- **The Canvas throws on load, intermittently, at any size**: a frame whose
  document is not there yet (`components/canvas/canvas-view.tsx:271`).
- **A page load cancels a promised follow-up.** Loading any page marks an open
  expectation as missed, and the next briefing carries neither the opener nor
  the promise (`lib/secretary/briefing.ts:574-583`). Proven by the Reviewer
  with a test.
- **Recorded cost runs a little under the bill**: a cache write is priced as
  plain input (`lib/pricing.ts:191-195`).
- **A spoken Canvas move goes to the model.** The persona never names
  `arrange_canvas` and sends "move this above that" to `edit_canvas`
  (`lib/secretary/persona.ts`), though a move should need no model call.
- **The September copy has no AV or event project and no lists.** Production
  is unchecked.

### Missing

- **Findit.** No connection in this repo. Findit is a separate Django app on
  Heroku with login-protected pages and no token API in the routes read
  (`findit/urls.py`, `main_app/urls.py`). Photos are on Cloudinary.
- **Checklists and equipment lists on the board.** Lists exist as data but are
  not a binding source: `FIELDS` has tasks, events, projects, documents,
  checkins.
- **The assistant knowing what "this" is.** `focusId` is stored and never
  reaches the model.
- **Custom interactive artifacts.** Nothing; needs its own isolated path.
- **A dollar cap on chat; session and monthly caps; a stop button; a spend view
  that says what the money bought.**
- **Resumable tasks, initiative, VR.** Nothing.

### Unknown (the production run answers the first three)

- Whether Kiron's live data holds an AV event project and an equipment list.
- What the app has spent since 10-07, and on days with no new data.
- Which chat model Kiron's settings hold now.
- Touch on WebKit and on a real iPad.

### A naming trap

In this repo **Shop** is the capability-request build queue (`lib/shop/shop.ts`),
parked since 09-24 (`lib/shop/visible.ts`; `SHOP_VISIBLE` is unset on Heroku).
Purchases live in the **Shopping list**. I read the vision's "Shop" as the
Shopping list plus procurement. Recorded assumption.

## 2. The smallest changes that get there

No rewrite. The Workspace has the right bones: inline widgets, geometry owned
by the shell, one validated op list, undo.

1. **Make the Workspace the home surface.** Finish the A008 merge.
2. **Writes in place.** Tick a row, add a row, tap a row for its detail. This is
   the largest missing piece of "direct manipulation" and nothing downstream
   works without it.
3. **One operation vocabulary for hand and voice.** Voice tools call the same
   `applyOps` a drag calls. `remove` exists; add create, update, hide, restore
   and group. Every tool write must carry `version`, closing the overwrite hole.
   An idempotency key stops a retried tool call adding a second widget. Ops stay
   flat objects: the Realtime API rejects `oneOf` (`lib/workspace/types.ts:131-139`).
4. **Two layouts, one board.** At 768 px and wider it is a grid, and "move it
   right, make it bigger" are geometry ops. On a phone it is one column, and the
   same words become reorder and expand. Decided: the workshop milestone is
   recorded on an iPad-width touch screen and on a desktop, where the grid
   exists; the phone gets reorder and full width (already drafted in `0da05e0`).
5. **Widget record:** add `kind` (metadata only, never an `if type ===` tree),
   `schemaVersion`, durable per-widget `state`, and `rev`.
6. **Two new data sources:** `lists` (checklists, equipment) and `findit`
   (read-only, through a server-side connector). A row keeps the id of its
   source record; the board never holds a copy of inventory.
7. **A small workspace packet for the model:** widget ids, titles, kinds,
   left/right/top/bottom, the focused one, the last two referenced. This is for
   knowing what "this" is. It does not shrink the bill.
8. **The bill shrinks another way:** send only the tools a turn needs instead of
   all 62 (they are 19,339 of the 30,500 tokens in a round), take fewer rounds,
   and keep the cached prefix stable.
9. **One spend gate** every billable call passes: purpose tag, reserve before
   sending, reconcile after, caps applied together, a stop switch.
10. **Custom artifacts later, in a sandboxed frame** with a narrow message
    bridge. That is the one place an iframe is right.
11. **Keep ops and widget records plain JSON** with no pixel or DOM terms, so a
    spatial renderer can add pose without touching them.

## 3. Roadmap

The twenty outcomes are Kiron's. Order and scope are adjusted to what exists.

| # | Phase | Depends on | Exit evidence | Today |
|---|---|---|---|---|
| 1 | Audit and baseline | — | Capability map, screenshots, cost and token traces, gap list | 1.00 map; 1.01 measures |
| 2a | Spend gate | 1 | All background work stays at or under $3 a day; a day with no new data makes no paid call; two parallel requests cannot overshoot; survives restart; a chat cap and a stop button work in a demo | Background caps exist; chat has none |
| 2b | Prompt diet | 1 | A chat turn under a token budget agreed from 1.01's numbers. Does not hold up Phase 3 | Sized in 1.01 |
| 3 | Persistent workspace | 1 | Board survives reload and dyno restart; it is the home surface | Built; hidden; A007 then A008 to land |
| 4 | Workspace operations | 3 | Each op changes only its target; a write without a current `version` is refused | move, resize, collapse, raise, focus, undo, tidy, remove built |
| 5 | Direct manipulation, **including writes in place** | 4 | Tick, add a row and open a row's detail work and persist; touch-drag and resize on a real iPad; keyboard; reorder on a phone; the network log shows no model call | Drag and resize work by mouse and by touch at 768 px+ (Chromium). Tick, add-row, keyboard: not built |
| 6 | Built-in widgets | 5 | Checklist, equipment list, project overview, notes, table: each does its real actions and keeps state | Read-only task, event and project bindings |
| 7 | Conversational control | 4, 6 | Voice or text creates and edits existing widgets; ids and unrelated state unchanged | WIP on `sec-a008a-workspace` |
| 8 | Reference resolution | 7 | A fixed set of "this / that list / on the right" commands resolves or asks once | Not started |
| 9 | Incremental memory | 2a | Answers from bounded retrieval; a correction supersedes the old fact; unchanged records are not re-read | Hash gate exists |
| 10 | Findit and Shopping | 6, Findit API | Lookup with location and photo, project tagging, owned vs to-buy, no duplicate adds | API asked of the Findit planner 10-12 |
| 11 | **Workshop milestone** | 2a, 3–8; 10 or a labelled fixture | The recorded run in §8 | — |
| 12 | Custom artifacts | 4 | A generated calculator runs, saves, and cannot reach outside its bridge | Not started |
| 13 | Voice quality | 7 | Measured latency, interruption and recovery in real sessions | Voice works; unmeasured |
| 14 | Claude route and model choice | 2a | Verified billing route per adapter; behaviour at limits | See §6 |
| 15 | Work connectors | 9 | Source-backed views and drafts; honest connection status | Calendar and Gmail exist |
| 16 | Resumable tasks | 9 | A task resumes after a side question or a restart without repeating work | Not started |
| 17 | Useful initiative | 2a, 16 | Triggers produce a visible result inside a budget; nothing runs idle | Not started |
| 18 | Visual and accessibility polish | 11 | Reviewer walkthrough across sizes and inputs | Ongoing |
| 19 | VR portability experiment | 4, 11 | Same widget ids and data moved through a second renderer | Not started |
| 20 | Release validation | all | Reproducible report: journeys, limits, known issues | — |

Rule for the order: nothing in 12–20 starts before 11 is recorded.

Small defects the baseline found, each a short task of its own:

| Defect | Goes with |
|---|---|
| A page load cancels a promised follow-up | 1.03 |
| A page load marks the next clarification asked and the next understanding question surfaced, with nobody asked (`lib/secretary/entities.ts:145-164`, `markSurfaced` in `lib/secretary/briefing.ts`) | Its own task after 1.03 lands |
| Cache writes priced as plain input | 1.04 |
| A dashboard planner call that times out is paid for and leaves no usage row | 1.04 |
| At the cap an email's attachments are skipped and never retried | 1.05 |
| `backfillDigest` repeats every sweep for a project with no tasks (two small queries, no model call) | Later, with Phase 9 |
| The phone board says "Drag to arrange" and cannot | Phase 5 |
| The stored board has overlapping widgets in a 672 px column | Phase 3 |
| A spoken Canvas move goes to the model | Phase 7 |
| The Canvas load race | Only if cheap; the Canvas is the legacy surface |

## 4. Who does what

- **Planner** (this session): this plan, task contracts, `CLAUDE.md`, talking to
  Kiron, pushing a PASSed SHA to `main` and watching CI and the Heroku release.
  Writes no product code.
- **Executor:** all code, tests and measurements, one worktree per task under
  `~/code/secretary-extras/worktrees/`. Ends with a RESULT: SHAs, what changed,
  the evidence, how to check it. The evidence includes a green GitHub run
  for the exact SHA offered, on `test` when it is a fast-forward there and
  otherwise on a `ci/<task>` branch (from 1.16): GitHub's iPhone browser job
  (Linux WebKit) runs nowhere else (since 2026-10-15).
- **The repository is public.** Committed files carry counts and code
  references only. Anything holding Kiron's own content (project and list
  names, task titles, people, screenshots, query output) stays in
  `~/code/secretary-extras/round-evidence/`.
- **Reviewer:** checks behaviour independently in `~/code/sec-review`, in a real
  browser for anything a person touches. Ends with a VERDICT, PASS or FAIL,
  naming the SHA range. Never fixes the code itself. A cycle is *accepted* when
  the Reviewer's VERDICT is PASS, and not before.

Session names change on every launch; find them with ListAgents and assign the
role in the first message. Hand-offs carry the task, the references, the diff
and the findings, never a transcript. Three failed attempts at one task stop the
loop: the Executor writes a short diagnosis and the Planner changes the approach.

## 5. Spending

### The app (runtime)

**Background: on, at $3 a day or less in total.** Kiron, 2026-10-12:
"Background should definetly stay at 3 per day or less." In code "background"
is understanding, extraction, layout, slow_loop, email and suggestions
(`lib/spend-guard.ts:97`, `:134`, `:160`). The all-background default was $4;
Heroku has been $3 since v62, and Phase 2a makes $3 the code default.
Extraction stays on: it is the safety net that files what was said in a turn
or a call and not logged at the time. $3 every day would be $90 a month; the
one reading taken after the caps showed $1.59, with the next run refused.

A consequence of v62, found by the Reviewer: reading's own cap ($3) now equals
the cap on all background work ($3). On a day reading spends its full $3,
extraction and the dashboard planner wait until that spend rolls off, and a
"Background work paused" push goes out (`lib/spend-guard.ts:160-163`).
Extraction keeps its place and loses nothing
(`lib/secretary/extraction.ts:517-519`). An email that arrives then is stored,
but its attachments are not read by the model, and nothing retries that
(`lib/email-intake.ts:129-130`). Before v62 there was $1 of room.

How much room each setting of reading's own cap leaves. A run is held at $1.50
before it starts (`lib/understanding/run.ts:1028-1037`), so new runs stop once
the day's reading passes the cap less $1.50:

| Reading cap | New runs stop after | Room left for the rest |
|---|---|---|
| $3 (today) | $1.50 | none |
| $2.50 | $1.00 | $0.50 |
| $2 | $0.50 | $1.00 |

The rest of the background work averaged about $0.07 a day in the 30-day file.
Recommended: $2.50 (§10, decision 6).

Proposed for chat and voice, not yet agreed with Kiron:

| Limit | Value | At measured prices that is about |
|---|---|---|
| One active session | $1 | 10 chat turns on the default model, 2 on Fable |
| One day | $2 | 20 chat turns on the default model, or 24 voice calls |
| One month | $40 | |

All limits apply together. At a limit new paid work stops, the board keeps
working, and the app says what paused and how to resume. It never switches
provider, buys credit or raises a cap on its own. An unknown billing route
counts as paid.

### Development (the three sessions)

Kept separate from the app's numbers; never reported as dollars per request
unless the billing route is known (§6).

- A task contract names its runtime test budget; default $0.50 of real model
  calls, and tests otherwise run with the keys blanked.
- The simulator fleet stays off in every worktree (`touch sim/.disabled` before
  the first commit); it makes real OpenAI calls after each commit.
- Review re-runs what the change touched, not the whole product.
- No one re-reads the whole repository or regenerates this plan without a reason.

## 6. Using the Claude subscription

Kiron is on the highest Claude plan (2026-10-12). Researched the same day by a
sub-agent that was asked for official pages only and also leaned on news sites,
so each line says how far to trust it. I read one page myself, through a
summarising fetch: the support article "Use the Claude Agent SDK with your
Claude plan" (`support.claude.com/en/articles/15036540`, updated the week of
2026-10-12).

**Position: the app stays on an API key. Nothing is built around the
subscription login.** No session secrets are extracted and no unofficial login
is used.

| Question | Finding | Trust |
|---|---|---|
| Does the subscription cover the three development sessions? | Yes. Interactive Claude Code is what the plans are for | Official: `code.claude.com/docs/en/authentication` |
| Can the deployed app sign in with the subscription? | No. Anthropic does not let developers route requests through Free, Pro or Max credentials for their own products; an app uses a Console API key | Official wording, as reported by the sub-agent |
| A helper on Kiron's own Mac, for his use only (`claude -p`, Agent SDK)? | **Unresolved.** The Agent SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." That is about products offered to others; one person's own automation is not addressed. The claim that it is banned and enforced came from news sites | Official quote; the gap is real. Not built on |
| Does the top plan include API credits the app could spend? | **Probably, and this is the lead worth chasing.** The support article says: "Claude Max and Team plans now include monthly API credits" which "cover the Claude Agent SDK, `claude -p`, the Claude API, and Claude Managed Agents." It gives no amount and does not say which key or login spends them. The $200 figure came from a blog | Official page, read through a summary. Amount and mechanism unknown |
| **Conflict on that same page** | A second note there says "Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription limits." Credits or limits: the page says both | Unresolved. Recorded, not interpreted |
| What happens when the allowance runs out? | "Turn on usage credits to keep working at standard API rates." Whether that is opt-in is not stated | Official pricing page, per the sub-agent |
| Can a session bill the API by accident? | Yes. Claude Code uses `ANTHROPIC_API_KEY` from the environment ahead of the subscription login. `/status` shows the active route | Official |

Checked on this Mac, values not read: the Planner session has no
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` in its
environment, no `apiKeyHelper`, and no key exported from the zsh profile. So
nothing there forces API billing. The app's `.env.local` names
`ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; Next reads that file, the shell does
not. `/status` in each session is the confirmation, and only Kiron can run it.

What this could mean for cost, if the credits do apply to the API organisation
the app's key belongs to: Anthropic usage (understanding, extraction, any
Claude chat model) would draw on credits already paid for, while OpenAI usage
(the default chat model, voice) would not. That would argue for moving chat to
a Claude model. It is a reason to check, not a decision.

Phase 14 keeps the model and provider behind one adapter either way, so a
supported cheaper route can be switched in without touching the product.

## 7. Task 1.01 — the measured baseline

**For the Executor. No product code changes.**

Outcome: `docs/jarvis/BASELINE.md`, with every number traceable to a command or
a file, so later cycles can prove they made something better.

1. **Toolchain.** `tsc`, the suite the way CI runs it (no `.env.local`,
   CI's placeholder keys, a throwaway VAPID pair), `next build`, and local
   Playwright. Report what runs on this Mac and what only runs in CI. The
   Reviewer's Chromium stand-in is
   `~/code/sec-review/e2e-local/playwright.rev.config.ts`.
2. **Spend, read-only from production.** By day, kind and model from 2026-10-07
   to today. Spend on days with no new data. Chat rows by day and model with
   cached tokens, back to 09-06. Which chat model Kiron's settings hold now.
   Current cap settings on Heroku, names and numbers only, no secret values.
   Use a read-only transaction and prove it is read-only first.
3. **Where a chat turn's tokens go.** Build one chat request locally without
   sending it. Size instructions, tool schemas, live context and history, per
   round and per turn, and count the rounds a typical turn takes.
4. **Screens.** Workspace, Dashboard (Overview, Board) and Canvas at 393×852,
   820×1180 and 1440×900, from a local build. Screenshots go in
   `~/code/secretary-extras/round-evidence/jarvis-1.01/`, not in the repo.
5. **Hands on the Workspace**, in a real browser.
   Phone (393 wide, touch): the stack, collapse, tap.
   Tablet (820×1180, touch) and desktop: drag, resize, undo, reload. Did each
   work first try and persist? Any model call in the network log?
   Tick: record as not built.
6. **The nine old reports** (below): one line each, fixed / still broken /
   cannot tell, with file and line.
7. **Kiron's data, read-only:** is there an AV event project, an equipment
   list, a shopping list? Names and counts only.

Old reports to settle: whole-canvas replacement on edit; `edit_canvas` missing;
widget controls and checkboxes; layout-tool schema rejections; large static
prompts; Shopping-list duplicates; Findit integration; repetitive
duplicate/finished/stale questions; no useful initiative.

Limits: read-only on production; at most $0.50 of real model calls; no deploy.
Branch `jarvis-1.01-baseline` off `jarvis-1.00-plan`. Done when the RESULT is
sent with the commit SHA. The Reviewer then re-runs three of the numbers and
three of the file claims of their own choosing, and opens the screenshots.

## 8. Done means: the workshop milestone

One recorded session on an iPad-width touch screen (820×1180) and once on a
desktop, on real data where a connection exists. If the Findit API is not live
by then, step 4 runs on a fixture labelled as a fixture on screen.

1. *"Pull up my AV event project, show me the equipment I still need, and make a
   setup checklist."* Three widgets appear: overview, equipment, checklist.
2. *"Move the checklist to the right and make the equipment list bigger."* The
   same widgets move and resize. Ids, contents, scroll and ticks are unchanged.
3. Kiron drags one widget and ticks two tasks. Both persist. The network log
   shows no model call.
4. *"Add two short SDI cables to the list, check whether I already have them,
   and show me where they are."* Owned and to-buy are told apart, and each
   answer links to its Findit record.
5. Close and reopen. Same widgets, layout, ticks and project.

Attached to the recording: time to first visible response and to completion for
each spoken step, tokens and dollars per step, and the Reviewer's VERDICT from a
real browser. A step that only works on the Executor's machine is not done.

## 9. Cycle numbers

Kiron, 2026-10-12: *"make sure to commit versions with the numbers 1.00 1.01
etc to git hub as you go."*

- The counter is an integer. 100 is shown as 1.00, 101 as 1.01, 200 as 2.00.
- One accepted checkpoint is one cycle.
- The commit offered for review as final is itself titled `v1.NN: …`. It
  carries the LOGBOOK entry headed `v1.NN` and the version in `package.json`
  and in `package-lock.json` (two places): `1.0.N` with no leading zero, so
  1.01 is `1.0.1` and 1.10 is `1.0.10`.
- A FAIL means another commit on top, titled `v1.NN r2: …`, then `r3`.
  Nothing is retitled, squashed or rewritten. The Reviewer's PASS names the
  range, and that exact SHA is what goes to `main`.
- Unfinished work pushed along the way is titled `WIP 1.NN …`. It is not a
  version.
- No git tags: the Pushing rules cover branches and `main` only.
- The older `v0.xx` entries stay as they are.

## 10. Decisions

Answered by Kiron, 2026-10-12:

1. **Background work stays on at $3 a day or less.** Applied on Heroku the same
   day (v62). See §5.
2. **Findit may provide an API** ("findit team can give api to conenct thats
   cool"). Asked of the Findit planner the same day: token-authenticated,
   read-only search and item lookup returning name, quantity, location path,
   photo URL, a link back to the item and its last-changed time. No model calls
   on that path. The token goes from Kiron to Heroku, never through a message.
   Their answer, the same day: not started until Kiron confirms it in the
   Findit session; then it is the round after their v2.30. Shape agreed: search
   by literal words only, so no paid call (Secretary sends a few plain queries
   instead); at most 50 rows with a flag when more matched; a location path of
   mixed parts (spot, thing, person) that may be empty; each item marked his
   own or shared with him; the token made by Kiron on his Findit Account page.
3. **He is on the highest Claude plan.**

Still open:

4. **Do the plan's monthly API credits reach the app's API key?** An official
   page says the top plan includes them (§6); it does not say how much or how
   they are spent. Kiron's Claude usage page and the Console billing page for
   the organisation that owns the app's key will show it.
5. **The chat and voice caps in §5** ($1 a session, $2 a day, $40 a month) are
   my proposal. Phase 2a builds them as settings; the numbers are Kiron's.
6. **Split the $3.** I recommend reading at $2.50 a day, which leaves $0.50
   for the rest of the background work (table in §5). One Heroku setting,
   Kiron's to run:
   `heroku config:set UNDERSTANDING_DAILY_CAP_USD=2.5 -a secretary-kiron`.
7. **Names in the public history.** Words from his real data have been on
   public main since 2026-08-07 (the Reviewer, 2026-10-15). The current files
   are cleaned in 1.16; the history keeps them. Rewriting the
   history or making the repository private is his call; neither is done
   without him.
