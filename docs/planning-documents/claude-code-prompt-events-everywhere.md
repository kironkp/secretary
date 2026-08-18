Follow-up to the capture-fidelity work, which succeeded at the data layer: I re-ran the Ash request by voice and the secretary correctly updated the existing calendar event (11:00 AM PT / 2:00 PM ET, reminders 10:50 / 10:55 / 11:00) and was honest about phone alarms. **But on the dashboard, that update is only visible if I dig into the Calendar view.** Open Loops shows nothing about it. Projects shows nothing. The default zones — the ones I actually look at — are blind to it, because they render tasks only. That makes the capture useless in practice.

**The requirement, stated once and applying everywhere: when the secretary logs or updates something, it must show up clearly in EVERY view whose scope covers it — Open Loops, Projects, focus card, calendar, timeline, all of it — immediately.** Events and their reminders are peers of tasks, not calendar-only footnotes.

**Working style for this run: do NOT stop for review between phases.** Work through all phases autonomously, commit per phase with clear messages, and come back to me once with a final report when every single thing is done (what changed, migrations run, and a 2-minute voice test script for me). Run a thorough final QA sweep before reporting.

The voice/audio plumbing remains FROZEN (`lib/realtime/openai-webrtc.ts`, `lib/realtime/remote-audio.ts`, `app/api/realtime/*`). Don't regress the recent wins: honesty rule, project fuzzy-matching, live refresh during calls, detail views, reminders.

Read current state first — several rounds have landed since any description of these files was written: `lib/db/schema.ts`, `lib/secretary/tool-schemas.ts`, `lib/secretary/tools.ts`, `lib/secretary/briefing.ts`, `components/dashboard/*` (especially `zones.tsx`, `dashboard-views.tsx`), `lib/layout/spec.ts`.

## Phase 1 — events join the project graph

The structural root cause: **events have no project association**, so no project-grouped view can ever show them.

1. Migration: `events.projectId` (nullable FK to projects).
2. `create_event` / `update_event` accept `project` (resolved through the same fuzzy `resolveProject` path as tasks; same "file into an existing project unless genuinely new" briefing guidance).
3. Briefing: upcoming-events lines include their project; the PROJECTS section counts include upcoming events (e.g. `"DAW patent" (1 open task · 1 event this week)`).
4. Persona: when a meeting/event relates to an ongoing workstream, file it under that project — same rule as tasks.
5. One-off repair: link the existing "Patent meeting with Ash" event to the DAW patent project.

## Phase 2 — unified visibility across every zone

1. **Open Loops** becomes tasks + upcoming events, grouped by project. Event rows are visually distinct (calendar icon instead of checkbox, start time in WHEN — with the secondary timezone if the event notes carry one, reminders chip like "⏰ 3"), sorted into the group by date alongside tasks. Clicking opens the event detail view from the last round. Events with no project group under a "No project" section only if any exist. Past events drop out; "upcoming" = next 14 days (pick a sensible constant, document it).
2. **Project cards (ProjectGrid)** show the project's next event line (icon, title, "Mon 11:00 AM PT", reminders chip) alongside the task list and progress. The project's "next" date chip (e.g. "in 2d") must consider events too, not just task due dates.
3. **Focus/hero card** (the big "next thing" at the top): eligible items include events — the next event with reminders or happening soonest competes with the top task. When it's an event, show its concrete details inline: time in both timezones when known, reminder times.
4. **Coming-up reminders strip**: verify it exists in the component palette (from the last round), renders BOTH task and event reminders with actual times, and sits high in the DEFAULT_SPEC whenever any reminder falls in the next 48h. If it was never wired into the default layout, wire it now.
5. **Next-5-weeks chart**: add small event markers (dots/diamonds on the project's row at the event date) so meetings appear in the pressure picture. Keep it subtle; deadline pressure stays the star. Skip only if it genuinely hurts readability — and say so in the final report if you do.
6. Live-refresh + the entrance animation apply to event rows/cards exactly like tasks, in both the split pane and /dashboard, both themes, mobile widths.

## Phase 3 — make "render completeness" a permanent rule

1. Extend the adaptive-UI principles doc from the last round with the render-completeness rule: *every zone renders every entity type within its declared scope; a new entity or field ships only together with its appearance in all covering zones.* Include a small table: palette component × entity types it must display.
2. Enforce it cheaply in tests: with fixture data (one project, one task with reminders, one event with project + notes + reminders), assert that the open-loops zone, project grid, focus card, and coming-up strip each render the event and its reminder chip. Use whatever component-testing setup exists or is lightest to add; if full component tests are impractical, test the data-shaping functions that feed each zone instead — the point is a regression tripwire, not testing theater.

## Phase 4 — final QA sweep + report (then come back to me, once)

1. Verify the repaired Ash event now appears in: Open Loops under DAW patent (with ⏰ 3 and PT time), the DAW patent project card, the focus card (if it's the next thing), the coming-up strip (on Monday), calendar, timeline.
2. Full sweep: both themes × {split view, /dashboard, all dashboard views, detail views} × {1280px, 390px}. `npm run build`, lint, all vitest (old + new) green. No console errors during a dashboard render.
3. Report back with: what changed per phase, the migration(s) run, any judgment calls (e.g. chart markers), anything you found via the render-completeness audit beyond events, and a short voice test script for me — including one turn that should update an event and one that should create a project-filed event from scratch ("set up a jazz rehearsal Thursday 7pm under the Jazz project, remind me an hour before"), with exactly what I should see change live in each zone.
