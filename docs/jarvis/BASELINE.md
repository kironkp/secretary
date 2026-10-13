# 1.01: the measured baseline

Measured 2026-10-12 by the Executor, on commit `1577ccd` (`main` at `4189e4d`
plus the plan). Task: `docs/jarvis/PLAN.md` §7 as amended at `0bcb25c`. No
product code changed.

Where things are:

- **Scripts** that produced the numbers: `docs/jarvis/baseline/` (in this repo).
- **Evidence** (logs, raw output, screenshots), called `E/` below:
  `~/code/secretary-extras/round-evidence/jarvis-1.01/` (on the Mac, not in the repo).
- **How to re-run** anything: the last section.

## Headlines

| # | Question | Answer |
|---|---|---|
| 1 | Does the toolchain run on this Mac? | Yes, all of it: typecheck, lint, 1,139 tests, the production build, and all 62 browser specs on Chromium. Only the WebKit (iPhone) browser run is CI-only. |
| 2 | Spend since 2026-10-07 | **Not measured.** This session is not allowed to read the production database. One command for Kiron to run is in §2. The cap settings were read: one cap is set on Heroku (all background work, $3 a day); the rest are code defaults, and background reading is on. |
| 3 | Where do a chat turn's tokens go? | One model round is **30,929 input tokens, and 62.5 % of it is the tool definitions.** A turn is usually two rounds, so about 62,000. The fixed part sent every round is now 30,485 tokens, not the 15,600 the code comment and the plan say. |
| 3 | Is caching hitting on the chat model? | **Yes, it hits on Fable** (tested: 23,670 tokens written, then read). The Fable rows with no cached tokens are older than the caching code. |
| 4 | Screens | 24 screenshots at three sizes (§4). The Canvas throws a page error on load at tablet and desktop size; the Workspace board has widgets covering each other. |
| 5 | Workspace by hand | **Tablet (touch) and desktop (mouse): drag, resize and undo all worked first try and survived a reload.** Phone: one tidy column; collapse and tap work; drag does nothing while the screen says "Drag to arrange". Ticking a task is not built. No model call in any of it. |
| 6 | The nine old reports | 1 fixed, 4 still broken, 3 partly fixed, 1 still missing (§6). |
| 7 | AV event project, equipment list, shopping list | **Not measured** (production). The same command in §2 answers it. |

## 1. Toolchain

Run the way CI runs it (`.github/workflows/deploy.yml`, job `verify`): a clean
copy of the commit (`git archive`, so no `.env.local`), an empty environment
plus only what the workflow sets (`DATABASE_URL`, `OPENAI_API_KEY` placeholder,
`VOICE_DISABLED=true`, `BETTER_AUTH_SECRET` placeholder), a throwaway VAPID
pair, and a fresh local Postgres on port 5440 (version 18; CI uses 16).
Node v24.18.0, macOS 12.7.6.

| Step | Command | Result | Time | Log |
|---|---|---|---|---|
| Schema | `node scripts/release.mjs` | exit 0 | 3 s | `E/logs/schema.log` |
| Typecheck | `npx tsc --noEmit` | exit 0, no output | 33 s | `E/logs/tsc.log` |
| Lint | `npm run lint` | exit 0, 1 warning (`components/settings/shop-requests.tsx:91`) | 27 s | `E/logs/lint.log` |
| Tests | `npm test` | **96 files, 1,139 tests, all passed** | 156 s | `E/logs/vitest.log` |
| Build | `npx next build` | exit 0 | 241 s | `E/logs/build.log` |
| Browser specs, Chromium 1194 | `npx playwright test -c playwright.local.config.ts` | **62 passed** | 242 s | `E/logs/e2e.log` |
| Browser specs, the Reviewer's config | `npx playwright test -c playwright.rev.config.ts` | **62 passed** | 132 s | `E/logs/e2e-rev.log` |

Every line is in `E/logs/summary.txt`; the scripts are `E/ci-local.sh`,
`E/ci-build.sh`, `E/ci-e2e.sh` and `E/ci-e2e-rev.sh`.

Two things to know:

- **The build fails in 6 seconds if `node_modules` is a symlink** to another
  folder (Turbopack: "Symlink node_modules is invalid, it points out of the
  filesystem root"). That is how worktrees here are set up, so a worktree
  cannot build as it stands. The passing run used a real copy (`cp -Rc`).
  This is a setup matter, not a code defect.
- **Browser specs run here only on Chromium, and only with a stand-in
  config.** The repo's Playwright (1.63.0) can launch neither browser on this
  Mac as installed: WebKit "Executable doesn't exist at …/webkit-2359",
  Chromium "Executable doesn't exist at …/chromium_headless_shell-1243". Both
  stand-ins point every project at a cached Chromium build 1194 and keep each
  project's device profile: mine at the full browser, the Reviewer's
  (`~/code/sec-review/e2e-local/playwright.rev.config.ts`) at the headless
  shell. **Only CI runs the specs on WebKit with the iPhone profile**, the
  engine the phone uses.

## 2. Spend, read-only from production

### Not measured, and why

The permission guard on this session refuses production database reads. It
refused the query script before it connected, so nothing was read. I did not
look for another route.

Everything is ready for one run by Kiron. The script
(`docs/jarvis/baseline/prod-readonly.mjs`) opens the session with
`default_transaction_read_only=on`, and before reading anything proves the
server refuses a write: a `CREATE TEMP TABLE` must fail with SQLSTATE 25006 or
the script stops. It prints names, counts, tokens and dollars only. Run against
a local copy of the dev database, the proof line read:

```
{"default_transaction_read_only":"on","transaction_read_only":"on","write_probe":"25006 cannot execute CREATE TABLE in a read-only transaction"}
```

The command (typed by Kiron, in the Executor's session, with a leading `!`):

```
cd ~/code/secretary-extras/worktrees/secretary-jarvis-101 && DATABASE_URL="$(heroku config:get DATABASE_URL -a secretary-kiron)" OWNER_EMAIL=<the account's email> node docs/jarvis/baseline/prod-readonly.mjs | tee ~/code/secretary-extras/round-evidence/jarvis-1.01/prod-readonly.txt
```

What it prints, in Pacific time:

| Section | Answers |
|---|---|
| `by_kind_model_since`, `by_day_kind_model` | Spend by day, kind and model from 2026-10-07 |
| `by_day_spend_and_new_data`, `spend_on_idle_and_silent_days` | Spend on days with no new data. A day is idle when no row was created on it: no message from the user or the mailbox, no task, event, document, remembered fact or upload |
| `chat_by_day_model`, `chat_turns` | Chat rows by day and model with cached tokens, back to 09-06 |
| `model_settings` | Which chat model the settings hold now |
| `chat_voice_per_row_since`, `chat_voice_rows_since` | Input, cached and output tokens per chat turn and per voice call |
| `understanding_runs_since`, `records_written_since` | What the background reading ran and wrote |
| `projects`, `counts`, `keyword_counts` | §7 |

### Cap settings on Heroku (measured, 2026-10-12 evening)

`heroku config -a secretary-kiron`, names only (`E/heroku-config-names.txt`;
27 variables; a value is shown only where it is a plain number or true/false).

| Setting | On Heroku | So the app uses | Where the default lives |
|---|---|---|---|
| `BACKGROUND_DAILY_CAP_USD` | **3** (set this evening by the Planner; unset, so the default 4, when first read today) | $3 per 24 h for all background work | `lib/spend-guard.ts:117` |
| `UNDERSTANDING_DAILY_CAP_USD` | not set | $3 per 24 h for background reading | `lib/spend-guard.ts:29` |
| `UNDERSTANDING_RUN_CAP_USD` | not set | $1.50 per run | `lib/spend-guard.ts:37-38` |
| `SPEND_ALERT_USD` | not set | a push when 24 h of spend passes $8 | `lib/spend-guard.ts:40` |
| `SPEND_KILL` | not set | off | `lib/spend-guard.ts:119` |
| `UNDERSTANDING_DISABLED` | not set | **background reading is on** | `lib/understanding/sweep.ts:60-61` |
| `UNDERSTANDING_SWEEP_MINUTES` | not set | a sweep every 10 minutes | `lib/understanding/sweep.ts:42,53-58` |
| `SLOW_LOOP_DISABLED` | not set | not disabled | |
| `VOICE_SESSIONS_PER_DAY` | 30 | 30 calls a day | `lib/rate-limit.ts:34` |
| `VOICE_MAX_CONCURRENT` | 1 | one call at a time | `lib/rate-limit.ts:35` |
| `TRANSCRIBE_REQUESTS_PER_DAY` | 300 | 300 a day | `lib/rate-limit.ts:109` |
| `VOICE_DISABLED` | false | voice on | |
| `SHOP_DISABLED` | true | shop off | |
| `CLAUDE_BRAIN` | true | Claude paths on | `lib/anthropic.ts:86-88` |

There is **no dollar cap on chat or voice** in the code at all
(`lib/spend-guard.ts:8-10`: "Chat, calls and answering itself are never
blocked"). Voice is limited by count (30 calls a day), not by cost.

### Chat and voice rows (local copy, to 2026-09-10)

Production's own rows need the command above. The local dev database holds the
same rows up to the September cutover (its Fable total for 09-06 onward,
1,159,120 input tokens over 23 rows, is the figure the plan quotes from
production). From `E/local-devcopy-queries.txt`:

Chat by day and model, 09-06 onward (section `chat_by_day_model`):

| Day | Model | Turns | Input tokens | Cached tokens | Output | $ |
|---|---|---|---|---|---|---|
| 09-08 | claude-fable-5 | 16 | 757,210 | not recorded (16 of 16) | 6,286 | 7.89 |
| 09-09 | claude-fable-5 | 7 | 401,910 | not recorded (7 of 7) | 3,066 | 3.66 |
| 09-09 | claude-opus-5 | 7 | 467,095 | 284,924 | 5,019 | 1.18 |
| 09-10 | claude-opus-5 | 1 | 50,346 | 24,508 | 1,166 | 0.17 |

Per row, the 37 days to today (section `chat_voice_per_row_last_37_days`):

| Kind | Model | Rows | Input, average (min – max) | Cached | Output, average | $ per row |
|---|---|---|---|---|---|---|
| chat | claude-fable-5 | 23 | 50,397 (24,058 – 76,337) | not recorded | 407 | 0.525 |
| chat | claude-opus-5 | 8 | 64,680 (49,437 – 104,720) | 38,679 average, hit on 8 of 8 | 773 | 0.169 |
| voice | gpt-realtime-2.1 | 7 | 33,702 (0 – 54,317) | not recorded | 964 | not all priced |

A chat row is one turn, not one model round; a voice row is one call (224
seconds on average here). The chat model in the local copy's settings is
`claude-opus-5` at effort `high` (section `model_settings`); that was true in
September and may not be now.

## 3. Where a chat turn's tokens go

Built with the app's own builders and never sent for an answer
(`docs/jarvis/baseline/size-chat-request.ts`; output `E/size-chat-request.txt`).
Token counts are exact, from the provider's token counter, which generates
nothing. Data: a local copy of the dev database (8 projects, 102 tasks, last
used in September), so the live briefing on production will differ somewhat;
the tool definitions and the fixed instructions do not depend on data.

### One round

**One request to `claude-fable-5`: 30,929 input tokens.** `claude-opus-5`
counts the same request at 30,925.

| Part | Characters | Tokens | Share |
|---|---|---|---|
| Tool definitions (62 tools) | 48,451 | 19,339 | 62.5 % |
| Live briefing (129 lines) | 16,043 | 6,702 | 21.7 % |
| Fixed instructions (persona, directives) | 13,100 | 4,444 | 14.4 % |
| History (6 messages; the route replays up to 40) | 1,303 | 430 | 1.4 % |
| The user's message | 25 | 14 | 0.05 % |

The first three rows, 30,485 tokens, are sent again on every round of a turn.
**The plan and the code comment (`lib/secretary/chat-claude.ts:58-59`) put that
at about 15,600 (6,000 of instructions, 9,500 of tools). It is twice that
now:** 11,146 of instructions and briefing, 19,339 of tools.

- The largest tool definitions, in characters: `update_task` 2,209,
  `arrange_canvas` 2,188, `edit_layout_plan` 1,793, `create_task` 1,707,
  `create_event` 1,660, `log_status` 1,636.
- The largest briefing sections, in characters: ALL OPEN TASKS 3,784, SECRETARY
  3,071, the opening lines 2,751, DOCUMENTS 2,666, ABILITIES ALREADY BUILT 1,023.
- Voice carries 33 tools, 27,375 characters; at the same ratio that is roughly
  10,900 tokens (an estimate, not counted). The OpenAI chat path sends the same
  62 tools, 49,443 characters.

### One turn

A usage row is one user turn: the route writes one row per turn
(`app/api/chat/route.ts:338`) and the Claude loop adds up every round, up to
eight (`lib/secretary/chat-claude.ts:10,97`).

**A typical turn takes two rounds.** Rounds are not recorded anywhere, so this
is read from the size of each row. The 31 chat turns in the local copy
(09-06 to 09-10) fall into four clear groups at one, two, three and four times
the request size of that week, about 24,300 tokens
(`E/rounds-per-turn-local.txt`):

| Rounds | Turns (of 31) | Input tokens, those rows | The same turn at today's sizes |
|---|---|---|---|
| 1 | 1 | 24,058 | about 31,000 |
| 2 | 24 | 45,776 – 52,710 | about 62,000 |
| 3 | 5 | 69,704 – 77,922 | about 93,000 |
| 4 | 1 | 104,720 | about 124,000 |

Mean 2.2 rounds. Beyond the copies of the fixed part, a two-round turn carried
only 917 to 2,817 tokens (history and message twice, one tool call and its
result), measured on the four two-round Opus rows, where the cached count
gives the fixed part exactly. So a two-round turn today is, in tokens: tools
38,678, briefing 13,404, instructions 8,888, everything else under 3,000.

### Is prompt caching hitting on the chat model?

**It hits.** Two real requests to `claude-fable-5` with the app's tool block
and fixed instructions, each ending in a cache breakpoint as
`lib/secretary/chat-claude.ts:70-83` does (`docs/jarvis/baseline/cache-probe.ts`;
output `E/cache-probe-fable.txt`):

| Request | Fresh input | Written to cache | Read from cache | Output |
|---|---|---|---|---|
| 1 | 84 | 23,670 | 0 | 4 |
| 2 | 84 | 0 | 23,670 | 4 |

**Why the Fable rows show no cached tokens: they are older than the caching
code.** Every Fable chat row in the local copy is dated 09-09 09:53 or earlier
and has the cached column empty (null, not zero). Caching, and the recording
of it, landed together in commit `72f04b7` on 09-09 at 12:22. Every chat row
after that is on Opus, and all 8 hit the cache: 309,432 of 517,441 input tokens
(60 %). So it was neither "not hitting" nor "not recorded"; no Fable turn has
run with caching in that data. Whether one has since, production will say.

Three limits on what the cache saves today:

- The code asks for the default cache lifetime, five minutes. Turns further
  apart than that pay to write the whole prefix again.
- The live briefing carries a clock line that changes every minute, so that
  block is rewritten every turn (`lib/secretary/chat-claude.ts:75-79`).
- The app prices a cache write as ordinary input (`lib/pricing.ts:191-195`),
  while the code's own note says writes are billed at about 125 %
  (`lib/secretary/chat-claude.ts:93-94`). Recorded cost is a little under the
  real bill on every write.

### What this task spent

About **$0.32**, all on the two probe requests: 23,670 tokens written at
$12.50 per million, 23,670 read at $1, 168 fresh at $10, 8 out at $50 (the
rate card at `lib/pricing.ts:87`, with the 125 % write rate). The token counter
is free. Nothing else called a model: every server and test here ran on
placeholder keys.

## 4. Screens

`E/screens/`, taken by `docs/jarvis/baseline/browser-screens.mjs` from the
local production build (`next start`), Chromium, signed in on a local copy of
the dev database. The content is real but old (September).

Four screens (`workspace`, `dashboard-overview`, `dashboard-board`, `canvas`)
at three sizes (393×852, 820×1180, 1440×900). Each has the first view and a
tall one showing what is below the fold, for example `workspace-393x852.png`
and `workspace-393-tall.png`: 24 files. Load times and console errors are in
`E/screens/screens.log`.

What the pictures show:

- **Workspace, 393 wide.** One column. The line at the top says "Drag to
  arrange". The Overdue widget opens with an eleven-line paragraph before its
  first task.
- **Workspace, 820 and 1440 wide.** The board is a 672-pixel column
  (`app/(app)/workspace/page.tsx:53`, `max-w-2xl`), so at 1440 it sits in the
  middle third of the screen. The top-left of the board is empty, the Overdue
  widget covers the widget under it, and Overdue shows a single task because
  its paragraph takes the height.
- **Dashboard Overview and Board.** Both read cleanly at all three sizes. At
  1440 the Overview's first card takes half the width and leaves the other
  half empty.
- **Canvas.** The instruction that was given to the painter is printed above
  the canvas: twelve lines at 820 wide, and at 393 wide it fills the entire
  first screen, so the canvas itself starts below the fold.
- **Canvas throws a page error** on load: "Cannot read properties of null
  (reading 'dataset')", 6 times at 820 wide and 4 times at 1440; none at 393
  in this run, one in an earlier run at 390. The only such read in the canvas
  code is `components/canvas/canvas-view.tsx:271`
  (`doc.documentElement.dataset`). The other three screens log no errors.

## 5. Hands on the Workspace

`docs/jarvis/baseline/browser-hands-on.mjs`, Chromium. On the phone and tablet
profiles every gesture is real touch input through the browser's input
pipeline, not the mouse the CI specs use; the desktop profile uses the mouse.
Each gesture was tried once and the table is that first try. Raw output:
`E/hands-on-phone.txt`, `E/hands-on-tablet.txt`, `E/hands-on-desktop.txt`;
pictures of each step in `E/hands-on/`.

| | Phone, 393×852, touch | Tablet, 820×1180, touch | Desktop, 1440×900, mouse |
|---|---|---|---|
| Layout on load | One column, 5 widgets, none overlapping | Grid; 1 pair of widgets overlapping | Grid; 2 pairs overlapping (after the tablet run's move) |
| Drag a widget 200 px down | Nothing: 0 px, nothing saved, no request | **Worked first try**: row 0 → 4, one request | **Worked first try**: row 4 → 8, one request |
| Resize by the corner grip, 130 px each way | No grip is drawn | **Worked first try**: 6×6 → 8×8, one request | **Worked first try**: 6×6 → 8×8, two requests |
| Undo | not tried (nothing to undo) | **Worked**: the whole board back to before the resize | **Worked**, the same |
| Tap a widget | Focus ring appears and is saved | the same | the same |
| Collapse | Worked, saved | Worked, saved | Worked, saved |
| Reload | Collapse and focus kept | Position, size, collapse and focus kept | the same |
| Tick a task | **Not built.** A tap on the 20×20 px circle leaves the task open | the same | the same |

Notes:

- **Touch drag and touch resize work.** These were the untested gestures: the
  CI specs drag with a mouse. Checked on Chromium only.
- **On a phone, drag is switched off on purpose** below 768 px
  (`components/workspace/workspace-board.tsx:249`, `if (narrow) return;`, with
  `narrow` set at line 118), and no resize grip is drawn (line 466). But the
  drag handle is still drawn on every widget (line 407) and the hint still
  says "Drag to arrange" (line 328), so the phone offers a gesture that does
  nothing.
- **Tick is not built.** The shell writes the task id onto the row
  (`lib/workspace/apply-bindings.ts:56`) and the stylesheet draws the circle
  (`app/globals.css:292`), but no code listens for a tap on it; the only
  `data-check` click handling in the repo is the Canvas's
  (`lib/canvas/interaction.ts:142`). `docs/workspace/SPEC.md:314` lists it as
  Phase 3.
- **Widgets can overlap, and stay overlapped.** The board as found has one
  overlapping pair on the grid, and the drag made it two: a widget dropped on
  another stays there. The Tidy button is meant to pack the board (the specs
  rely on its operation); I did not press it here.
- One resize with the mouse sends two requests (the resize, then a focus from
  the click that ends it). With touch it sends one.

**No model call in any of it.** On all three profiles the only requests the
page made were `GET /api/chat/bootstrap` on load and `POST /api/workspace` per
change; the `usage` table had 506 rows before and after every run; the server
log gained no lines. (The server had placeholder keys, so a model call would
have failed loudly.)

Not covered: WebKit. A real iPhone or iPad, or CI's WebKit run, is the check
that counts for iOS.

## 6. The nine old reports

Settled by reading the code at this commit; every line number below was
checked against the file. Items 3 and 5 are also backed by §5 and §3. Nothing
in this section was exercised in a browser except where it says so.

| # | Report | Verdict | Evidence |
|---|---|---|---|
| 1 | Whole-canvas replacement on edit | **Still broken**, softened | An edit hands the model the whole canvas (`lib/canvas/painter.ts:129`) and its whole output replaces it (`:253`). The helper that would patch one block, `replaceBlock` (`lib/canvas/blocks.ts:168`), is called only from tests. Softened two ways: the old canvas stays up while the edit runs (`painter.ts:222`), and move, resize and hide have a tool with no model call (`arrange_canvas`, `lib/secretary/tools.ts:2499`). But the voice rules send "move this above that" and "make the urgent one bigger" to `edit_canvas` (`lib/secretary/persona.ts:182`) and never name `arrange_canvas`. |
| 2 | `edit_canvas` missing | **Fixed** | Defined `lib/secretary/tool-schemas.ts:540`, implemented `lib/secretary/tools.ts:2584`, in the voice list `tool-schemas.ts:817` (sent at `app/api/realtime/token/route.ts:171`); chat sends every tool. |
| 3 | Widget controls and checkboxes | **Still broken**, both surfaces | Canvas: the frame's only meta tags are the charset and the content policy, no viewport (`lib/canvas/sanitize.ts:303-306`); the checkbox is still 18×18 px (`sanitize.ts:331`); a tap beside it still opens the project (`lib/canvas/interaction.ts:123-125`, and `tests/canvas-interaction.test.ts:142` asserts it). Workspace: ticking is not built (§5). Whether iOS still delays the tap needs a phone. |
| 4 | Layout-tool schema rejections | **Partly fixed** | Voice carries only flat schemas and a test forbids `oneOf` (`tests/agent-voice-split.test.ts:325`). Chat still sends `edit_layout_plan` with a union and a free-form record (`tool-schemas.ts:504,518`); Anthropic accepts all 62 schemas today (the probe in §3 sent them and was answered); OpenAI was not tested. Still broken: when the app's own validator drops or resets part of a change it only records a warning (`lib/layout/validator.ts:112,120,123`) and the tool still answers `applied: true` (`lib/secretary/tools.ts:2468`). A full rejection is reported properly (`tools.ts:2462`). |
| 5 | Large static prompts | **Still broken**, and larger | 19,339 tokens of tools and 4,444 of instructions on every round (§3). Persona `lib/secretary/persona.ts:3`, tool descriptions `lib/secretary/tool-schemas.ts:664`, voice rules `persona.ts:171`. Voice sends 33 tools, chat 62. |
| 6 | Shopping-list duplicates | **Partly fixed** | The same item is refused (`lib/secretary/tools.ts:1155,1161`; test `tests/lists-dashboard.test.ts:61-63`). The match is exact after lower-casing and stripping "buy", "a", "some" (`lib/secretary/lists.ts:45-46`), so "towel" and "towels" would still be two rows; no test covers it. |
| 7 | Findit integration | **Still missing** | No URL, client or setting for Findit anywhere in `lib`, `app`, `components` or `scripts`. The matches are comments (`lib/push.ts:1`, `scripts/funnel.mjs:12`) and the user's own project name. |
| 8 | Repetitive duplicate, finished and stale questions | **Partly fixed** | Duplicate: fixed. A question has an identity hash (`lib/understanding/questions.ts:54`) and a settled one stays settled for 30 days (`lib/understanding/supersede.ts:101`). Finished: still broken. Ticking a task or closing it by voice only clears expectations (`app/api/tasks/[id]/route.ts:117`); the question resting on it closes only at the next successful model run (`questions.ts:394-399`). Stale: nothing retires an open question by age, and the briefing lists the same open ones every session (`lib/secretary/briefing.ts:626`). |
| 9 | No useful initiative | **Still broken** | The only unprompted contact is a reminder push, and only for an item that carries a reminder time, on a device with notifications on (`instrumentation.ts:25`, `lib/push.ts:14`). There is no morning briefing and no schedule (`Procfile` has only `release` and `web`). The one follow-up that should open a conversation looks to be used up by loading a page: every page's chat dock (`app/(app)/layout.tsx:47`) calls `app/api/chat/bootstrap/route.ts:21`, which builds the briefing and so marks overdue expectations "missed" (`lib/secretary/briefing.ts:563-577`) while returning only the card (`route.ts:33`). Read, not run. |

One lead from the same reading that I did not verify: an edit may start from
the visible blocks only, which would drop hidden blocks for good
(`lib/secretary/tools.ts:2604`, `lib/canvas/composition.ts:136`).

## 7. Kiron's data

**Not measured**: it lives in production (§2). The same command prints every
project and list by name with its task counts, and counts of titles containing
AV, equipment, gear, cable, camera, event, setup, checklist and shopping.

What the old local copy says, for orientation only (September, before lists
existed as a kind of project): 8 projects, none named for AV or an event; no
lists; "AV" in 5 task titles, "gear" in 3, "camera" in 2, "equipment",
"checklist" and "shopping" in 1 each. The AV work visible there is inventory
tasks inside the Caltrans project. (`E/local-devcopy-queries.txt`, sections
`projects` and `keyword_counts`.)

## Could not measure

| What | Why | What would settle it |
|---|---|---|
| Spend by day, kind and model since 10-07; spend on idle days; production chat rows and tokens; which chat model is set now | Production reads are blocked for this session | Kiron runs the command in §2 |
| AV event project, equipment list, shopping list | The same | The same |
| Whether a Fable chat turn has hit the cache in production | The same; the probe shows it can | The same |
| Workspace gestures on WebKit | WebKit does not launch on this Mac | CI, or a real iPhone or iPad |
| Whether OpenAI accepts the chat tool schemas | Placeholder key; the real one has no credits | One live request |
| Screens with today's data | The local copy is from September | Not needed for a baseline of layout |

## Re-running

All from `~/code/secretary-extras/worktrees/secretary-jarvis-101`. `E` is the
evidence folder.

```
# 1. Toolchain, CI-exact (start the throwaway Postgres on 5440 first; it is stopped)
(cd E/ci && PGPORT=5440 PGDATA_DIR=E/pgdata node scripts/local-postgres.mjs)   # leave running
E/ci-local.sh; E/ci-build.sh; E/ci-e2e.sh; E/ci-e2e-rev.sh; cat E/logs/summary.txt

# 2 and 7. Production, read-only: Kiron's command in §2.
#    The same script against the local copy (port 5441, running):
DATABASE_URL=postgresql://postgres:postgres@localhost:5441/secretary OWNER_EMAIL=<email> SINCE=2026-09-01 \
  node docs/jarvis/baseline/prod-readonly.mjs

# 3. Token sizes (free). Add ANTHROPIC_API_KEY for exact counts.
DATABASE_URL=postgresql://postgres:postgres@localhost:5441/secretary OPENAI_API_KEY=placeholder \
  OWNER_EMAIL=<email> npx tsx docs/jarvis/baseline/size-chat-request.ts
#    The cache probe costs about $0.32 a run on Fable:
#    MODEL=claude-fable-5 ANTHROPIC_API_KEY=... npx tsx docs/jarvis/baseline/cache-probe.ts

# 4 and 5. Browser (the build is served on 3112 against the local copy, running)
BASE_URL=http://localhost:3112 OWNER_EMAIL=<email> STATE=E/state-owner.json \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5441/secretary node docs/jarvis/baseline/browser-signin.mjs
BASE_URL=http://localhost:3112 STATE=E/state-owner.json OUT=E/screens node docs/jarvis/baseline/browser-screens.mjs
BASE_URL=http://localhost:3112 STATE=E/state-owner.json OUT=E/hands-on PROFILE=phone \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5441/secretary node docs/jarvis/baseline/browser-hands-on.mjs
#    PROFILE=tablet and PROFILE=desktop the same way.
```

The local copy (`E/pgdata-devcopy`, port 5441) is a clone of the Mac's dev
database brought up to the current schema. The screenshots were taken on it
untouched; the hands-on runs then moved one widget and collapsed it, so a
second hands-on run starts from that board, not the original. The server on
3112 runs the CI build with placeholder keys, no push keys, and background
reading disabled, so it can neither spend nor notify.
