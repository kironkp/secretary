# INTEGRATION.md — mapping SPEC v1.1 onto this codebase (Phase 0)

## Decisions (resolved 2026-08-18)

1. **Evolve in place** — SPEC concepts replace their `lib/layout/` v0 counterparts file-by-file.
2. **Registry v2 = SPEC's 8 + the 5 existing extra views** (documents, coming_up, kanban, procrastination_zone, suggested_zone). v0's `overdue_callout` retires into `focus_banner`.
3. **Planner model: OpenAI, existing stack** (`lib/openai.ts` `TEXT_MODEL`; JSON mode already proven by the v0 generator). The OpenAI Realtime finding from prior research applies to voice; the planner is a cheap JSON call and stays on the same provider the app already uses. No new SDK.
4. **Schema additions approved**: `projects.deadline` + `projects.deadlineKind` ("committed" | "inferred") and `projects.parentId` (subprojects). Inferred deadlines are computed from earliest dated open work; committed ones are set explicitly (chat tools in Phase 2).
5. **Preferences: separate `layout_preferences` table** — one row per durable constraint (ban_component, pin_section, …), listed and removable in Settings. `calm_mode` is a boolean on `user`.

## Original decision questions (kept for the record)

1. **This app already has a v0 of this system.** `lib/layout/spec.ts` + `generator.ts` (LLM arranger over a fixed 12-component palette, hourly debounce), `layout_specs` table (versioned, `pinned[]`), `POST /api/layout` (revert/pin), renderer `components/dashboard/adaptive-view.tsx`. **Proposal: evolve it in place** — SPEC concepts replace their v0 counterparts file-by-file — rather than a parallel module. Confirm.
2. **Registry vocabulary.** SPEC §2 has 8 components; the existing palette has 12 (incl. `documents`, `coming_up`, `kanban`, `procrastination_zone`, `suggested_zone` — real, used views SPEC doesn't know about). Proposal: registry v2 = SPEC's 8 (mapped onto existing zone renderers where they exist) **plus** those 5 as registry members, and update SPEC §2's table to match. `date_chase`, `people_index`, `focus_banner` are net-new renders.
3. **Planner model.** The app is OpenAI-based (`lib/openai.ts`, `TEXT_MODEL`, JSON mode already used by the v0 generator). SPEC §6 says "Haiku-class". Use the existing OpenAI small model (no new dependency), or add the Anthropic SDK?
4. **Project shape gaps (§4).** `projects` has no `deadline`, no subprojects, no `people`. Proposal: `deadline_type:"inferred"` = earliest dated open task/event per project (computable today); add nullable `projects.deadline` + `deadline_kind` for **committed** deadlines (set via chat tools); add `projects.parentId` for subprojects; people from the `memories` store until §11's entity store exists. Confirm the two schema additions.
5. **Preference store (§7.5).** New `layout_preferences` table vs a JSON column on `user` (calm_mode is a user column either way). Proposal: table (removable rows list cleanly in Settings).

## Where things are

- **Dashboard render path:** `app/(app)/dashboard/page.tsx` → `components/dashboard/dashboard-panel.tsx` (server component; fetches tasks/events/docs + `getCurrentLayout`, regenerates in background via `after()`) → `dashboard-views.tsx` → `adaptive-view.tsx` maps the stored spec onto zone components in `components/dashboard/zones.tsx` (+ `task-views.tsx`, `timeline-view.tsx`, `calendar-view.tsx`). Same panel is reused by the chat split workspace — adaptation automatically shows there too.
- **Data:** drizzle schema `lib/db/schema.ts` — `projects`, `tasks` (items; provenance columns link to `messages`), `events`, `conversations`/`messages` (chat transcripts; `extractedAt` high-water mark), `checkins` (accountability log), `memories`, `layout_specs`, `usage`. Queries in `lib/db/queries.ts`.
- **Chat agent:** tool schemas `lib/secretary/tool-schemas.ts` (zod → `openAIToolDefs()`), dispatch `lib/secretary/tools.ts` (`executeTool`). Extraction pipeline `lib/secretary/extraction.ts` (guardrail: read-only). Spreadsheet (audit floor): `app/(app)/spreadsheet/page.tsx` + `components/spreadsheet/` (guardrail: zero diffs).
- **Conventions:** Next 16 App Router (server components default), React 19, Tailwind v4 tokens in `app/globals.css`, zod v4, drizzle-kit push, vitest (`tests/*.test.ts`, `npm test`), OpenAI JSON mode for structured output. No new runtime deps.

## Concept → file mapping

| SPEC concept | File (evolves / new) |
|---|---|
| Registry v2 + prop schemas (§2) | `lib/layout/registry.ts` (new; supersedes `COMPONENT_PALETTE` in `spec.ts`) |
| LayoutPlan types + JSON schema (§3) | `lib/layout/plan.ts` (new; `spec.ts` types retired) |
| Validator, 3-pass, pure (§3) | `lib/layout/validator.ts` + `tests/layout-validator.test.ts` (F5) |
| Signals (§4) | `lib/layout/signals.ts` + `tests/layout-signals.test.ts` |
| planFromRules (§5) | `lib/layout/plan-from-rules.ts` + `tests/layout-fixtures.test.ts` (F1–F4, F6; shared fixtures in `tests/fixtures/layout/`) |
| planFromLLM + cache + fallback (§6) | `lib/layout/plan-from-llm.ts`; prompt `docs/adaptive-ui/planner-prompt.md`; replaces `generator.ts`'s inline prompt |
| Renderer + why-chips + diff animation | `components/dashboard/adaptive-view.tsx` + `zones.tsx` (extend: per-section props, why-chips, accent) |
| Plan history / revert / decision log | `layout_specs` table (add `reason_summary`, `signals_hash`, `outcome` columns) + `app/api/layout/route.ts` |
| Calm mode + preferences UI | `user.calmMode` column + `layout_preferences` table; `app/(app)/settings/page.tsx` |
| Chat tools tier 1 (§7.5) | `lib/secretary/tool-schemas.ts` + `tools.ts`: `get_current_plan`, `edit_layout_plan`, `set_layout_preference` (F7) |
| Canvas (§7.6, Phase 2.5) | `app/(app)/canvas/page.tsx`, `components/canvas/`, `lib/canvas/sanitize.ts` + `tests/canvas-sanitize.test.ts` (F9), `canvas_snapshots` table, prompt `docs/adaptive-ui/canvas-painter-prompt.md` |
| Slow loop (§7, Phase 3) | `lib/layout/wishlist.ts` (`wishlist.jsonl` in a per-user data dir or DB table — decide in Phase 3), `components/proposed/`, job in `scripts/` |
| Feature flag | `ADAPTIVE_V2` env var read in `dashboard-panel.tsx`; off = v0 behavior untouched |

## Signals gaps (§4) — what can't be computed today

- `engagement.mentions_24h`: messages aren't linked to projects; tasks/events carry `createdFromMessageId` only at creation. **Minimal capture:** during extraction, record `(message_id, project_id)` touches in a small `message_project_links` table; baseline = trailing 14-day median over it.
- `deadline_type: "committed"` and `subprojects`: need the two schema additions from Decision 4.
- `pending.unanswered_asks`: no store for questions the secretary asked. Minimal: reuse `checkins` with a new type, populated by extraction (full version is §11's expectations engine).
- `people`: no entity store yet (§11). Interim: parse from `memories`.
- Everything else (schedule_word_share, days_since_layout_change from `layout_specs` head, pinned, calendar density, calm_mode after Decision 5) computes from existing tables.
