# Logbook

A running record of what changed, why, and what it cost. Newest first.

Versions are the session's own numbering, not npm versions. Each entry names the
commits it covers so `git show <hash>` always reaches the real diff.

---

## v0.24 — A spend fail-safe, and alerts (2026-09-25)

this commit

About $40 went overnight with no one using the app. Heroku's log: the Claude
API key hit its monthly spend limit at 08:21 UTC; the understanding run
fell back to OpenAI gpt-5.5 at high effort for the next hour, and Caltrans
failed validation on all three attempts twice (memory ids the model cut
short or mis-dashed; a suggested task with no drop answer) — each attempt a
full, expensive call. OpenAI then ran out of credit too. Earlier the same
UTC day, a ~34-minute voice interview and twelve answers, each re-reading
the project on Opus. Kiron: "If an app spends so much we need a fail safe.
And a way to notify me."

- lib/spend-guard.ts: a 24-hour cap on understanding spend
  (UNDERSTANDING_DAILY_CAP_USD, default $5) checked before every run (skip
  reason `budget`); an alert line on total spend (SPEND_ALERT_USD, default
  $8) checked after every priced call; "<provider> is out of credit" when a
  run or dictation is refused for money. Each is one push a day (push_log).
- Runs no longer fall back to OpenAI mid-flight; they wait for Claude.
- An answer's re-read waits for 90 quiet seconds: an interview sitting is
  one read.
- repair.ts mends a cut-short or mis-dashed id by its first 16 hex digits.

Pushes need Settings → Notifications enabled on the device. 835/835 vitest
(4 new guard tests, 2 new repair tests).

---

## v0.23 — No more "A voice session is already running" (2026-09-25)

this commit

Kiron hit it again on the iPhone. Heroku's router log: a token at 15:48:25
(200), then two more 3.4s apart (429). The first call's setup failed after
the server had opened its session (the OpenAI account was out of credits
again, so the SDP exchange was refused); nothing closed that session, so
each "Try again" was refused as a second concurrent call for five minutes.

- connect(): everything after the token is openPeer(), and a fresh call
  whose setup throws closes its session (`/api/realtime/end`, one second)
  before the error shows. A reconnect keeps its session for the next try.
- checkVoiceQuota: a NEW call replaces an open session older than 20s
  instead of refusing for 5 minutes — one person talks on one device, so a
  row that old is a call that died without reporting. Two starts within 20s
  are still refused.

Checked in the browser with the OpenAI call endpoint blocked: the failed
setup posts /end, and Try again gets a token (200) instead of a 429. 829/829.

---

## v0.22 — The launcher morphs into the pill, and back (2026-09-25)

this commit

Kiron: "the little chat icon on the bottom right basically just morphs into
the UI… the icon fades as it grows out… and when you exit, it morphs back
into that little circle." A proxy shape (docked-chat.tsx, the shared-element
move) animates left/top/width/height/radius from the launcher's measured
rect to the pill's, same black and glow, the icon fading on the way out;
the real card waits invisible underneath, is shown the moment the shape
lands, and the shape fades off it so the contents come up out of the same
black (an earlier cut hid the shape first and the pill blinked pale). Every
close — the pill's x, the card's x — goes through the dock and runs it
backwards into the circle, which then swaps in place. The launcher is now
out of the flow (absolute over the tab bar) so it can always be measured.
The card's old slide-up entrance is gone. Done on transitionend, with a
timer behind it; reduced motion skips it.

Checked: frames captured with CDP Animation.setPlaybackRate 0.12 on the way
in and out; three open/close cycles and an open-then-close-mid-morph at
normal speed end clean (launcher back, no shape left). 829/829 vitest.

---

## v0.21 — CPO packets: documents per step, and Compile PDF (2026-09-25)

this commit

Kiron, after an interview that did not get it: "for each CPO… upload the
documents… STD 65, the seller's permit, ADM 2029 for reconciliation… this
is what I'm missing for each step… compile it in here instead of doing it in
Adobe." SPEC (understanding §6, documents per step) first.

- A process step can name the documents it needs (`steps[i].docs`), set by
  voice or chat: `set_step_documents { process, step, documents[] }`.
  Re-saving a process keeps each step's documents by step name.
- `task_documents` files an attachment against a task under a document name
  (the bytes stay in `attachments`). Names match loosely ("std-65" is "STD
  65"). `file_document` (chat) files the file the user just sent;
  `packet_status` (voice and chat) says what is there and missing.
- The task's detail has a Documents section: per step, each required
  document ✓ or missing with Upload/Add, other files, "Add file" under any
  name, and **Compile PDF** — `GET /api/tasks/:id/packet/pdf`: a cover
  checklist, then every PDF's pages and each image as a page, in process
  order; anything else is named on the cover as not included. Served with
  the attachments' `default-src 'none'` lock, since it is built from uploads.
- The Memory tab shows each step's documents.
- pdf-lib 1.17.1 added (pure JS PDF merge).

Checked: 5 new tests (loose names, missing list, filing, a 3-page compile,
docs kept on re-save); the voice-schema test caught an unbounded `step`
(now max 40). Driven locally: seeded CPO task, upload through the UI, the
detail reads 3/5 with ADM 2029 and the US Bank statement missing, compiled
PDF has 4 pages with the checklist cover. 829/829 vitest, `next build`.

---

## v0.20 — Swipe up on the call pill; no expand, no Minimize (2026-09-25)

this commit

On the iPad a swipe up on the pill during a call did nothing. The call's row
is portaled into the pill (v0.19), and React events from a portal bubble
through the portal's own component tree — the call — never reaching the
chat card's handlers; the pill's touch-none meant the browser did not
scroll either, so nothing moved at all. The pill's swipe now listens with
native pointer listeners, which bubble through the DOM the row actually sits
in. Reproduced first with CDP touch events on a live call (swipe on the call
row stayed "bar"), then fixed: swipe up → full, grabber down → bar, a flick
up on the row → full.

Kiron: "the full screen button and the minimize should not exist… to make it
full screen you just swipe up on the bar itself, and the bar stays all the
way." The call row has no expand button, and with a dock on the page the
call always lives in the card — the separate full-screen call (and its
Minimize) is only the no-dock fallback. The voice / thinking / model menu
lived on that full-screen view; those choices remain in Settings.

Regression run of the non-call gestures (fresh pill → keyboard; send → full;
drag down → pill; swipe up → full; grabber up → full) all pass. 824/824.

---

## v0.19 — A call and a chat are one widget (2026-09-25)

this commit

Kiron: "When voice turns on it's this old ugly interface… merge the two. The
bar to raise and lower is the same; only inside the widget do changes
happen." The minimized call no longer draws its own white pill. The chat
card registers a slot where its composer was (call-slot.ts) and the call
portals its row into it — status, full screen, the live mic, end — so the
dark pill, its grabber, the drag and the conversation above are the same
ones, with the live transcript in the thread. The dock no longer slides away
during a call; Closed reads as the pill until the call ends. No dock on the
page: the old floating pill is the fallback. The interview orb, which draws
its own call, is untouched (`hosted`).

**Found on the way, and fixed:** End pressed while a call was still
connecting left the connect running in the background: the server's
session row never closed, so the next call was refused ("A voice session is
already running") for five minutes. connect() now checks after each await
and closes what it opened (abandonConnect). And a call ended before it
connected was billed from the epoch (startedAt 0) — now one second.

Checked with a real call (fake mic) at 820×1180: the row appears in the pill
("Listening…"), a swipe up opens the card with it at the bottom, End brings
the composer back in ~370ms; End during "Connecting…" leaves a second call
free to start. 824/824 vitest. SPEC §7.7 updated.

---

## v0.18 — A mic button that shows whether the call can hear you (2026-09-24)

this commit

One `LiveMicButton` for every place the call shows mute (the full-screen
call and its minimized pill). Live: accent blue, full size, and it jumps
with your voice — a lift and a scale driven by the MIC level from WebRTC
stats every 70ms (never a Web Audio analyser on the mic; iOS can silence the
sender). Muted: grey, a step smaller, a slashed mic, and still. So if it
moves when you talk, the call hears you. Reduced motion keeps the signal as
a halo that brightens with the voice. The caption says the state ("Live" /
"Muted"); the old icon showed a slashed mic while live, which read backwards.

824/824 vitest; looked at live and muted states on a throwaway preview.

---

## v0.17 — Swiping up on the pill works on a real touch screen (2026-09-24)

this commit

Kiron on the iPad: dragging the open chat down worked, but a swipe up on the
pill did nothing — neither the keyboard with nothing started, nor the
conversation after one was swiped down. iOS read the vertical swipe as a page
scroll and cancelled the pointer. The pill is now `touch-none`, and so is its
field (a textarea is its own scroll container, so an ancestor's touch-action
does not reach through it — a swipe starting on the field was still a
cancelled scroll). A swipe up on the pill grows it back into the
conversation, following the finger, when there is one; with none yet it
raises the keyboard. The grabber's hit area is taller.

Checked with real touch events (CDP) at 820×1180: fresh pill swipe-up
focuses the field; send → full; drag down → pill; pill swipe-up → full;
grabber swipe-up → full. 824/824 vitest.

---

## v0.16 — The secretary can search the web (2026-09-24)

this commit

On a call Kiron asked for "a general Google search of what the dental
provider is for California state workers" and the voice said it could not
search the web. It could not: no tool did. `search_web` (query, optional
context) is now one of Secretary's tools, on the call and in chat alike —
one tool system, not a voice-only feature. It asks gpt-5.4-mini
(`SEARCH_MODEL`) with OpenAI's hosted `web_search` for a spoken-length
answer, strips the inline citation links, and returns the cited pages as
`sources`. Measured about four seconds. The persona says the web is its to
search; the tool description tells the voice to say "one sec, looking that
up" first and name the site the answer came from. Usage is recorded as
`other` (the per-search fee is not priced).

Checked live: the CalHR dental question came back with the plan lineup and
benefits.calhr.ca.gov as the source. 824/824 vitest.

---

## v0.15 — The chat dock, after Gemini in Chrome (2026-09-24)

this commit

From Kiron's screen recording of Gemini in Chrome on the iPad. SPEC §7.7
rewritten first.

**Three states.** Closed is one round launcher at the bottom right, above a
tab bar that now always stays put. Tap it and a floating pill rises: +
(Photos · Camera · Files · Model, the existing Attach sheet), the field,
dictation, the voice call, x. A send, or a drag up on the grabber, grows the
pill into the conversation card over a dimmed page. The card's height
follows the finger (pointer capture on the grabber and header); the
conversation fades as it shrinks and has faded out by halfway; on release it
snaps to the nearer end, and a flick decides by direction. 340ms on the
app's leading curve; reduced motion cuts. Peek is gone.

**One look.** The pill, the card, the launcher and the call are the same
surface: black, `data-theme="dark"`, the accent's inset glow (call-look.ts).
Nothing in the chat keeps the old flat composer.

**Copy and speak on every reply** (message-actions.tsx), typed or spoken,
including the call's latest reply. Speak is `POST /api/speak`:
gpt-4o-mini-tts in the user's realtime voice (marin by default), one reply at
a time, tap again to stop; the tap unlocks the audio element with silence so
iOS will play what arrives after the fetch.

**The voice call.** "Show me" (the transcript toggle) is removed; the
minimize control is a labelled "Minimize" button instead of a bare caret.

Checks: tsc, eslint, 824/824 vitest, `next build`; the dock driven signed in
on the local server at iPad (1180×820) and phone (393×852) sizes — closed,
pill, send → full, mid-drag fade, release → pill; /api/speak returns mp3.

---

## v0.14 — Check-ins, and the Shop out of sight (2026-09-24)

this commit

**Check-ins.** "Weekly status reports are due every Thursday — if I talk to
you on a Thursday, ask me if I sent it. Not a task, not a reminder." New
`standing_checkins` table (question, weekdays in the user's timezone, the
local date last asked) and three tools on chat and voice: `set_checkin`
(same question replaces its days), `remove_checkin`, `checkin_asked`. The
briefing carries CHECK-INS TODAY until the model marks one asked, plus the
standing list; the persona routes "remind me verbally / ask me on X" there
instead of a task. The Memory tab lists them, each deletable.

**The Shop is parked, not deleted.** It had become the answer to anything
Secretary could not do, and its requests were not getting built. Unless
`SHOP_VISIBLE=true` (lib/shop/visible.ts): the model is not handed
`request_capability` / `review_capability`, the persona drops the shop and
says instead to reach for the closest tool it has (a fact, a check-in, a
note) and otherwise say so plainly, the briefing leaves out plans and
outcomes (ABILITIES ALREADY BUILT stays), and Settings hides the section.
Tables, worker and tools remain.

Data: the CPO purchase cycle was saved and "Do the US Bank statement" put on
step 7 through Secretary's own chat (the tools from v0.13), not a script.

Checks: tsc, eslint, 824/824 vitest, `next build`.

---

## v0.13 — Talk to the Interview, and it remembers how your work goes (2026-09-23)

this commit

**Dictation.** "Transcription failed" was the OpenAI account out of credits
(Heroku log: `429 You have no credits remaining`); the route now says so
instead. The dictation bar was redesigned after ChatGPT/Claude: X on the
left, a waveform that scrolls in from the right, Stop (transcribe into the
box) and Send (transcribe and send) together on the right. It also stopped
restarting the recording on every parent re-render. `DictationField` puts the
same bar behind a mic in every answer box (Interview note, opened question,
Write your own), and those boxes grow with the text.

**Corrections are instructions.** "Do the US Bank statement makes no sense"
was filed as a fact and the task stayed. The interpreter now drops or renames
a row the user says is wrong (`rename_task`), and a rename and a step may sit
beside another write on the same row.

**Processes.** The CPO purchase cycle was stored as one flat sentence. A
recurring job described step by step is now a `process` on the interpreter's
output, saved as a `pipeline_templates` row (`save_process`, each step
blocked by the one before). `set_step` puts a task on a step (the steps
become its stages, earlier ones done). Every run and the chat/voice briefing
see PROCESSES; the run may ask "Which step is CPO 2110 on?". Adding processes
to the bundle hash re-reads every project once after deploy.

**Memory tab.** Processes with numbered steps and every memory, newest
first, each deletable in place. Six tabs now share the bar's width.

**Interview orb.** A tap starts the existing call in an `interview` flavor:
the open queue in the tab's order, one question at a time through
`answer_question`, which on that call also returns `next_question`. The orb
breathes with the audio and shows "Thinking…" while a tool runs. Not yet
tried on a live call; a spoken "skip" does not move the card yet.

SPEC: docs/understanding/SPEC.md §5 (three ops), §6 (corrections, processes,
interview call), §9 (orb, Memory). Checks: tsc, eslint, 817/817 vitest,
`next build`.

---

## v0.12 — The agent guide (2026-09-16)

this commit

Documentation only. `docs/secretary-agent-guide.md` is the first canonical
guide to what Secretary is meant to be and what the repository actually
holds: mission and JARVIS-as-the-bar, the persona as the code enforces it,
where live data lives and how it is read, a Project Intelligence contract
(durable per-project record with attempts and a resume pointer — designed
here, not yet in the schema, with an interim `memories` tagging convention),
answer patterns for the four core questions, Canvas rules against the
unfixed defect list, approval and truthfulness policy, delegation, runtime
boundaries, and a draft OpenClaw configuration that names the agent
Secretary and is explicitly not created. Every state claim carries evidence
from four read-only surveys of the tree at `70df98d`; all 29 cited commits
and all cited paths were checked to exist. Also recorded: v13 (2026-09-16)
set the eleven config vars including `ADAPTIVE_V2` and `SHOP_DISABLED`, so
the adaptive dashboard is live on Heroku for the first time.

---

## v0.11 — One deployer, CI that runs, a release phase that applies (2026-09-15)

`5d0549c` (committed as "test line", pushed 15:18) and this commit

**The dashboard GitHub integration is the deployer; the workflow is its CI.**
The link had been re-pointed from `personal-assistant` to `secretary` at 10:03
(the OAuth popup loops in Firefox *and* Safari, but the backend link is created
anyway — the page just never shows it). It was removed at 13:45 via
`DELETE kolkrabbi.heroku.com/apps/<id>/github`, then Kiron re-created it at
15:20 with automatic deploys on. Fine — but only one thing may deploy, so the
workflow's deploy job stays gated off (`DEPLOY_ENABLED` unset, no
`HEROKU_API_KEY`), and "Wait for GitHub checks" has to be ticked or the
dashboard deploys unverified pushes. README, CLAUDE.md and the handoff say so.

**CI had never gone green.** All four runs of `deploy.yml` failed at `Tests`:

- `BETTER_AUTH_SECRET` was unset, so `lib/crypto.ts` threw in the three
  connected-account encryption tests.
- No VAPID pair, so `scanDueReminders` returned 0 before touching the
  database and the just-due reminder test claimed nothing. `web-push` validates
  key format, so a placeholder string is not enough; the workflow now generates
  a throwaway pair per run and exports it through `$GITHUB_ENV`.

Both reproduced locally by running the two files with `.env.local` masked and
only CI's values present, and both pass with the fix. Run 35030287366 on
`5d0549c` is the first green run — and the first time `next build` ran in CI.

**Heroku auto-deployed that commit (v9, 15:28) and the release phase did
nothing.** The dyno is up and `/` answers, but every sign-in 500s:
`column "calm_mode" does not exist`. `heroku releases:output v9` shows why:
`drizzle-kit push` introspected the two views Heroku's `pg_stat_statements`
extension keeps in `public`, found them absent from the schema, emitted
`DROP VIEW`, and Postgres refused (`extension pg_stat_statements requires it`).
drizzle-kit exited 0 anyway, so Heroku called the release good. The database
stayed at 16 tables. Fix: `tablesFilter: ["!pg_stat_statements",
"!pg_stat_statements_info"]` in `drizzle.config.ts` — drizzle-kit 0.31 applies
that filter to views as well as tables (`bin.cjs:18114`).

Verified three ways on a scratch database, never against production:

- Two dummy views with those names: the old config drops them, the new one
  leaves them and creates all 29 tables; a second run reports no changes.
- **The release-phase plan, dry-run against Heroku's exact schema** (the
  Aug 12 deploy `b741ed18`: 16 tables, no `calm_mode`) plus the two views:
  13 `CREATE TABLE`, 18 `ADD COLUMN`, 2 indexes, 16 foreign keys, and **no
  DROP, no type change, no NOT NULL without a DEFAULT**. It is additive; it
  will apply to populated tables. That is handoff step 4, done offline.

**The cutover itself.** `cf23263` pushed 15:59, CI green 16:02, v10 live and
`Changes applied` by 16:04 — Heroku at 29 tables. Backup `b037` at 16:05. Then
the new `scripts/copy-db.ts` — every public table from `information_schema`,
insertion order from the target's own `pg_constraint`, self-references in
waves, every value read as text and written back with an explicit cast, one
transaction with counts verified before COMMIT, and a refusal if the two
schemas differ — copied **1,993 rows across 29 tables** into Heroku at 16:07.
Rehearsed first local → scratch: counts matched, a column-order-independent
content hash (`row_to_json → jsonb`) matched on all 29 tables, the abort path
left a target untouched when a table was missing, and a second run was
idempotent. `sync-to-heroku.mjs` is deleted. Config vars are still Kiron's
one-liner (the classifier refuses secret writes); until then the brain falls
back to OpenAI and the dashboard is v0, but the app is up with all the data.

One consequence to know about: the 02:00 launchd job
`com.kironkp.secretary-nightly-push` runs `git push origin main`, and `main`
now auto-deploys. A commit left on local `main` ships overnight.

**Data, for the record.** The nightly local → Heroku sync last succeeded on
2026-08-18 and has failed 28 nights running since 2026-08-19 (`column
"calm_mode" of relation "user" does not exist` — local grew a column Heroku
never got, because nothing was deployed after 2026-08-12). So Heroku holds
local's data as of August 18 for 16 of 29 tables; local has 102 tasks, newest
2026-09-10, across 29 tables. Steps 2–5 of the handoff — backup, the sixteen
config vars, reading the `drizzle-kit push` plan, the one-time migration —
still come before the first automatic deploy is allowed to land.

---

## v0.10 — The flaw audit (2026-09-15)

`57ac051` and this commit

No behaviour changed. A three-agent adversarial audit read the canvas renderer,
the cost architecture and the verification/ops surface, and every claim below
was then confirmed by hand against source or a live command.

**It found the canvas bugs that four rounds of fixes missed**, because all four
targeted the wiring and the real defects are in layout and touch:

- **No `<meta name="viewport">` in the canvas srcdoc** (`sanitize.ts:213-216`).
  iOS therefore applies its legacy ~350 ms tap delay and double-tap-to-zoom.
  Invisible in jsdom and in desktop Chrome — which is why it survived four
  attempts. This is the best single explanation for "I still can't check things
  off" on the phone.
- **The checkbox is 18×18 px** (`sanitize.ts:241`) — under half the 44 pt
  minimum — sitting on a row that carries `data-link`, so a near-miss doesn't
  do nothing, it **navigates away from the canvas**.
- **Voice reorder reloads the board.** `canvas-view.tsx:10-13` documents "DOM
  ORDER NEVER CHANGES"; line 529 maps `blocks` in composition order, so a move
  reconciles keyed holders with `insertBefore` and every iframe below the moved
  one re-navigates. The flagship no-model-call operation blanks the board.
- **Every block is clipped by 24 px.** The iframe carries Tailwind `p-3`
  (`:556`) while `measure()` writes content height into `style.height` (`:196`),
  so the viewport is permanently 24 px shorter than its content — and short
  blocks staircase-shrink 24 px per 500 ms tick.
- **Direct manipulation does not exist**: zero `pointerdown`/`touchstart`
  handlers anywhere in `components/canvas` or `lib/canvas`.

**It found that the cost number being steered by is wrong.** 53 of 58 voice
rows are flagged `cost_estimated` and priced as 100 % audio at $32/M when most
of those tokens are cached text at $0.40/M; five more are NULL and read as
$0.00. Anthropic caching is real but capped at 59.8 % because
`briefing.ts:286-294` bakes the current **minute** into the top of the system
block, invalidating that breakpoint every 60 seconds.

**It found production down.** Heroku release v8 deployed commit `9701f7d9` —
not an object in this repository — from the dashboard integration still pointed
at `kironkp/personal-assistant`. `web.1: crashed`, `npm error Missing script:
"start"`, the URL returning **503**, unnoticed for 25 minutes.

**And it found why all of this reaches the user instead of CI:** 47 test files,
exactly one opts into jsdom, `vitest.config.ts` does not even match `.tsx`, no
React component is ever rendered by a test, 3 of 29 API routes are covered,
`canvas-invariants.test.ts` asserts by grepping source strings, and the only
end-to-end harness has been switched off since 11 August (`sim/.disabled`).

Full detail, with fixes, in `docs/HANDOFF.md`.

---

## v0.9 — Deployment moves to CI (2026-09-15)

`a7bbd04`

**Heroku becomes the source of truth; the Mac becomes beta.** This reverses the
architecture the README had described since August.

- `.github/workflows/deploy.yml` — CI on every push and pull request (Postgres
  service, schema push, tsc, lint, 439 tests, production `next build`), then a
  deploy job gated three ways: push only, `main` only, and the repo variable
  `DEPLOY_ENABLED == "true"`. It finishes by asking Heroku what the dyno is
  actually doing, because a green deploy step only means the slug built.
- CI sets a placeholder `OPENAI_API_KEY`. The tests never call a provider, but
  `lib/openai.ts` builds its client at module load and the SDK throws on a
  missing key — without it nothing imports.

**Found and defused:**

- A launchd job (`com.secretary.dailysync`, 03:00 daily) that **overwrote the
  Heroku database with local data**. Harmless when local was truth; catastrophic
  the moment Heroku is. Unloaded, plist renamed `.disabled`.
- Heroku's dashboard GitHub integration was connected to
  **`kironkp/personal-assistant`** — an unrelated repo last touched in January,
  with no `start` script. Its single auto-deploy (v8) crash-looped on
  `npm error Missing script: "start"`. This repo's remote is `kironkp/secretary`.

**Still outstanding:** 16 config vars missing on Heroku, its database holds
August data (25 tasks vs 102 local), and two schema migrations ride the first
real deploy. See `docs/HANDOFF.md`.

---

## v0.8 — Canvas checkboxes, four attempts (2026-09-09)

`85e56f5`, `817f4f4`, `ced18a3`

The worst sequence of the session, and worth reading as a cautionary tale. The
user reported checkboxes unusable; it took three separate root causes and the
result was **still not confirmed working**.

1. **`85e56f5` — the momentum guard ate every click.** The canvas re-measures
   blocks after load; each measurement changes the board height, which changes
   document height, which fires page `scroll` events. The scroll-stop guard
   listens in the capture phase, so it reported "momentum in flight" almost
   continuously and swallowed clicks before the checkbox was hit-tested. The
   guard was added in the *same change* as the checkbox — self-defeating.
2. **`817f4f4` — the wiring loop cancelled itself.** The interval that attaches
   click handling lived in an effect keyed on `wireAll`, whose identity changes
   every `measure → layout → setBoardH` render. It was torn down and rebuilt
   before its 300 ms tick could fire, leaving `onLoad` as the only attempt —
   and when that fires against the initial `about:blank` document, nothing is
   ever wired to the document the user sees.
3. **`ced18a3` — no un-check path.** A ticked box was inert; an accidental tap
   was permanent. Now toggles both ways, optimistic in both directions.

**Also:** `lib/canvas/interaction.ts` extracted so the click path is testable at
all (jsdom), `scripts/canvas-reset.ts` to rebuild a canvas from live task data
with no model call, and `docsWired` / `checksFired` counters behind `?perf=1` so
the next failure is diagnosable from the device instead of by inference.

**The lesson, recorded because it recurred:** 439 passing tests, clean tsc, lint
and build said nothing about whether a human could tick a box. See
`docs/HANDOFF.md` §"Why bugs keep reaching you".

---

## v0.7 — Cost becomes first-class (2026-09-09)

`fbf3a5c`, `72f04b7`, `f35bc6b`

**The measurement.** $75.19 over six weeks — voice $47.06, chat $21.35,
extraction $6.31. Three of the most expensive paths recorded *nothing*: canvas
paints, the dashboard planner (silently since 2026-08-18, the day ADAPTIVE_V2
shipped), and email attachment reading.

- `lib/pricing.ts` — dated rate cards, per-token / per-minute / per-character as
  part of the type, and an unknown model priced at the ceiling rather than $0.00
  (silent zero is how spend goes missing).
- `lib/usage.ts` — one recorder, so a new call site has one obvious thing to call.
- Cost computed at insert and stored, so a rate change never rewrites history.
- `scripts/backfill-usage-cost.ts` priced 396 existing rows.
- Spend panel in Settings with 1/7/30-day toggles and swipe between specific
  days, weeks and months, in **local calendar** windows (DST-correct).

**`72f04b7` — the actual leak.** One chat turn runs up to 8 tool rounds, each
re-sending an identical 24,387-token prefix (tool schemas ~9.5k, briefing ~3.5k,
persona ~2.6k). History was NOT the problem — the largest thread is ~970 tokens.
Anthropic prompt caching added and **verified against the live API**: round 1
writes 24,387, rounds 2+ read all 24,387. A 3-round turn goes ~$0.73 → ~$0.35.

**Untouched:** the OpenAI path has no caching, tool schemas are still sent in
full, the briefing still dumps every open task, and deterministic CRUD still
runs the tool loop.

---

## v0.6 — The Canvas becomes a workspace (2026-09-09)

`203b5c0`, `8f9f1c8`, `ac1c559`

The architectural change the user asked for: *"stop thinking of Canvas as a
picture, start thinking of it as a board."*

- **`203b5c0`** — `lib/canvas/blocks.ts`: segment sanitized markup into
  addressable blocks, verify (one balanced root, by tag-name stack — counting
  depth alone waves through mis-nested fragments that re-parent their siblings
  when spliced), compose, replace-by-id, move. Painter prompt now emits separate
  top-level blocks with stable kebab-case ids. Before this, **all 10 live
  canvases were one wrapper `<div>` with zero ids** — nothing was addressable.
- **`8f9f1c8`** — composition stored as jsonb: blocks + geometry + theme. The
  shell owns order, span, visibility and type scale; the model owns each block's
  fill. `arrange_canvas` voice tool (move/resize/hide/show/remove/set_theme) is
  pure data — **no model call, no repaint**. One sandboxed document per block,
  positioned by transform so DOM order never changes and nothing remounts.
- **`ac1c559`** — shared world model (`lib/canvas/focus.ts`): one interaction
  state both voice and touch write, so tapping a card is what "make this bigger"
  means a second later. Deterministic reference resolution for "that", "the
  other one", "the top one", "the Caltrans one". Geometry undo/redo. `?perf=1`
  instrumentation.

---

## v0.5 — Canvas edits stop destroying the canvas (2026-09-09)

`cad3365`

`edit_canvas` existed but was **missing from `VOICE_TOOL_NAMES`**, while
`persona.ts` explicitly instructed the model to call it. So every spoken change
fell through to `paint_canvas`, which receives no copy of the current canvas and
therefore painted a *different* one. Exactly the user's complaint: "I ask to add
one thing and it restarts from scratch."

Also: a canvas operation no longer blanks the canvas (new snapshot seeded with
what is on screen; an edit holds it until the replacement completes; only a
completed stream may be committed), and the shell refreshes immediately instead
of waiting out a 15-second poll.

**Attachments** in the same commit: any file type uploads and pastes. Serving
became the security boundary rather than the upload allowlist — only raster
images and PDF are served renderable, everything else is octet-stream +
attachment with a strict CSP. Extracted file text is fenced as untrusted data
(and a real prompt-injection hole in the email fence was closed: a body
containing the terminator could close its own fence).

---

## v0.4 — Fixes found by adversarial review (2026-09-09)

`bc1c079`, `9490d6b`, `1544c3e`, `a4892ac`, `5290799`

- **`bc1c079`** — hydration mismatch on *every* dashboard load: the five-week
  timeline positioned markers as a fraction of a 35-day horizon from
  `Date.now()`, so server and client differed by microscopic amounts
  (`40.474362%` vs `40.4743322420635%`). Clock quantized to the day.
- **`9490d6b`** — build broke because a client component imported a value from a
  module that imports the database (`pg` → `node:dns`). tsc, lint and 411 tests
  all passed; only `next build` sees it.
- **`1544c3e`** — voice calls dead because the transcription lexicon grew past
  the API's hard 1,024-character limit (it had reached 1,197). **Not a code
  change — the entity store simply grew.**
- **`a4892ac`** — the Shop filed the same ability four times under four
  phrasings, twice after it had shipped, because dedupe compared exact strings
  and the briefing only surfaced shipped work from the last 36 hours. Now fuzzy
  dedupe plus a durable "abilities already built" list.
- **`5290799`** — chat dock: caret moved right, peek reduced to the single
  latest message.

---

## v0.3 — Voice register (2026-09-08)

`4ab535a`, `ed4afcc`

Shop-built: the assistant explains *why* something is blocked instead of reading
a status word, and speaks like a person on a call.

---

## Earlier

Before this logbook, see `git log` and `docs/adaptive-ui/SPEC.md`. The adaptive
dashboard (LayoutPlan) track completed 2026-08-19.
