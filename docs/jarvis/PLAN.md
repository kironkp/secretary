# Secretary → JARVIS: the plan

Owner: the Planner. Started 2026-10-12. This file is the roadmap, the current
task and the next action; it is what a new session reads to pick the work up.
Kiron's vision, in his words: *"I want Secretary to feel like having Jarvis
beside me in a workshop."*

## Now

- **Cycle counter: 100** (shown as 1.00). See §9 for how cycles are numbered.
- **1.00** — this plan. In review.
- **1.01** — measured baseline (§7). With the Executor.
- **Next after that:** 1.02 land the parked Overview round (A007), then the
  cost work in Phase 2.
- **Waiting on Kiron:** three questions in §10. None blocks 1.01.

## 1. What is true today

Checked 2026-10-12 against `origin/main` at `4189e4d` (live as Heroku v61,
CI green). "Checked" means I read the code or the file named; nothing here was
exercised in a browser by me. 1.01 does that.

### Works

| Capability | Evidence |
|---|---|
| Chat and voice share one tool system, about 50 tools: tasks, events, Google Calendar, Gmail read and draft, lists, check-ins, remembered facts, web search | `lib/secretary/tool-schemas.ts`, `lib/secretary/tools.ts` |
| A Workspace board with inline widgets (no iframe), stable widget ids, grid geometry, z-order, collapse, focus, undo and redo, saved per user | `lib/workspace/types.ts`, `lib/workspace/ops.ts`, `components/workspace/workspace-board.tsx`, table `workspaces` at `lib/db/schema.ts:846` |
| Widgets bound to live data: tasks, events, projects, documents, check-ins. Tick a bound task in place | `lib/workspace/bindings.ts`, `lib/workspace/apply-bindings.ts` (`data-check`, `data-action`) |
| Dashboard views incl. a draggable timeline with exact undo | LOGBOOK v0.33 |
| Background spend is capped and has a brake | `lib/spend-guard.ts`; cap values per the previous trio's notes, to re-verify in 1.01 |
| Planner, Executor and Reviewer can message each other | round trip run 2026-10-12: each session answered "I am the …" |

### Partly works

| Capability | State | Evidence |
|---|---|---|
| Arranging the Workspace by voice | Only on an unmerged WIP branch. On `main` the assistant can arrange the Canvas and the Dashboard but cannot touch the Workspace | `sec-a008a-workspace` @ `0da05e0` adds `lib/workspace/arrange.ts`, `place` / `move_before` ops |
| The Workspace as the main surface | Hidden under Settings › More screens. Merging it with the Dashboard (A008) was approved and not finished | LOGBOOK v0.32 |
| Clear Overview (A007) | Review fixes committed unverified: node would not start on the Mac that day. Node runs again (v24.18.0) | `sec-a007-overview` @ `de5dc87` |
| Canvas | `edit_canvas` exists as a tool. The four defects in `docs/HANDOFF.md` (no viewport meta, 18 px checkbox, reorder remounts every iframe, 24 px clip) are unverified since. The Canvas is the legacy surface | `docs/HANDOFF.md` §Canvas |
| Memory | Remembered facts, history search, the per-project "understanding" reading (hash-gated), interview questions. No single provenance or correction model | `lib/understanding/*`, tool `remember_fact` |
| Spend limits on chat and voice | None. The guard says so itself: "Chat, calls and answering itself are never blocked" | `lib/spend-guard.ts:8-10` |

### Measured, and bad

From production, the 30 days to 2026-10-06
(`~/code/secretary-extras/round-evidence/secretary-sec-a004/prod-usage.txt`):

- **$159.08 in 30 days; $139.37 of it was background reading** ("understanding"),
  not anything Kiron asked for. Worst days: $29.45 (09-24) and $27.83 (10-01).
  This is the "about 30 credits a day": the unit is US dollars, mostly the
  Anthropic API on Opus, some OpenAI. Caps landed on 10-06 (v52); **spend since
  then is unmeasured.**
- **A chat model call carried about 50,000 input tokens** on Fable (1,159,120
  over 23 calls, no cached tokens recorded, $0.50 a call) and about 80,000 on
  Opus (64 % cached). Voice: about 41,000 per call. `lib/secretary/chat-claude.ts:70-80`
  does request caching, so either it is not hitting on Fable or it is not being
  recorded. Unknown which.

### Missing

- **Findit.** No connection of any kind; the only mentions are code comments.
  Findit is a separate Django app on Heroku with login-protected pages and, in
  the routes I read (`findit/urls.py`, `main_app/urls.py`), no token API.
- **Checklists and equipment lists on the board.** Lists exist as data
  (`add_to_list`, `list_items`) but are not a binding source: `FIELDS` in
  `lib/workspace/types.ts` has tasks, events, projects, documents, checkins.
- **The assistant knowing what "this" is.** `focusId` is saved on the board;
  on `main` nothing hands it to the model.
- **Custom interactive artifacts.** Nothing. The sanitizer forbids scripts by
  design, so this needs its own isolated path.
- **Session, daily and monthly caps on interactive spend; a stop button; a
  usage view that says what the money bought.**
- **Resumable tasks, initiative, VR.** Nothing.

### Unknown (1.01 answers these)

- Whether Kiron's data holds an AV event project and an equipment list.
- What the app spends on a day nobody uses it.
- Whether drag, resize and tick work first try on a phone-width browser.
- Where the 50,000 tokens in a chat call come from.

### A naming trap

In this repo **Shop** is the capability-request build queue (`lib/shop/shop.ts`,
tool `request_capability`). Purchases live in the **Shopping list**. I read the
vision's "Shop" as the Shopping list plus procurement. Recorded assumption.

## 2. The smallest changes that get there

No rewrite. The Workspace already has the right bones: inline widgets, geometry
owned by the shell, one validated op list, undo.

1. **Make the Workspace the home surface.** Finish the A008 merge.
2. **One operation vocabulary for hand and voice.** Voice tools call the same
   `applyOps` a drag calls. Add create, update, remove, hide, restore and group;
   a revision check so a model reply cannot overwrite a newer edit; an
   idempotency key so a retried tool call cannot add a second widget.
3. **Widget record:** add `kind` (metadata only, never an `if type ===` tree),
   `schemaVersion`, durable per-widget `state`, and `rev`.
4. **Two new data sources:** `lists` (checklists, equipment) and `findit`
   (read-only, through a server-side connector). A row keeps the id of its
   source record; the board never holds a copy of inventory.
5. **A small workspace packet for the model:** widget ids, titles, kinds,
   left/right/top/bottom, the focused one, the last two referenced. Tens of
   lines, in place of whatever fills 50,000 tokens today.
6. **One spend gate** every billable call passes: purpose tag, reserve before
   sending, reconcile after, caps applied together, a stop switch.
7. **Custom artifacts later, in a sandboxed frame** with a narrow message
   bridge. That is the one place an iframe is right.
8. **Keep ops and widget records plain JSON** with no pixel or DOM terms, so a
   spatial renderer can add pose without touching them.

## 3. Roadmap

The twenty outcomes are Kiron's. Order and scope are adjusted to what exists.

| # | Phase | Depends on | Exit evidence | Today |
|---|---|---|---|---|
| 1 | Audit and baseline | — | Capability map, screenshots, cost and token traces, gap list | 1.00 map; 1.01 measures |
| 2 | Cost containment and prompt diet | 1 | Caps stop paid work in a demo; two parallel requests cannot overshoot; survives restart; an idle day costs $0; chat call under an agreed token budget | Background caps exist; the rest missing |
| 3 | Persistent workspace | 1 | Board survives reload and dyno restart; it is the home surface | Built; hidden; A007 then A008 to land |
| 4 | Workspace operations | 3 | Each op changes only its target; a stale revision is refused, not merged | move, resize, collapse, raise, focus, undo, tidy built |
| 5 | Direct manipulation | 4 | Drag, resize, tick, keyboard on phone and desktop in a real browser; network log shows no model call | Built; never measured |
| 6 | Built-in widgets | 4 | Checklist, equipment list, project overview, notes, table: each does its real actions and keeps state | Task/event/project bindings only |
| 7 | Conversational control | 4, 6 | Voice or text creates and edits existing widgets; ids and unrelated state unchanged | WIP on `sec-a008a-workspace` |
| 8 | Reference resolution | 7 | A fixed set of "this / that list / on the right" commands resolves or asks once | Not started |
| 9 | Incremental memory | 2 | Answers from bounded retrieval; a correction supersedes the old fact; unchanged records are not re-read | Hash gate exists |
| 10 | Findit and Shopping | 6, Findit API | Lookup with location and photo, project tagging, owned vs to-buy, no duplicate adds | Not started; needs the Findit team |
| 11 | **Workshop milestone** | 2–8, 10 | The recorded run in §8 | — |
| 12 | Custom artifacts | 4 | A generated calculator runs, saves, and cannot reach outside its bridge | Not started |
| 13 | Voice quality | 7 | Measured latency, interruption and recovery in real sessions | Voice works; unmeasured |
| 14 | Claude route and model choice | 2 | Verified billing route per adapter; behaviour at limits | See §6 |
| 15 | Work connectors | 9 | Source-backed views and drafts; honest connection status | Calendar and Gmail exist |
| 16 | Resumable tasks | 9 | A task resumes after a side question or a restart without repeating work | Not started |
| 17 | Useful initiative | 2, 16 | Triggers produce a visible result inside a budget; nothing runs idle | Not started |
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
  naming the SHA range. Never fixes the code itself.

Session names change on every launch; find them with ListAgents and assign the
role in the first message. Hand-offs carry the task, the references, the diff
and the findings, never a transcript. Three failed attempts at one task stop the
loop: the Executor writes a short diagnosis and the Planner changes the approach.

## 5. Spending

### The app (runtime)

Existing, kept: understanding runs $3 a day and $1.50 a run, all background work
$4 a day, an alert at $8 a day, `SPEND_KILL` as a brake (values per the previous
trio's notes; 1.01 re-verifies them in code and on Heroku).

Proposed for Phase 2, as prototype defaults:

| Limit | Value | Note |
|---|---|---|
| Background paid inference | off | until a run can show what it produced (§10, decision 1) |
| One active session | $1 | |
| One day | $2 | |
| One month | $40 | |

All limits apply together. At a limit new paid work stops, the board keeps
working, and the app says what paused and how to resume. It never switches
provider, buys credit or raises a cap on its own. An unknown billing route
counts as paid.

**The tradeoff to know:** at today's measured $0.50 per chat call, a $1 session
is two calls. So the prompt diet comes first in Phase 2; the caps are only
livable after it. Estimate, not a measurement: a chat call near 8,000 input
tokens with caching hitting would cost a few cents.

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

Researched 2026-10-12 by a sub-agent. It was asked for official pages only and
also leaned on news sites, so each line says how far to trust it.

**Position: the app stays on an API key. Nothing is built around the
subscription login.** No session secrets are extracted and no unofficial login
is used.

| Question | Finding | Trust |
|---|---|---|
| Does the subscription cover the three development sessions? | Yes. Interactive Claude Code is what the plans are for | Official: `code.claude.com/docs/en/authentication` |
| Can the deployed app sign in with the subscription? | No. Anthropic does not let developers route requests through Free, Pro or Max credentials for their own products; an app uses a Console API key | Official wording, reported by the sub-agent; consistent with the Agent SDK docs as I know them |
| A helper on Kiron's own Mac, for his use only (`claude -p`, Agent SDK)? | **Unresolved.** The sub-agent says banned and enforced, but its sources for that are news sites, and the official wording is about products offered to users | Unverified. Not built on |
| Do Max or Team plans include monthly API credits an app could spend with a normal API key? | Reported as yes ($100 on Max 5x, $200 on Max 20x). The quote it gave names a model that does not exist, so it probably came from a blog | **Unverified.** If true this is the supported way to make the subscription pay for the app. Only Kiron's billing page can settle it (§10) |
| What happens when the allowance runs out? | "Turn on usage credits to keep working at standard API rates." Whether that is opt-in is not stated | Official pricing page, per the sub-agent |
| Can a session bill the API by accident? | Yes. Claude Code uses `ANTHROPIC_API_KEY` from the environment ahead of the subscription login. `/status` shows the active route | Official |

Checked on this Mac, values not read: this session has no `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` in its environment, no
`apiKeyHelper`, and no key exported from the zsh profile. So nothing here forces
API billing. The app's own `.env.local` names `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY`; Next reads that file, the shell does not. `/status` in each of
the three sessions is the confirmation, and only Kiron can run it.

Phase 14 keeps the model and provider behind one adapter either way, so a
supported cheaper route can be switched in without touching the product.

## 7. Task 1.01 — the measured baseline

**For the Executor. No product code changes.**

Outcome: `docs/jarvis/BASELINE.md`, with every number traceable to a command or
a file, so later cycles can prove they made something better.

1. **Toolchain.** `tsc`, the suite the way CI runs it (no `.env.local`,
   CI's placeholder keys, a throwaway VAPID pair), `next build`, and local
   Playwright. Report what runs on this Mac and what only runs in CI.
2. **Spend, read-only from production.** By day, kind and model from 2026-10-07
   to today. Spend on days with no user message. Input, cached and output tokens
   per call for chat and voice. Current cap settings on Heroku, names only, no
   secret values. Use a read-only transaction and prove it is read-only first.
3. **Where a chat call's tokens go.** Build one chat request locally without
   sending it and size each part: instructions, tool schemas, live context,
   history.
4. **Screens.** Workspace, Dashboard (Overview, Board) and Canvas at 390×844
   and 1440×900, from a local build. Screenshots go in
   `~/code/secretary-extras/round-evidence/jarvis-1.01/`, not in the repo.
5. **Hands on the Workspace.** In a real browser at phone width with touch:
   drag a widget, resize one, tick a task, reload. Did each work first try and
   persist? Did any of them make a model call (network log)?
6. **The nine old reports** (§ below): one line each, fixed / still broken /
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

One recorded session, on real data where a connection exists and on fixtures
labelled as fixtures where it does not.

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
- One accepted checkpoint is one cycle. Its final commit is titled
  `v1.NN: …`, has a LOGBOOK entry headed `v1.NN`, sets `package.json` to
  `1.0.NN`, and is tagged `v1.NN` on GitHub once it is on `main`.
- Work in progress and review rounds are not versions. They are commits on the
  task branch titled `WIP 1.NN r1`, `r2`, and they are pushed too.
- The older `v0.xx` entries stay as they are.

## 10. Decisions for Kiron

1. **Background reading: keep it on at $3 a day, or off until it earns it?**
   I recommend off. It was 88 % of the bill and the vision says background work
   needs a visible result. Turning it off is one Heroku setting, yours to run:
   `heroku config:set UNDERSTANDING_DISABLED=true -a secretary-kiron`.
   1.01 will show what it has spent and produced since 10-07 if you would
   rather decide on numbers.
2. **Findit needs a small read-only API** (search, location path, photo) before
   Phase 10. That is work in the Findit repo, for the Findit team. Say when you
   want me to ask them.
3. **Which Claude plan are you on, and does the Console billing page show
   included API credits?** That is the one fact that decides whether the
   subscription can pay for the app (§6).
