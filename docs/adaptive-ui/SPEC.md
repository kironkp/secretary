# Adaptive Dashboard — LayoutPlan System (SPEC v1.1)

**Status:** approved design. This document is the source of truth. If code and spec
disagree, the spec wins; if the spec is wrong, change the spec first, then the code.

**For the implementing agent:** you have not chosen this architecture — it was
researched and decided (receipts at the bottom). Your job is to fit it into the
existing codebase with the smallest footprint, matching existing conventions
(framework, styling, state, storage) rather than introducing new ones.

---

## 1. What this is

The dashboard's layout becomes **data**: a `LayoutPlan` JSON object that a
deterministic renderer executes against a fixed **component registry**. A
**planner** produces the plan from the user's current situation ("signals").

Two loops, two clocks:

- **Fast loop (runtime, every session open):** planner → LayoutPlan → validate →
  render. In v1 the planner is hand-written rules; in v2 it becomes a small-model
  LLM call behind the same interface. ~1s worst case. Failure = fall back to the
  previous good plan, then to DEFAULT_PLAN.
- **Slow loop (offline, nightly):** when the planner wants a component that
  doesn't exist, it logs a **wishlist entry** instead of improvising. A separate
  coding-agent job turns accumulated wishes into new registry components — 
  versioned, previewed, human-approved. Runtime never executes generated code.

Non-negotiable invariants (from adaptive-UI research — Findlater & McGrenere
CHI'09, Lavie & Meyer IJHCS'10, Google A2UI's declarative-over-codegen design):

1. **App chrome (tabs, search, provenance UI) is never controlled by the planner.**
2. **The Spreadsheet view never adapts.** It is the audit floor.
3. **Emphasis is free; movement is rationed — for the system.** Variant/accent/
   expand may change every render. *System-initiated* reordering requires
   `days_since_layout_change >= 1` AND a user-visible `why` string on the moved
   section. **User-initiated changes (a chat request, a pin, a tap) apply
   immediately, always.** The rationing exists to protect spatial memory from
   surprises; nothing the user asked for is a surprise.
4. **Nothing urgent disappears.** Items with `days_left <= 7` must render above
   the fold in every plan. Compact allowed; absent = plan rejected.
5. **At most one `accent: true` project card per plan.** Accent = attention.
   Color meaning (deadline pressure) is fixed by the design system, never by the planner.
6. **Model output is data, never markup.** No planner string may reach
   `innerHTML`/JSX children unescaped. Unknown components/props are rejected.
7. **User overrides beat the planner:** pinned sections keep position+variant;
   `calm_mode` renders DEFAULT_PLAN unconditionally; one-tap revert to previous plan.
   Every revert is logged (it's a labeled wrong prediction — our accuracy metric).
8. **Mid-session mutation is diff-shaped.** While the dashboard is open, new plans
   apply as animated in-place diffs (sections fade/slide, numbers tick). System-
   initiated mid-session diffs may only be additive or emphasis-level (accent,
   expand, inline, append a section, update values); reorders and removals wait
   for the next session open — unless user-initiated, in which case the whole
   change applies live.

---

## 2. Component registry v1

The only building blocks the planner may reference. Registry lives in code with a
version number; the validator loads prop-schemas from it.

| component      | props                                                                 | notes |
|----------------|-----------------------------------------------------------------------|-------|
| `focus_banner` | `text: string`, `tone: "info"\|"serious"\|"critical"`                 | one line, top of canvas only |
| `hero_next_up` | `event_id: string`                                                    | next hard commitment card |
| `stat_row`     | `tiles: {value, label, tone?}[]` (max 5)                              | |
| `project_card` | `project_id`, `variant: "full"\|"compact"\|"nested"`, `accent?: bool`, `inline_loops?: bool` | `nested` renders subprojects with own progress; `inline_loops` embeds that project's open items |
| `timeline`     | `span_days: 14\|21\|35`, `expanded: bool`                             | rows = active projects; undated = dashed |
| `open_loops`   | `group_by: "project"\|"date"`, `include_done: bool`                   | the grouped table |
| `date_chase`   | `item_ids: string[]`                                                  | the "needs a date" strip |
| `people_index` | —                                                                     | |

`DEFAULT_PLAN` (also the fallback and calm mode):
`[hero_next_up, stat_row, project_card × each active project (full), timeline(21, false), open_loops(project, true), date_chase(all missing), people_index]`

Adding a component = bump registry version + add prop schema + add render fn +
mention in planner prompt. Never mid-session.

**v1.2 refinements (Phase 1 implementation):** (a) all props are optional — a
section with omitted props renders its computed-from-data default, which is
what DEFAULT_PLAN relies on; the planner sets props only to deviate. (b) Per
INTEGRATION Decision 2, the registry also carries this app's five pre-existing
zones (`documents`, `coming_up`, `kanban`, `procrastination_zone`,
`suggested_zone`), props-less; v0's `overdue_callout` retires into
`focus_banner`.

---

## 3. LayoutPlan schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["plan_id", "sections"],
  "additionalProperties": false,
  "properties": {
    "plan_id": { "type": "string" },
    "reason_summary": { "type": ["string", "null"], "maxLength": 120 },
    "sections": {
      "type": "array", "minItems": 1, "maxItems": 14,
      "items": {
        "type": "object",
        "required": ["component"],
        "additionalProperties": false,
        "properties": {
          "component": { "enum": ["focus_banner","hero_next_up","stat_row","project_card","timeline","open_loops","date_chase","people_index"] },
          "props": { "type": "object" },
          "why": { "type": "string", "maxLength": 140 }
        }
      }
    },
    "wishlist": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["need", "closest_component", "signals"],
        "properties": {
          "need": { "type": "string" },
          "closest_component": { "type": "string" },
          "signals": { "type": "string" }
        }
      }
    }
  }
}
```

Props are validated per-component against the registry (second pass, not in the
JSON Schema above). Semantic rules (invariants 3–5, urgency-above-fold, pinned
sections) are a third validation pass. **Validator returns
`{ok: true, plan} | {ok: false, reasons[], fallback: plan}` and MUST be pure and
unit-tested.**

---

## 4. Signals

Computed by the app from existing data (projects, items, chat transcripts,
accountability log). No new collection needed for v1. Shape:

```ts
type Signals = {
  projects: {
    id: string; name: string; kind: string;
    deadline: string | null;                    // ISO date
    deadline_type: "committed" | "inferred" | "none";
    days_left: number | null;
    open_count: number; done_count: number;
    subprojects: { id: string; name: string; open_count: number; done_count: number }[];
    people: string[];
  }[];
  engagement: Record<string, { mentions_24h: number; baseline_mentions: number; last_touched: string }>;
  conversation: { today_topics: string[]; schedule_word_share: number; questions_today: string[] };
  pending: { items_missing_dates: string[]; unanswered_asks: string[] };
  calendar: { next_hard_commitment: string | null; days_to_it: number | null; density_14d: number };
  context: {
    date: string; weekday: string; time_of_day: "morning"|"afternoon"|"evening";
    days_since_layout_change: number;
    pinned_sections: string[]; calm_mode: boolean;
  };
};
```

Definitions:
- `mentions_24h`: count of chat messages in last 24h whose extraction linked to this
  project. `baseline_mentions`: trailing 14-day daily median (min 1).
- `schedule_word_share`: fraction of today's user messages containing schedule
  vocabulary (when/by/before/deadline/schedule/calendar/date + weekday/month names).
- **Engagement is "strong"** when `mentions_24h >= 3 × baseline` and `>= 5` absolute.
- **Schedule-talk is "strong"** when `schedule_word_share >= 0.3` or
  `>= 3` schedule-shaped questions today.

---

## 5. Planner v1 — rules (no LLM)

Pure function `planFromRules(signals): LayoutPlan`. Start from DEFAULT_PLAN, apply
in order (later rules may not violate earlier invariants):

1. **Deadline pressure:** any project `days_left <= 3` (or committed `<= 7`) →
   its card gets `accent: true` + `inline_loops: true`. If several qualify, accent
   only the soonest (invariant 5); others full variant.
2. **Engagement:** strongest strong-engagement project → accent + full +
   `inline_loops`. If `days_since_layout_change >= 1`, also move its card to
   position after `hero_next_up` with `why: "N mentions today vs M typical"`.
   Engagement accent loses to deadline accent when both fire (deadline wins;
   engaged project still gets full + inline_loops).
3. **Schedule-talk:** strong schedule-talk → `timeline` gets `expanded: true`,
   `span_days: 14`; if reordering permitted, timeline moves to top (before hero)
   with why; all project cards drop to `compact` except accented one.
4. **Structure:** any project with `subprojects.length >= 2` → its card
   `variant: "nested"`. If subprojects have their own dated deadlines and
   registry has no fitting component for that, add wishlist entry
   `{need: "per-subproject deadline lanes", closest_component: "timeline", ...}`.
5. **Nothing fired** → DEFAULT_PLAN verbatim, `reason_summary: null`, zero `why`s.

Every deviation from DEFAULT_PLAN carries `why` (≤ 140 chars, addressed to the
user, naming the signal). `reason_summary` set when ≥ 2 rules fired or a reorder
happened.

## 6. Planner v2 — LLM behind the same interface

`planFromLLM(signals): Promise<LayoutPlan>` with the same return contract.
Selection: `plan = validate(await planFromLLM(s)) ?? validate(planFromRules(s)) ?? previousGoodPlan ?? DEFAULT_PLAN`.

- Small/fast model (Haiku-class), JSON output mode, temperature ≤ 0.3, one call
  per dashboard open. **Cache** keyed by hash of (signals minus timestamps,
  registry version); quiet days cost zero calls.
- The system prompt is `planner-prompt.md` (kept in repo, versioned). It contains:
  role, signals shape, registry table, the 10 hard rules (mirror of §1
  invariants + "on any doubt emit DEFAULT_PLAN"), DEFAULT_PLAN, output contract.
- Log every (signals_hash, plan, accepted|reverted|pinned_over) for tuning.

## 7. Slow loop (v3)

- Planner wishlist entries append to `wishlist.jsonl` (dedupe by `need`).
- Nightly job: any `need` with ≥ 3 occurrences → assemble a build brief:
  the wishlist entries + design tokens + one existing component's source as a
  style exemplar + registry docs → run the coding agent (e.g.
  `claude -p "$(cat brief.md)"` or a queued Claude Code session) → output lands in
  `components/proposed/<name>/` with a static preview HTML + screenshot.
- Approval UI (a card on the dashboard): preview + diff + approve/reject.
  Approve = move into registry, bump version, append one line to the planner
  prompt's registry table. Reject = delete + tombstone the `need` (stop re-proposing).
- Generated code never registers itself. No dynamic import of unapproved code.
- The "coding agent" here can literally be headless Claude Code
  (`claude -p "$(cat brief.md)"`) or the Agent SDK, invoked by the app server.

## 7.5 Conversational layout control (the chat channel)

"I don't like this / change this" must work from inside the chat, quickly. The
secretary's chat agent gets layout tools. Two tiers, and the split is the point:

**Tier 1 — seconds (it's data).** Most requests land here.
- `get_current_plan()` → LayoutPlan + registry version + active preferences.
- `edit_layout_plan(patch)` → edits the live plan. Validated by the SAME
  validator as planner output; applies immediately (invariant 3, user-initiated),
  animated as a diff (invariant 8).
- `set_layout_preference(pref)` → durable constraints, stored, injected into
  every future planner call, and enforced by the validator:
  `{ban_component}`, `{pin_section}`, `{default_variant_for}`,
  `{accent_policy: "never"|"auto"}`.
  "Stop showing me people" → ban `people_index`. "I hate the glowing ring" →
  `accent_policy: never`. Preferences are listed and removable in Settings, so a
  dislike stated once never has to be re-stated — and never re-annoys.

**Tier 2 — minutes (it's code).** For asks outside the registry:
- `request_new_component(need, sketch?)` → appends a *priority* wishlist entry
  and triggers the slow loop ON DEMAND instead of nightly. Chat answers with the
  honest state: "Building that view — a few minutes. Meanwhile, here's the
  nearest thing," and the planner substitutes the closest component with a `why`.
  When the build lands, approval happens in chat ("here it is — keep it?"),
  which doubles as the human review. Approved → hot-register (registry version
  bump, no restart). Rejected → tombstone the need.

This is "Claude Code built into the app" — but it only ever writes sandboxed,
previewed, versioned components. It never edits the live plan directly (that's
tier 1's job) and its output never runs before a yes.

## 7.6 The Canvas (free-form visual surface)

A second adaptive surface alongside the Dashboard: a page the secretary
**paints**. The Dashboard rearranges hand-built interactive furniture (data
edits, instant, safe). The Canvas is model-written **markup** — arbitrary
layouts, poster-level emphasis, one-off views — repainted or patched in seconds
while the user talks. This is the "talk and instantly see it change" surface.

The speed hierarchy the two surfaces implement: touching **data** is instant
(Dashboard), touching **markup** is seconds (Canvas), touching **code** is
minutes (slow loop). Interactivity is not what makes adaptation slow — code
authorship is. So the Dashboard keeps its interactivity, and the Canvas trades
interactivity away to gain unlimited shape.

Rules:

- **Content:** static HTML/SVG only. Sanitized against an allowlist (no
  `<script>`, no event-handler attributes, no external loads, no forms),
  rendered in a sandboxed iframe (`sandbox` attribute, CSP `script-src 'none'`).
  Invariant 6 ("model output is data, never markup") is relaxed for this ONE
  surface precisely because nothing on it can execute.
- **Interactivity ceiling:** none from the model, by design. The host shell
  provides generic primitives: any element with `data-expand` gets
  click-to-expand; `data-link="<entity_id>"` opens that entity on the Dashboard
  or Spreadsheet. The model emits attributes; the shell owns all behavior.
- **Chat tools:** `paint_canvas(brief)` — full repaint, streamed so first paint
  lands fast; `edit_canvas(patch)` — targeted change ("make the album section
  bigger") without a full repaint.
- **Latency budget:** first visual paint < 3s, complete < 10s, patch < 2s.
  Small/fast model; the painter prompt lives in repo as `canvas-painter-prompt.md`.
- **Data honesty:** the painter receives the same Signals JSON as the planner
  and may not invent values — every number on the canvas must trace to signals.
- **Persistence:** every paint is saved as a snapshot (markup + brief +
  timestamp). Provenance applies to pictures too; "show me Tuesday's version"
  must work. Snapshots are cheap — they're text.
- **Audition room:** a canvas shape requested ≥ 3 times auto-files a wishlist
  entry — the Canvas is where future registry components audition. And slow-loop
  components are **born visual**: the first approved version has no interactions;
  promotion to interactive happens only after it survives a week of real use.
  (Coding agents are far more reliable generating a picture of data than a
  stateful widget — let new things earn statefulness.)

---

## 8. Golden fixtures (these become the test suite)

Fixtures are (signals → assertions on the plan). Materialize each as a test.
Shared base: 4 projects — `patent` (deadline 2026-08-10, committed, days_left 3,
people:[Ash]), `album` (2026-08-18, committed, days_left 11, people:[Jazz]),
`findit` (2026-09-07, inferred), `caltrans` (none, 2 items missing dates).
Baseline engagement 2/day each; `days_since_layout_change: 2`; nothing pinned;
calm_mode false. Each fixture overrides only what it names.

**F1 quiet-day** — base as-is, no strong signals.
→ plan deep-equals DEFAULT_PLAN; `reason_summary` null; zero `why`s; zero wishlist.

**F2 timeline-day** — `schedule_word_share: 0.42`, `questions_today` includes 3
schedule questions.
→ first section is `timeline` with `expanded: true, span_days: 14` and a `why`;
patent card still above the fold (invariant 4: days_left 3); patent keeps accent
(rule 1 beats rule 3's compacting); non-accented cards `compact`.

**F3a engagement-promote** — `engagement.patent.mentions_24h: 14`.
→ patent card: `accent, full, inline_loops`, positioned immediately after
`hero_next_up`, `why` mentions "14" and "2"; exactly one accent in plan.

**F3b engagement-no-reorder** — same as F3a but `days_since_layout_change: 0`.
→ patent card accented + full + inline_loops **in its DEFAULT_PLAN position**;
section order deep-equals DEFAULT_PLAN order. (Emphasis free, movement rationed.)

**F4 nested-structure** — `album.subprojects`: 4 entries with own counts.
→ album card `variant: "nested"`; if album also within 14d committed it may take
accent per rule 1 (patent days_left 3 still wins accent — assert accent is on
patent, album nested without accent).

**F5 validator-rejects** (unit tests on validator, not planner):
- unknown component `"burndown_chart"` → section dropped, rest renders, reason logged.
- plan omitting the patent card entirely (days_left 3) → whole plan rejected,
  fallback returned.
- two cards with `accent: true` → rejected or auto-demoted to one (pick one
  behavior, document it, test it).
- prose/markdown instead of JSON → fallback, no throw.
- pinned section moved → rejected.

**F6 calm-mode** — `calm_mode: true` + strong signals everywhere.
→ DEFAULT_PLAN verbatim, planner not even called (assert via spy/counter).

**F7 chat-ban (tier 1)** — user says "stop showing me the people section."
→ chat calls `set_layout_preference({ban_component: "people_index"})`; live plan
re-renders without it immediately; any later planner plan containing
`people_index` is rejected by the validator until the preference is removed.

**F8 chat-new-view (tier 2)** — user asks "show the album as a burndown chart."
→ painted on the Canvas immediately (if Canvas is built); priority wishlist
entry written; Dashboard interim plan substitutes `timeline(14, expanded)` with
`why: "closest I have until the burndown view is built"`; on-demand slow-loop
job enqueued (assert enqueued); assert no runtime import of anything outside
the approved registry.

**F9 canvas-sanitize** — painter output includes `<script>alert(1)</script>`,
an `onclick=` attribute, a `<form>`, and `<img src="http://evil.example/x.png">`.
→ sanitizer strips all four; result renders in the sandboxed iframe (assert the
`sandbox` attribute and CSP are present); a snapshot is saved with brief +
timestamp; no network request leaves the iframe (assert via request interception
in the test).

---

## 9. Phases & acceptance criteria

**Phase 0 — Recon (no code changes).** Read the codebase. Produce
`docs/adaptive-ui/INTEGRATION.md`: where the dashboard renders (files), where
projects/items/chat live, where signals can be computed from, existing
test/tooling conventions, and a ≤ 1-page integration plan mapping every §2–§6
concept to a concrete file path. STOP for human review.

**Phase 1 — v1 shippable.** Registry + types + validator + renderer +
`planFromRules` + signals computation + fixtures F1–F6 green + calm-mode toggle
in Settings + plan/revert log table. Rendering DEFAULT_PLAN must reproduce the
current dashboard's content (visual parity with `reference-demo.html` aesthetics
where the app lacks a design). Spreadsheet untouched (assert zero diffs under its
source dir). Why-chips render on adapted sections.

**Phase 2 — v2 planner + chat tier 1.** `planFromLLM` + prompt file + JSON mode +
cache + fallback chain + morning `reason_summary` banner + pin/revert UI +
decision log. Chat tools `get_current_plan` / `edit_layout_plan` /
`set_layout_preference` wired into the secretary agent; F7 green. All Phase 1
tests still green with LLM mocked; one integration test with recorded LLM
responses (never live calls in CI).

**Phase 2.5 — Canvas v0 (§7.6).** `paint_canvas` + `edit_canvas` chat tools;
sanitizer + sandboxed iframe host + shell primitives (`data-expand`,
`data-link`); streaming render; snapshot history with restore;
`canvas-painter-prompt.md` in repo (given Signals + brief → one HTML fragment,
inline styles from design tokens, no scripts, every number from signals).
F9 green. Independent of Phase 2 — can be built right after Phase 1 if the
"paint while I talk" feel is wanted early.

**Phase 3 — slow loop + chat tier 2.** wishlist.jsonl + brief assembly + nightly
AND on-demand (`request_new_component`) triggers + `components/proposed/` with
preview + in-chat and Settings approval flows + registry versioning + tombstones.
Acceptance: a seeded wishlist produces a proposal; approving registers it (no
restart); rejecting tombstones it; F8 green; unapproved code is provably never
imported at runtime.

---

## 10. Receipts (why these choices)

- Declarative plan over runtime code-gen: Google's production A2UI vs their
  minute-plus generative-UI demo; Anthropic's Imagine-with-Claude shipped as a
  time-boxed research demo. (developers.googleblog.com A2UI; research.google
  generative-ui post; arXiv 2604.09577.)
- Movement rationing + graceful failure: Findlater & McGrenere, CHI 2009
  (ephemeral adaptation) — moving items under imperfect prediction is worse than
  no adaptation; stable-position adaptation degrades gracefully.
- Suggest-and-approve over silent automation: Lavie & Meyer, IJHCS 2010 —
  intermediate adaptivity beats full automation outside routine situations.
- Accent ≠ recolor: color already encodes deadline pressure in this app's design
  system; Findlater also found color highlighting alone yields no performance gain.

## 11. Agent-layer requirements (from the Aug 18 voice transcript)

These sit in the extraction/agent layer, not the LayoutPlan renderer — build
them alongside Phase 2. Each traces to an observed failure or success in a real
claude.ai session used as a fixture (docs/adaptive-ui/transcript-2026-08-18).

- **persona_config**: `{strictness, tone, praise, followup_aggressiveness,
  quiet_hours}` — stored once, editable in Settings, applied to voice, chat,
  UI copy, and the nag engine. Never re-requested per conversation.
- **stakes on commitments**: a `stakes` field ("miss reconcile → strike from
  HQ") captured when the user names a consequence. Nags must cite stakes when
  present — it's what makes sternness honest rather than theatrical.
- **pipeline templates**: ordered steps with `blocked_by` dependencies,
  instantiable per item (e.g. CPO: update → sign → pay → reconcile+submit),
  with per-step dates and optional recurrence (monthly statement cycles).
  "Where am I" answers must read from pipeline state, never from summary memory.
- **expectations / nag engine**: any promised follow-up ("I'll be asking")
  writes `{commitment, expected_update_by, on_miss escalation, stakes_ref}`.
  A user report clears it silently; a miss fires per escalation policy.
  Rules: batch nags into one ping, respect quiet_hours, escalate per persona.
  Reuses the scheduled-trigger machinery; never a rhetorical promise.
- **clarification queue**: extraction ambiguities accumulate in a queue asked
  ONE at a time at natural pauses — never mid-flow, never as a barrage.
  Sources: unresolved referents ("this one is finished" while reading an
  unseen screen), unparseable ASR spans (kept with audio offsets, marked
  [unclear], never silently guessed), low-confidence new names (confirm
  spelling before any document use), entity conflicts (see next).
- **entity cross-reference on extraction**: every person/org mention resolves
  against the store before write. A mention matching an existing entity can
  never be silently dropped or merged — conflict → clarification queue.
  (Fixture: "Marissa, Teresa Mahers, my boss" — Marissa existed since Jul 30;
  the session dropped her without asking.)
- **ASR lexicon export**: the store continuously exports a vocabulary (people,
  orgs, project terms, acronyms: CPO, CalCard, DTC…) into the realtime voice
  session's transcription biasing config. Update on every new entity.
- **voice modality rule**: voice replies ≤ 2 sentences + at most one question,
  ending with the single next action. Anything visual routes to a surface
  (Canvas paint or Dashboard plan edit) and the voice says "on your screen."
  "I can't draw a chart out loud" is a forbidden answer.
- **fast/slow split**: the realtime voice model (mouth/ears) carries only
  persona + today's brief + lexicon + thin tools (`log_status`,
  `create_commitment`, `schedule_checkin`, `paint_canvas`). The extractor
  (brain) runs async 2–5s behind each utterance, writes the store, and injects
  clarifications back for the next pause. The store is the only truth; a dead
  voice session loses nothing.
- **capture never depends on external apps**: the store is the system of
  record; Reminders/Calendar are optional exports. An export failure becomes a
  visible pending item, disclosed once — capture itself cannot fail on a
  third-party permission.
