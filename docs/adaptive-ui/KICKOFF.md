# Driving Claude Code to build the LayoutPlan system

The way to get the best outcome from a coding agent is not one giant inspired
prompt. It's four mechanical things:

1. **The spec is a file in the repo**, not a chat message — every session
   re-reads it, and no session depends on you re-explaining.
2. **Correctness is defined by fixtures** (SPEC §8) that become tests. "Did it
   work" is never a vibe.
3. **Phases small enough that every session ends green.** Agents degrade on
   giant diffs; they excel at "make these six tests pass without breaking those."
4. **Each prompt points at the spec instead of restating it.** Restating invites
   drift between what you said and what's written.

You review at phase boundaries, not line-by-line.

---

## One-time setup (5 minutes)

1. Copy this folder into the repo as `docs/adaptive-ui/`. Contents:
   - `SPEC.md` — the source of truth (v1.1)
   - `KICKOFF.md` — this file: prompts + process
   - `reference-demo.html` — visual reference for the Dashboard (Phase 1)
   - `canvas-reference.html` — visual + behavioral reference for the Canvas (Phase 2.5)
   - `trace-2026-08-18.html` — annotated analysis behind SPEC §11
   - `transcript-2026-08-18.md` — the raw voice-session fixture §11 cites
2. Append the block below to `CLAUDE.md` at the repo root (create if missing).
   This is what makes the invariants survive *every* future session — including
   sessions about unrelated features.
3. Commit: `docs: adaptive dashboard spec v1`.

### CLAUDE.md block

```md
## Adaptive dashboard (LayoutPlan system)
- Dashboard layout is data: a LayoutPlan rendered by the layout renderer.
  Never hardcode section order; change DEFAULT_PLAN or the planner instead.
- The component registry is the only UI vocabulary. New components = registry
  version bump + SPEC table update. Generated code never registers itself.
- The validator is load-bearing. Planner/chat output is DATA; it never reaches
  innerHTML/JSX unescaped. Never skip or weaken validation to make a test pass.
- The Spreadsheet view never adapts. Do not add adaptive behavior to it.
- Emphasis changes are free; SYSTEM-initiated reordering needs
  days_since_layout_change >= 1 plus a user-visible why. USER-initiated changes
  apply immediately.
- The Canvas is the only surface where the model writes markup: sanitized
  static HTML in a sandboxed iframe, no scripts/handlers/forms/external loads
  ever. The shell owns all interactivity (data-expand, data-link). Everywhere
  else, model output is data.
- Full spec: docs/adaptive-ui/SPEC.md — source of truth. To change behavior,
  update the spec first, then the code.
```

---

## Process rules (these matter as much as the prompts)

- **One phase per session.** `/clear` between phases; the spec carries context.
- **Start every phase in Plan Mode** (Shift+Tab twice). Read the plan. Approve
  only when it matches the spec's phase definition. Misunderstandings are cheap
  here and expensive after 40 file edits.
- **Tests first.** The fixtures exist so the agent can't redefine success.
- **Commit per phase.** Never let a session end red.
- If Claude Code wants to deviate from the spec, the correct response is:
  *"Update SPEC.md first and show me the diff."* Then let it proceed. The spec
  staying true is worth more than any single shortcut.
- When something looks wrong, paste the failing fixture name, not a description.

---

## Phase 0 prompt — recon (paste first, in Plan Mode)

```
Read docs/adaptive-ui/SPEC.md fully. Then explore this codebase — do not change
any code. Write docs/adaptive-ui/INTEGRATION.md per SPEC §9 Phase 0:

- where the dashboard renders (exact file paths) and how views are composed
- where projects, items, chat transcripts, and the accountability log live
- how the frontend is built, styled, and tested (conventions to match)
- a mapping of every SPEC concept — registry (§2), schema+validator (§3),
  signals (§4), planner (§5/§6), renderer, chat tools (§7.5) — to a concrete
  proposed file path in THIS repo
- anything in SPEC §4's Signals type that can't be computed from existing data:
  list each gap and the minimal way to start capturing it
- a "Decisions needed" list at the top for anything genuinely ambiguous

Keep it under a page. Stop after writing the file — no implementation.
```

**Your review:** read INTEGRATION.md. Answer the decisions. Fix anything it got
wrong about your own app *in the file*, commit, then start Phase 1 fresh.

---

## Phase 1 prompt — v1, rules engine (no LLM)

```
Read docs/adaptive-ui/SPEC.md and docs/adaptive-ui/INTEGRATION.md. Implement
SPEC §9 Phase 1 exactly, in this order:

1. LayoutPlan types + component registry v1 + DEFAULT_PLAN (SPEC §2–3)
2. the validator, with all F5 cases as unit tests (SPEC §8)
3. fixtures F1–F4, F6, F7-base-data materialized as test fixtures
4. planFromRules (SPEC §5) until F1–F4 + F6 pass
5. signals computation from real app data (SPEC §4)
6. the renderer + why-chips, behind a feature flag; calm-mode toggle in
   Settings; plan history + one-tap revert, with reverts logged

Visual reference: open docs/adaptive-ui/reference-demo.html and match its
information design using our existing styles/tokens — do not import its CSS.

Guardrails: read-only access to the Spreadsheet view and extraction pipeline —
zero diffs under those paths. No new runtime dependencies without asking. Do not
refactor unrelated code. Done = all fixtures green, app runs with the flag on
and off, and you show me screenshots of the default state and one adapted state.
```

---

## Phase 2 prompt — LLM planner + chat control (tier 1)

```
Read docs/adaptive-ui/SPEC.md §6, §7.5, §9 Phase 2. Implement:

- planFromLLM behind the same interface as planFromRules; fallback chain
  LLM → rules → previous good plan → DEFAULT_PLAN; the planner system prompt
  as docs/adaptive-ui/planner-prompt.md (build it from SPEC §1 invariants +
  §2 registry + §4 signals shape + §5 DEFAULT_PLAN); JSON output mode;
  plan cache keyed by signals-hash + registry version
- CI never calls a live model: record/mock responses; all Phase 1 tests stay
  green with the LLM mocked
- chat tools: get_current_plan, edit_layout_plan, set_layout_preference —
  wired into the secretary agent, validated by the same validator; F7 green
- morning reason_summary banner; pin/revert UI; decision log
  (signals_hash, plan, accepted|reverted|pinned_over)
```

---

## Phase 2.5 prompt — the Canvas (can run right after Phase 1)

```
Read docs/adaptive-ui/SPEC.md §7.6 and §9 Phase 2.5. Implement the Canvas:

- a new page/tab alongside the Dashboard: model-painted, sanitized static
  markup rendered in a sandboxed iframe (sandbox attr + CSP script-src 'none')
- the sanitizer (allowlist tags/attrs; strip scripts, event handlers, forms,
  external loads) with F9 as unit + integration tests, including the
  no-network-egress assertion
- shell interaction primitives: data-expand (click to expand) and
  data-link="<entity_id>" (opens that entity on the Dashboard/Spreadsheet) —
  implemented once in the host, never expected from model output
- chat tools paint_canvas(brief) and edit_canvas(patch), streaming the render
  so first paint lands under 3 seconds
- docs/adaptive-ui/canvas-painter-prompt.md: given the Signals JSON + the
  user's brief, emit ONE html fragment, inline styles from our design tokens,
  no scripts, every number traceable to signals
- snapshot history (markup + brief + timestamp) with one-tap restore

Guardrails: the Canvas never mutates app state; nothing painted can execute;
reuse the Signals computation from Phase 1 unchanged.
Visual reference: docs/adaptive-ui/canvas-reference.html (the left pane).
```

**Your review:** say "paint my week," then "make the album section bigger,"
then restore the earlier snapshot. View source on the iframe: zero `<script>`.

## Phase 3 prompt — slow loop + chat tier 2

```
Read docs/adaptive-ui/SPEC.md §7, §7.5 tier 2, §9 Phase 3. Implement:

- wishlist.jsonl accumulation with dedupe + tombstones
- brief assembly (wishlist entries + design tokens + one existing component as
  style exemplar + registry docs) and two triggers: nightly, and on-demand from
  request_new_component
- the generation job invoking headless Claude Code (claude -p) or the Agent
  SDK; output only ever lands in components/proposed/<name>/ with a static
  preview + screenshot
- approval in chat and in Settings: approve = registry version bump +
  hot-register (no restart) + planner prompt table update; reject = tombstone
- F8 green, plus a test proving nothing under components/proposed/ is imported
  at runtime

Then demo the loop end-to-end for me with a seeded wishlist entry.
```

---

## After Phase 3 — the agent-layer track (SPEC §11)

Persona config, stakes, pipeline templates, the expectations/nag engine, the
clarification queue, ASR lexicon export, and the voice fast/slow split are a
separate track from the dashboard phases above. Run them as their own sessions
once the dashboard track is green (or in parallel in a second worktree — they
touch extraction and chat, not the renderer). Same method: point the prompt at
SPEC §11 and `transcript-2026-08-18.md`, and have Claude Code first turn each
§11 bullet into a failing test derived from the transcript, then make it pass.
Suggested order: pipeline templates + stakes → expectations/nag engine →
clarification queue + entity cross-ref → lexicon export → voice split last
(it depends on all the others being real).

## Your review checklist, every phase

Run the test suite yourself. Click through the four seeded states (quiet /
timeline-day / engagement-spike / nested). Toggle calm mode. Hit revert — a
working revert is the single most important control in the system. From Phase 2:
tell the chat "stop showing me people" and watch it stick, then remove the
preference in Settings. Check `git diff --stat` touches nothing under the
Spreadsheet or extraction paths. If a fixture was edited to make it pass, that's
the one unforgivable diff — the fixtures are the contract.
