# Secretary → JARVIS: the plan

Owner: the Planner. Started 2026-10-12. This file is the roadmap, the current
task and the next action; it is what a new session reads to pick the work up.
Kiron's vision, in his words: *"I want Secretary to feel like having Jarvis
beside me in a workshop."*

## Now

- **Cycle counter: 100** (shown as 1.00). See §9 for how cycles are numbered.
- **1.00** — this plan. Three review rounds: the first two failed on wrong
  claims, corrected here.
- **1.01** — measured baseline (§7). With the Executor.
- **Next after that:** 1.02 land the parked Overview round (A007), then
  Phase 2a.
- **Decided by Kiron, 2026-10-12** (§10): background work stays on at $3 a day
  or less; the Findit team may build an API; he is on the highest Claude plan.
- **Asked of the Findit planner, 2026-10-12:** a read-only API (§10).

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

### Unknown (1.01 answers these)

- Whether Kiron's data holds an AV event project and an equipment list.
- What the app spends on a day with no new data, since 10-07.
- Which chat model Kiron's settings hold now, and how many rounds a turn takes.
- Whether touch-drag and resize work on a tablet-width touch screen.

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
   all 62, take fewer rounds, and keep the cached prefix stable. Sized in 1.01
   before anything is built.
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
| 5 | Direct manipulation, **including writes in place** | 4 | Tick, add a row and open a row's detail work and persist; touch-drag and resize on a tablet; keyboard; reorder on a phone; the network log shows no model call | Mouse drag and resize at 768 px+ only. Tick, keyboard, touch-drag: not built or untested |
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

## 4. Who does what

- **Planner** (this session): this plan, task contracts, `CLAUDE.md`, talking to
  Kiron, pushing a PASSed SHA to `main` and watching CI and the Heroku release.
  Writes no product code.
- **Executor:** all code, tests and measurements, one worktree per task under
  `~/code/secretary-extras/worktrees/`. Ends with a RESULT: SHAs, what changed,
  the evidence, how to check it.
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
extraction, the dashboard planner and inbound email wait until that spend rolls
off, and a "Background work paused" push goes out
(`lib/spend-guard.ts:160-163`). Nothing is lost: extraction keeps its place
(`lib/secretary/extraction.ts:517-519`). Before v62 there was $1 of room.
Lowering reading's own cap to $2 would restore it (§10, decision 6).

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
3. **He is on the highest Claude plan.**

Still open:

4. **Do the plan's monthly API credits reach the app's API key?** An official
   page says the top plan includes them (§6); it does not say how much or how
   they are spent. Kiron's Claude usage page and the Console billing page for
   the organisation that owns the app's key will show it.
5. **The chat and voice caps in §5** ($1 a session, $2 a day, $40 a month) are
   my proposal. Phase 2a builds them as settings; the numbers are Kiron's.
6. **Split the $3.** I recommend reading at $2 a day, leaving $1 for the rest
   of the background work, so a heavy reading day cannot stall extraction. One
   Heroku setting, Kiron's to run:
   `heroku config:set UNDERSTANDING_DAILY_CAP_USD=2 -a secretary-kiron`.
