# Logbook

A running record of what changed, why, and what it cost. Newest first.

Versions are the session's own numbering, not npm versions. Each entry names the
commits it covers so `git show <hash>` always reaches the real diff.

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
