# Handoff — 2026-09-15

Read this before writing any code.

The user's verdict on this build, verbatim:

> **"The flaws are horrendous. Canvas is virtually unusable."**

He is right. Take it at face value. This document is written against that, not
in defence of the code. Most of what follows was found by living the failures,
not by reading the diff.

---

## The single most important thing

**Nothing in the Canvas interaction layer has ever been verified in a real
browser.** There was no browser automation available in the session that built
it. Every "verified" claim in the git history means: TypeScript compiled, ESLint
passed, 439 vitest tests passed, and `next build` succeeded.

None of those can see layout, event delivery, stacking, hit-testing, or whether
a human can tick a box.

That gap produced, in one session:

| Reported as green | What the user found |
|---|---|
| 439 tests, tsc, lint, build all clean | Canvas checkbox did nothing — **four separate attempts** |
| Same | Voice calls dead (tool schema the Realtime API rejects) |
| Same | Voice calls dead again (transcription prompt over a hard API limit) |
| Same | A hydration error on **every** dashboard load |
| 411 tests, tsc, lint clean | Production build failed outright |

**Do not report a UI fix as done on the strength of the test suite.** Either get
browser automation working, or hand the user one specific thing to tap and say
plainly that it is unverified until they do.

---

## Canvas — why it is unusable

### 1. The checkbox may still not work

Three real causes were found and fixed. The user's last report was still "it
doesn't work", and it was never confirmed afterwards.

- **The momentum guard ate every click** (`85e56f5`). Board re-measurement
  changes document height → fires page `scroll` events → the capture-phase
  scroll-stop guard reported "momentum in flight" almost continuously and
  swallowed clicks. The guard was added in the *same commit* as the checkbox.
- **The wiring loop cancelled itself** (`817f4f4`). The interval attaching click
  handling lived in an effect keyed on `wireAll`, whose identity changes every
  `measure → layout → setBoardH` render. It was destroyed and rebuilt before its
  300 ms tick could fire, leaving `onLoad` as the only attempt — and when that
  fires against the initial `about:blank` document, nothing is ever wired to the
  document the user sees.
- **No un-check path** (`ced18a3`). A ticked box was inert.

**First action for the next session:** have the user open
`/canvas?perf=1`, tap a checkbox, and read the `wired / taps` counter.
`0 docs` = nothing attached. `N docs · 0 taps` = attached but the tap never
arrives (layout / hit-testing). `N docs · 1 taps` = the click works and the
server call is the problem. That one number ends four rounds of guessing.

### 2. The renderer is structurally fragile

`components/canvas/canvas-view.tsx` runs a feedback loop:
`measure()` → `layout()` → `setBoardH()` → render → `measure()`.

- Heights are unknown until each iframe loads, so layout uses a **120 px
  estimate** (`heights.current.get(b.id) ?? 120`). Blocks are positioned by
  prefix-sum, so every block below a wrong estimate is wrong too — and the
  holder is `overflow-hidden`, so an under-measured block is **clipped**.
- Every re-measure fires `setBoardH`, which changes document height, which
  fires scroll events. That is what broke the checkbox, and the loop is still
  there — only the checkbox was exempted from the guard.
- If a document never loads, or fonts shift height after load, there is no
  `ResizeObserver` — only a one-shot `setTimeout(measure, 350)` and the 500 ms
  re-wire interval.

This is the area most likely to be the real cause of "virtually unusable", and
it deserves a rethink rather than another patch.

### 3. Most of the endorsed design was never built

The target is the **`canvas-board` design artifact**, which the user endorsed.
Against it:

| Promised | Reality |
|---|---|
| Tap a checkbox to tick it | Built, unverified in a browser |
| Say "move the album up" → it moves | Built (`arrange_canvas`), unverified |
| **Drag a block with your finger** | **Never built** (was "phase 5") |
| **Resize by touch** | **Never built** |
| **Reorder animates** with the app's motion language | Code exists, never seen working |
| **One widget regenerates, others untouched** | **Never built** — `edit_canvas` still regenerates the whole canvas via `paintCanvas` |
| "It shouldn't look the same every time" | Unproven since the painter changed |

So "direct manipulation" currently means: voice commands and one checkbox.

### 4. The SPEC no longer describes the code

`docs/adaptive-ui/SPEC.md` has **zero** mentions of the composition model,
`arrange_canvas`, or the workspace architecture that now exists. The SPEC was
supposed to be rewritten before that work landed (CLAUDE.md requires spec-first)
and it wasn't. Treat the SPEC as historical for the Canvas until reconciled.

---

## Cost — half-finished

The user made this a first-class requirement. Measured: **$75.19 over six
weeks** (voice $47, chat $21). The static prefix of a chat turn is **24,387
tokens** and a turn runs up to **8 tool rounds**, each re-sending it.

**Done:** Anthropic prompt caching, verified against the live API (round 1
writes 24,387, rounds 2+ read all of it). Full spend tracking with a dated
pricing table, cost stored at insert, and a Settings panel with day/week/month
navigation.

**Not done — and this is the bigger half:**

- **The OpenAI path has no caching at all.** Same 8-round loop, uncached.
- **Tool schemas are ~9,500 tokens on every request** (61% of the prefix), all
  47 tools, regardless of what the turn needs.
- **The briefing dumps every open task** on every turn instead of retrieving.
- **Deterministic CRUD still runs the tool loop.** "Add a task to call John
  tomorrow" should be a database write once the fields are known.
- **Voice cost is an estimate**, not a fact: the audio/text token split is not
  recorded, and audio input costs 8× text under the same model id. The $47 is
  an upper bound.

---

## Heroku is now the source of truth — and the cutover is incomplete

As of 2026-09-15 **Heroku is production; the Mac is beta/dev only.**

**Disabled, must stay disabled:** the launchd job `com.secretary.dailysync`
(03:00) ran `scripts/sync-to-heroku.mjs`, which **overwrites the Heroku database
from local**. Correct when local was truth; it would now destroy production
every night. Plist renamed `.disabled`.

**Before Heroku can actually take over:**

1. **16 config vars are missing** there, including `ANTHROPIC_API_KEY`,
   `CLAUDE_BRAIN`, `ADAPTIVE_V2`, `VAPID_*`, `INBOUND_EMAIL_*`. Without
   `ADAPTIVE_V2` the dashboard silently falls back to the old v0 renderer.
2. **Its database holds August data** — 25 tasks against 102 locally, newest
   task Aug 13. A one-time local → Heroku migration is needed, then never again.
3. **Two schema migrations** ride the first real deploy (canvas `composition`,
   usage cost columns) via the Procfile release phase. Back up first:
   `heroku pg:backups:capture -a secretary-kiron`.
4. **Deploy is gated OFF.** `.github/workflows/deploy.yml` needs the repo secret
   `HEROKU_API_KEY` and the repo variable `DEPLOY_ENABLED=true`.
5. **Disconnect Heroku's dashboard GitHub integration.** It was pointed at
   `kironkp/personal-assistant` — an unrelated January repo with no `start`
   script — and its one auto-deploy crash-looped. While connected it will keep
   deploying the wrong repo.

**What cannot move to Heroku:** the Shop spawns headless Claude Code against
this checkout, and the sim harness boots a second Next server. Both stay on the
Mac and will need to point at the Heroku database once it is authoritative.

---

## Operational landmines

- **`lib/auth.ts` is deliberately never committed.** It carries a dynamic
  auth `baseURL` for rotating tunnel hostnames. Every commit in this repo
  excludes it (`git add -A ':!lib/auth.ts'`). It is not in git — if the folder
  is lost, that file is lost.
- **Tunnel URLs rotate** on every `cloudflared` restart. Each rotation needs the
  new callback added in Google Console. `TRUSTED_ORIGINS` already has a
  `*.trycloudflare.com` wildcard, so nothing else changes.
- **`next dev` must be started with stdin held open** or Next 16 exits:
  `nohup sh -c 'exec npx next dev < /dev/zero' &`.
- **Local Postgres** runs from `scripts/local-postgres.mjs` on :5432 with a
  relative `./.pgdata`. Other projects use 5433/5434 — don't collide.
- **`find` and `grep` are broken in this shell** (a dyld error from a CLI
  shim). Use `/usr/bin/find` and `/usr/bin/grep`, or the Read/Grep tools.
- **No `pg_dump`** on this machine. Use `scripts/db-backup.ts` (JSON snapshot of
  every table) before any schema change — there are no migration files to roll
  back with.
- **`scripts/canvas-reset.ts`** rebuilds a canvas from live task data with no
  model call. Useful for getting a known-good canvas to test interaction
  against.

---

## Suggested order

1. **Prove or fix the checkbox in a real browser.** Nothing else matters until
   the workspace is trustworthy. Get browser automation working if at all
   possible — it is the root cause of this entire session's pain.
2. **Rethink the height/layout loop** rather than patching it again.
3. **Finish the cost work** — OpenAI caching, narrow the tool schemas, targeted
   retrieval, a deterministic CRUD path.
4. **Complete the Heroku cutover** in the order above.
5. Only then: drag/resize, per-widget regeneration, Hume.

## What to read next

- `docs/LOGBOOK.md` — what changed this session, per version, with commit hashes
- `CLAUDE.md` — the standing rules and the JARVIS north star
- The `canvas-board` design artifact — the endorsed target for the Canvas
