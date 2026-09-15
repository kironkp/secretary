# Handoff — 2026-09-15

Read this before writing any code.

The user's verdict on this build, verbatim:

> **"The flaws are horrendous. Canvas is virtually unusable."**

He is right. Take it at face value. This document is written against the code,
not in defence of it. Everything below was verified — file, line, or live
command — not inferred.

---

## Do these three things first

1. **Production is down.** Heroku is crash-looping on a deploy of a *different
   repository*. See §Heroku. Fix before anything else.
2. **Fix the canvas viewport and hit target** (§Canvas 1). Two small changes that
   are the most likely explanation for four failed rounds of "the checkbox
   doesn't work."
3. **Get a real browser into the loop.** Everything in §Why bugs keep reaching
   you follows from its absence.

---

## The single most important thing

**Nothing in the Canvas interaction layer has ever been verified in a real
browser.** There was no browser automation in the session that built it. Every
"verified" claim in the git history means: TypeScript compiled, ESLint passed,
439 vitest tests passed, `next build` succeeded.

None of those can see layout, event delivery, stacking, hit-testing, touch
behaviour, or whether a human can tick a box.

That gap produced, in one session:

| Reported as green | What the user found |
|---|---|
| 439 tests, tsc, lint, build all clean | Canvas checkbox did nothing — **four separate attempts** |
| Same | Voice calls dead (tool schema the Realtime API rejects) |
| Same | Voice calls dead again (transcription prompt over a hard API limit) |
| Same | A hydration error on **every** dashboard load |
| 411 tests, tsc, lint clean | Production build failed outright |

**Do not report a UI fix as done on the strength of the test suite.**

---

## Canvas — why it is unusable

Four rounds of fixes all targeted the *wiring* (does a click handler exist and
fire?). The wiring is now correct and provably so in jsdom. The remaining
defects are in **layout, touch, and rendering** — layers the test suite cannot
see, which is exactly why they survived.

### 1. Two defects that likely explain "it doesn't work" on the phone

**No viewport meta in the canvas iframe.** `lib/canvas/sanitize.ts:213-216`
builds the srcdoc head with `charset` and a CSP and nothing else. With no
`<meta name="viewport">`, iOS Safari treats the frame as a legacy desktop page:
it applies the **~350 ms tap delay** and waits to see whether the tap is the
first half of a double-tap-to-zoom. Taps land late, or get discarded during
scroll settle. This is invisible in jsdom and invisible in desktop Chrome —
which is precisely why four fix attempts never found it.

```html
<meta name="viewport" content="width=device-width,initial-scale=1">
```
plus `touch-action:manipulation` and `-webkit-tap-highlight-color:transparent`
in the canvas stylesheet.

**The checkbox is an 18×18 px target.** `lib/canvas/sanitize.ts:241` —
`.cv-box{position:absolute;left:8px;top:calc(50% - 9px);width:18px;height:18px;…}`.
Apple's minimum is 44 pt; this is under half of it, with no enlarged hit area.
And the row underneath carries `data-link`, so **a 10 px miss doesn't do
nothing — it navigates away from the canvas entirely**, which reads to the user
as "it did something random." Give it a transparent expansion:

```css
.cv-box::before{content:'';position:absolute;inset:-13px}
```

Neither of these could ever be caught by `tests/canvas-interaction.test.ts`:
jsdom has no layout engine, so every element is 0×0 and every dispatched click
hits whatever you handed it.

### 2. Voice reorder reloads the entire board

`components/canvas/canvas-view.tsx:10-13` documents the invariant *"DOM ORDER
NEVER CHANGES"* — blocks are positioned by transform so that moving one is pure
data with no remount. **The code does not implement it.** Line 529 renders
`blocks.map(...)` in *composition* order, so when `arrange_canvas` moves a
block, React reconciles the keyed holders with `insertBefore` and **every iframe
from the moved position downward re-navigates its srcdoc.**

So the flagship "no model call, instant, nothing repaints" operation — say
"move the album up" — blanks most of the board and reloads it. That is the
single worst-feeling bug in the product and it contradicts a comment written
directly above it.

**Fix:** render holders in an order that never changes (sort by block id, or
keep an append-only mount list), and derive `x`/`y`/`z` purely from a separately
read composition order. Then a move is a transform change and nothing remounts.

### 3. Every block is clipped by 24 px

The iframe carries Tailwind `p-3` (`canvas-view.tsx:556`) — 12 px of padding on
every side. Under `border-box`, that padding is *inside* the element's height.
`measure()` reads the document's content height and writes it straight to
`frame.style.height` (`:196`), so the usable viewport is always **24 px shorter
than the content it must show.**

Consequences, both of which the user sees:
- The last row of every list is cut off — permanently, on every block.
- Because the frame is re-measured every 500 ms and each measurement feeds the
  clipped height back in, short blocks **staircase-shrink by 24 px per tick.**

**Fix:** drop `p-3` from the iframe (put the inset in the srcdoc's own body
padding, which `measure()` already accounts for), or add the padding back when
writing the height. Prefer the former.

### 4. Direct manipulation does not exist

`/usr/bin/grep -rn "pointerdown\|touchstart" components/canvas lib/canvas`
returns **zero matches**. There is no drag, no touch-resize, no long-press.
Blocks also default to `span: "full"`, so the "board" renders as a
single-column vertical scroll — visually the same thing it replaced.

Against the **`canvas-board` design artifact** the user endorsed:

| Promised | Reality |
|---|---|
| Tap a checkbox to tick it | Wired correctly; blocked by §1 |
| Say "move the album up" → it moves | Built, but §2 reloads the board |
| **Drag a block with your finger** | **Never built** |
| **Resize by touch** | **Never built** |
| **Reorder animates** | Code exists, never seen working |
| **One widget regenerates, others untouched** | **Never built** — `edit_canvas` still repaints everything via `paintCanvas` |
| "It shouldn't look the same every time" | Unproven since the painter changed |

So "direct manipulation" currently means voice commands and one checkbox.

### 5. The renderer's feedback loop is structurally fragile

`measure()` → `layout()` → `setBoardH()` → render → `measure()`, forever, on a
500 ms interval for the life of the mount.

- Heights are unknown until each iframe loads, so layout uses a **120 px
  estimate** (`heights.current.get(b.id) ?? 120`). Blocks are prefix-summed, so
  one wrong estimate misplaces everything below it — and the holder is
  `overflow-hidden`, so an under-measured block is clipped.
- Every re-measure changes document height, which fires page `scroll` events.
  That is what broke the checkbox originally (`85e56f5`); the loop is still
  there, only the checkbox is exempted from the guard.
- No `ResizeObserver`. If fonts shift height after load, nothing notices.
- `canvas-view.tsx:275` calls `wireCanvasDocument(doc, {...})` and **discards the
  returned teardown**, so the tested cleanup path is dead code in production.

This deserves a rethink, not a fifth patch.

### 6. The SPEC no longer describes the code

`docs/adaptive-ui/SPEC.md` has **zero** mentions of the composition model,
`arrange_canvas`, or the workspace architecture that now exists. CLAUDE.md
requires spec-first; that was not followed. Treat the SPEC as historical for the
Canvas until reconciled.

---

## Why bugs keep reaching you — the verification gap

This is the root cause of the entire session's pain, stated plainly:

- **47 test files. Exactly one opts into jsdom.** `vitest.config.ts:12-13` sets
  `environment: "node"` and `include: ["tests/**/*.test.ts"]` — `.tsx` is not
  even matched, so a component test *could not run if someone wrote one*.
- **No React component is ever rendered by any test.**
- **3 of 29 API routes have any coverage.**
- `tests/canvas-invariants.test.ts` asserts by **grepping source strings** — it
  checks that code *looks* right, not that it *behaves* right.
- **The only end-to-end harness has been switched off since 11 August**
  (`sim/.disabled`, 0 bytes, created Aug 11 17:20; the post-commit hook exits
  when it exists).

So "439 tests pass" is a true statement about `lib/`, and every bug the user hit
lives in the layer the suite does not execute.

**What to do:**

1. `vitest.config.ts` → `include: ["tests/**/*.test.{ts,tsx}"]` plus
   `environmentMatchGlobs: [["tests/**/*.dom.test.*", "jsdom"]]`.
2. Add Playwright to the CI verify job (the ubuntu runner has a browser; this
   Mac cannot drive one) with an **iPhone device profile**. One test: load the
   canvas, tap a checkbox, assert the PATCH fired and the row flipped. That
   single test covers the bug that shipped four times.
3. Add `scripts/preflight-voice.ts` that builds the **exact** session body the
   route sends, for a real user, and POSTs it to the Realtime endpoint. Both
   voice outages were "the data grew past a provider limit" — nothing static can
   catch that, but one command can, and it runs fine on the Mac.
4. Route-handler tests for the 26 uncovered API routes.

---

## Heroku — production is down RIGHT NOW

As of 2026-09-15 **Heroku is production; the Mac is beta/dev only.** The cutover
is incomplete and the current state is broken.

**Verified live at 10:50 PDT today:**

```
web.1: crashed 2026/09/15 10:19:40 -0700
npm error Missing script: "start"
release v8 — "Deploy 9701f7d9" — 2026/09/15 09:58:30
https://secretary-kiron-606a3b1e1a65.herokuapp.com/  →  503
```

`git cat-file -t 9701f7d9` → **`Not a valid object name`**. That commit is not in
this repository. Heroku's dashboard GitHub integration deployed it from
`kironkp/personal-assistant` — an unrelated January repo with no `start`
script — at 09:58, and the app has been 503 ever since. At 10:03 the link was
re-pointed at `kironkp/secretary` (auto-deploy off, so it never deployed
anything), and at 13:45 it was removed via Heroku's API
(`DELETE https://kolkrabbi.heroku.com/apps/<app-id>/github`). At 15:20 Kiron
re-created it from the dashboard, pointed at `kironkp/secretary` `main` with
**automatic deploys ON**. That is now the deploy path: the workflow verifies,
the dashboard deploys once GitHub checks pass. Until "Wait for GitHub checks"
is ticked it deploys every push to `main` immediately, tests or not.

**Update 15:45:** v9 (`5d0549c`) auto-deployed at 15:28 and the dyno is up,
but **sign-in 500s** — `column "calm_mode" does not exist`. The release phase
ran and applied nothing: `drizzle-kit push` tried to `DROP VIEW` the two
`pg_stat_statements` views Heroku's extension owns, Postgres refused, and
drizzle-kit exited 0 regardless. Fixed by `tablesFilter` in
`drizzle.config.ts` (see step 4); the next deploy migrates the schema.

**Order of operations:**

1. ~~**Disconnect the dashboard integration**~~ **Superseded 2026-09-15.**
   It was removed at 13:45 and deliberately re-created at 15:20 pointing at
   the right repo. Decision: **the dashboard integration deploys; the workflow
   is the CI it waits on.** Two things follow. (a) "Wait for GitHub checks to
   pass before deploy" must be ticked, or every push to `main` deploys with no
   gate. (b) `DEPLOY_ENABLED` must stay unset, or the workflow's own deploy job
   and the dashboard both push the same commit and race to the dyno. *(The
   dashboard's connect popup loops in Firefox and Safari — it needs a
   cross-site cookie both browsers block — but the backend link is created
   anyway; Heroku's `kolkrabbi` API shows the truth when the page does not.)*
2. `heroku pg:backups:capture -a secretary-kiron`
3. **Add the missing config vars.** The app reads 39 distinct `process.env`
   keys; Heroku has 15. Diffed 2026-09-15: 16 are missing, of which **10 have
   values in `.env.local`** — `ANTHROPIC_API_KEY` (the brain — without it
   `anthropicFor` returns null and every turn silently falls back to OpenAI),
   `CLAUDE_BRAIN`, `ADAPTIVE_V2` (without it the dashboard silently renders
   the old v0 layout), `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
   `REALTIME_MODEL_DEFAULT`, `REALTIME_MODEL_MINI`, `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — and 6 are empty locally too
   (`APPLE_CLIENT_ID/SECRET`, the four `INBOUND_EMAIL_*`), so nothing to copy. Add
   **`SHOP_DISABLED=true`** at the same time: it is the kill switch
   `lib/shop/shop.ts:56` already honours, and covers step 7 without new code.
   Regenerate the list mechanically:
   `/usr/bin/grep -rho 'process\.env\.[A-Z0-9_]*' app lib components | sort -u`
4. ~~Run `npx drizzle-kit push` against Heroku interactively once and read the
   plan.~~ **Read offline 2026-09-15** (see LOGBOOK v0.11): against Heroku's
   exact schema the plan is 13 `CREATE TABLE`, 18 `ADD COLUMN` (every NOT
   NULL one has a DEFAULT), 2 indexes, 16 FKs, and nothing dropped or
   retyped. Additive; safe on populated tables. What was NOT safe was the
   release phase itself: without `tablesFilter` in `drizzle.config.ts`,
   `push` tries to drop Heroku's `pg_stat_statements` views, fails, and
   applies nothing — which is why v9 came up with 16 tables and a 500 on
   sign-in. The filter is in; the next deploy is the migration.
5. **Migrate local → Heroku once**, then never again in that direction.
6. ~~Set repo secret `HEROKU_API_KEY` and repo variable `DEPLOY_ENABLED=true`.~~
   **Not needed while the dashboard deploys** — leave both unset (see step 1).
   What *is* needed: the workflow's `verify` job must be green, because that is
   the check the dashboard waits on. *(2026-09-15: it had never passed — all
   four runs failed `Tests` because CI set no `BETTER_AUTH_SECRET` and no
   VAPID pair; the scanner short-circuits without one. Fixed in the workflow:
   placeholder secret, throwaway VAPID pair generated per run. `next build` in
   CI has therefore never run yet either; the next push is the first time.)*
7. **Gate the Shop on Heroku.** `instrumentation.ts:15-18` calls `kickQueue()`
   every 60 s on every Node server; the Shop spawns `npx tsx`, `git worktree`
   and the `claude` CLI. Gate on capability, not on an env var someone has to
   remember: `if (process.env.ON_HEROKU || !existsSync('.git')) return`.
8. CI's `sleep 25` (`deploy.yml:116`) cannot see a crash that happens at 60 s —
   `instrumentation.ts` runs at boot. Poll for 120 s requiring `up`, then
   `curl` a real `/api/health`.

### The backup and sync scripts are lying to you

`scripts/sync-to-heroku.mjs` claims a "JSON snapshot of every table" (`:5`) but
hardcodes **16 of the 29** tables (`:25-41`). The 13 omitted include:

- `canvas_snapshots` — **the deployed Canvas comes up empty**
- `capability_requests`, `wishlist`, `dynamic_components` — the Shop forgets
  every ability it ever shipped and re-files it. *This is the exact loop that
  produced four canvas-checkbox builds.*
- `expectations`, `entities`, `connected_accounts`

So the nightly "backup" has never been a backup. Enumerate from
`information_schema` the way `scripts/db-backup.ts` already does, and derive FK
order from `pg_constraint` rather than a hand-sorted list.

The script is also hard-wired **local → Heroku** and clobbers the remote every
run. Correct when local was truth; catastrophic now. **Delete it or reverse it.**

**Disabled, must stay disabled:** launchd `com.secretary.dailysync` (03:00)
ran that script. Verified unloaded, plist renamed `.disabled`.

**It has failed four nights running and told nobody** —
`~/secretary-backups/sync.log`: `SYNC FAILED: column "calm_mode" of relation
"user" does not exist`, every night since 2026-09-12. (Silver lining: because it
failed, it never clobbered Heroku.) Any scheduled job that can fail silently for
four days needs to surface failure — a push notification, or an app-side check
that the last successful sync is under 48 h old.

**What cannot move to Heroku:** the Shop spawns headless Claude Code against
this checkout, and the sim harness boots a second Next server. Both stay on the
Mac and must point at the Heroku database once it is authoritative.

---

## Cost — the number you have been steering by is wrong

The user made this a first-class requirement. The tracking that was built works;
**what it measured does not.**

Live `usage` table: 453 rows, $77.86 total, voice $47.06 of it. **53 of the 58
voice rows are flagged `cost_estimated`** — the audio/text/cached split is never
captured, so `lib/pricing.ts:159-175` prices them as **100 % audio at $32/M**
when most of those tokens are a cached text prefix at **$0.40/M**. The $47 could
be wrong by several multiples. Five more voice rows have `cost_usd` NULL and
render as **$0.00** in the spend panel.

Every prioritisation decision made this session was made against a number the
code itself flags as a guess.

**Fix first:** the Realtime API already returns
`response.usage.input_token_details` with `audio_tokens`, `text_tokens` and
`cached_tokens`. Parse all three in the `response.done` handler in
`lib/realtime/openai-webrtc.ts`, ship them through `/api/realtime/end`, route
that endpoint through `recordUsage` instead of its raw `db.update`, and re-run
the backfill.

**Related:** `recordUsage` was built as the single entry point and **six of ten
write sites bypass it** (`app/api/realtime/end/route.ts:25` among them), landing
rows with NULL cost that read as free.

### Caching is half-landed

**Anthropic caching works and is verified** — `claude-opus-5` chat cached
309,432 of 517,441 input tokens (59.8 %), $0.169/turn against $0.483 uncached.

But it is **capped at ~60 % by a clock**. `lib/secretary/briefing.ts:286-294`
formats `dateLabel` with `minute: "2-digit"` and line 335 makes it the *first
line of the system block* — so the persona+briefing breakpoint is invalidated
**every 60 seconds** and only the tool block survives across turns.

- Split `system` into `[persona | cache]` `[briefing | cache]` and move the
  timestamp into the user turn. Expect ~85 %.
- Add the 4th breakpoint to the last history message — 40 turns of history plus
  accumulating tool results are currently re-billed at full price on all 8 rounds.

**The OpenAI path got nothing**: no `prompt_cache_key`, no verification, and
**zero cached tokens on record across 32 rows** — and it is still
`DEFAULT_CHAT_MODEL`.

### "Retrieve, don't dump" is untouched

A measured **3,522-token briefing** dumps the user's database into every single
request — *alongside* seven retrieval tools whose only job is to fetch that same
data (~1,200 more tokens of schema). **The app pays for the same state twice.**
Pick one model per data class and commit: keep in the briefing only what the
secretary must open a session knowing (date, overdue items, today's events);
retrieve the rest.

Also outstanding:
- `consult_brain` rebuilds the entire briefing and sends it **uncached** to a
  second model, then books the cost with a raw insert.
- Extraction runs a **second full model pass** after every chat turn over a
  transcript a 47-tool model has already processed. Skip it when the turn already
  executed a write tool — the outcomes are right there in `toasts`.
- When Claude throws mid-loop (`app/api/chat/route.ts:211-221`), the OpenAI
  fallback **re-executes tools that already ran**, and the tokens Claude burned
  are recorded nowhere.
- Exhausting the 8-round tool loop returns the literal string **`"(done)"`** to
  the user (`chat-claude.ts:136`).
- Painter cost is tracked through a **module-level mutable global**
  (`lib/canvas/painter.ts:52-62`), which cross-attributes under any concurrency.
- Sim-fleet spend is real money that appears nowhere in the $77.86.

---

## The folder cutover is done (2026-09-15 13:26 PDT)

**`~/code/secretary` is the live working folder.** `~/code/personal-assistant`
is a read-only archive and has been made inert:

- Its git remotes (`origin` → `kironkp/secretary`, `heroku`) were **removed**, so
  a stray `git push` from the archive cannot overwrite your work or deploy stale
  code. Restore with `git remote add` if ever needed.
- Nothing runs from it: Postgres (:5432) and `next dev` (:3000) were stopped
  there and restarted from `~/code/secretary`.
- `~/.local/bin/secretary-nightly-push.sh` and `secretary-daily-sync.sh` now
  point at the new folder.
- `secretary-daily-sync.sh` additionally **refuses to run** unless
  `SECRETARY_ALLOW_DESTRUCTIVE_SYNC=yes` — a second line of defence behind the
  renamed plist, because it mirrors local→Heroku and would destroy production.

The Postgres data directory was re-copied **cold** (with the server stopped)
rather than kept from the hot rsync, and verified: `database system was shut
down` on startup — no crash recovery — and the fingerprint matches exactly,
**29 tables / 1,993 rows**, every per-table count and freshness marker identical.

The archive still holds ~3.3GB of `.next` build cache. `rm -rf
~/code/personal-assistant/.next ~/code/personal-assistant/.next-sim` reclaims it
and destroys nothing.

---

## Operational landmines

- **`lib/auth.ts` is deliberately never committed.** It carries a dynamic auth
  `baseURL` for rotating tunnel hostnames. Every commit excludes it
  (`git add -A ':!lib/auth.ts'`). **It is not in git — if the folder is lost,
  that file is lost.** It is currently dirty in the working tree; that is
  expected and permanent, not an oversight.
- **The 02:00 nightly push job commits nothing it hasn't been given** — if the
  tree is dirty it pushes anyway. Have it report a dirty tree.
- **What the user tests is not what is committed.** A `next dev` server from
  2026-09-09 was still serving six days later. Restart the dev server after any
  commit touching `instrumentation.ts`, `next.config.ts` or `lib/db`, and
  consider stamping the served HTML with the git SHA.
- **Tunnel URLs rotate** on every `cloudflared` restart; each rotation needs the
  new callback in Google Console. `TRUSTED_ORIGINS` already has a
  `*.trycloudflare.com` wildcard, so nothing else changes.
- **`next dev` must be started with stdin held open** or Next 16 exits:
  `nohup sh -c 'exec npx next dev < /dev/zero' &`.
- **Local Postgres** runs from `scripts/local-postgres.mjs` on :5432 with a
  relative `./.pgdata`. Other projects use 5433/5434 — don't collide.
- **`find` and `grep` are broken in this shell** (a dyld error from a CLI shim).
  Use `/usr/bin/find` and `/usr/bin/grep`, or the Read/Grep tools.
- **No `pg_dump`** on this machine. Use `scripts/db-backup.ts` before any schema
  change — there are no migration files to roll back with.
- **`scripts/canvas-reset.ts`** rebuilds a canvas from live task data with no
  model call. Use it to get a known-good canvas to test interaction against.
- **README, SPEC, CLAUDE.md and MEMORY.md have all drifted** from the code. The
  README deployment section was rewritten this session; the SPEC was not.

---

## Suggested order

1. **Get production back up** — disconnect the dashboard integration, roll back.
2. **Canvas viewport meta + 44 px hit target.** Two small, high-confidence fixes
   for the bug that has burned the most of the user's patience.
3. **Fix the reorder remount and the 24 px clip.** These make the board feel
   broken even when the wiring is right.
4. **Close the verification gap** — jsdom for `.tsx`, Playwright on an iPhone
   profile in CI, `preflight-voice.ts`.
5. **Fix the voice cost measurement**, then finish caching on both providers,
   then narrow the briefing.
6. **Complete the Heroku cutover** in the order in §Heroku.
7. Only then: drag, resize, per-widget regeneration, Hume.

## What to read next

- `docs/LOGBOOK.md` — what changed this session, per version, with commit hashes
- `CLAUDE.md` — the standing rules and the JARVIS north star
- The `canvas-board` design artifact — the endorsed target for the Canvas
