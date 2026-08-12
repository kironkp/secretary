# Simulation testing harness

AI personas bug-hunt the Secretary on an **isolated second instance** (Next on
:3100, embedded Postgres on :5433, `.pgdata-sim`, `.next-sim`). Three actors:
a user-simulator LLM plays each persona, the real app brain is the system
under test, and a judge grounded in **actual DB state diffs** flags bugs —
"assistant claimed X, DB shows Y" is mechanical, not vibes.

## Commands

| Command | What |
|---|---|
| `npm run sim:smoke` | run the smoke fleet (boots/reuses the instance) |
| `npm run sim:selftest` | 1 user, 1 turn — harness sanity |
| `npm run sim:up` / `sim:down` (`-- --wipe`) | instance lifecycle |
| `npm run sim:replay -- --scenario s-x --run <runId>` | re-send a recorded conversation |
| `npm run sim:gen -- --count 100 --tier full` | generate bigger fleets (review, commit, `sim:run -- --fleet full`) |
| `npm run sim:hook:install` | install the post-commit auto-run |

Reports: `sim/reports/latest.md` (+ per-run `.md`, `.bugs.jsonl`, transcripts).
Exit code 1 when any error-severity violation exists.

## The checkers (error-severity unless noted)

duplicate open tasks/events (≥0.85 similarity) · claims-vs-writes honesty
audit (assistant said "added/moved/done/…" → a matching DB write must exist
that turn) · unfiled-with-project-mention (warn) · recurrence spawns exactly
one successor · reminders/stages round-trip · cross-user isolation (canary
user + active probes) · db integrity · deterministic `expected_outcomes` per
scenario · cheap-LLM judge for fuzzy checks (warn only).

## Auto-run after every commit

`npm run sim:hook:install` → each commit fires the smoke fleet in the
background (never blocks a commit) and writes `sim/reports/latest.md`.
**Disable:** `touch sim/.disabled`, or `SIM_DISABLE=1 git commit …`, or delete
`.git/hooks/post-commit`. Skips automatically during rebase/merge, when a run
is already live, or when no `OPENAI_API_KEY` is available.

## Cost & models

The app brain runs the real `TEXT_MODEL` (that's the point); simulator/judge
use `gpt-5-mini`. A smoke run ≈ 70 brain requests ≈ $0.40–0.80 and 4–8 min.
Cheap mode: `SIM_TEXT_MODEL=gpt-5-mini npm run sim:up` (reboot the instance to
apply; caveat — it changes the behavior under test).

## Flake policy

The post-commit signal must stay trustworthy: any checker that flakes across
two consecutive clean runs on unchanged code gets demoted to warn (and noted
here). Deterministic voice-scripted scenarios (e.g. `s-voice-double-create`,
the historical double-create bug) are the regression backbone — they never
flake.

## Proven (2026-08-11)

- Selftest + two consecutive clean smoke runs on main.
- Seeded-bug test: disabling the create dedupe guard → `duplicate_open_tasks`
  fired (3 errors); healthy guard → pass.
- First real find on day one: the model passed `project:"none"` into a create
  path and the app created a project literally named "none" (fixed in
  `resolveProject` + regression test).
- Isolation: zero sim users in the primary DB after runs.
