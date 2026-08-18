# Claude Code prompt — capture fidelity: details must land somewhere concrete (events, reminders, detail views)

Copy everything below the line into Claude Code, run from the repo root.

---

Real-use failure to fix. By voice I said: *"I scheduled a meeting with Ash for 11am Pacific Time on Monday. Add the East Coast time on there. I need to set alarms for ten minutes before, five minutes before, and the actual time of the meeting."*

The secretary UNDERSTOOD everything — it replied "Ash meeting is 11:00 AM Pacific / 2:00 PM Eastern, with alarms for 10:50, 10:55, and 11:00 AM PT" and correctly admitted it can't set device alarms. But all that landed in the system was **one flat task titled "Add East Coast time and alarms to Ash meeting"** under DAW patent. The times, the timezone conversion, the three alarm times — gone, or invisible. The existing event ("Patent meeting with Ash · 11:00 AM", visible in the today strip) wasn't touched. And task rows in the dashboard aren't clickable, so even if details had been stored in `notes`, I couldn't see them.

The failure mode: **the model comprehends details but the system gives it nowhere concrete to put them, and the UI gives me no way to see what it did store.** Fix the whole chain: data model → tools → persona → UI.

Read the current state of `lib/db/schema.ts`, `lib/secretary/tool-schemas.ts`, `lib/secretary/tools.ts`, `lib/secretary/persona.ts`, `lib/secretary/briefing.ts`, and the dashboard components before changing anything — a previous round already added project-move/merge tools and an honesty rule; build on that, don't duplicate it.

As always: the voice/audio plumbing is FROZEN (`lib/realtime/openai-webrtc.ts`, `lib/realtime/remote-audio.ts`, `app/api/realtime/*`).

## Phase 1 — data model + tools: give details a home

1. **Events become editable.** There is create_event but no way to update or delete one — "I can't edit the existing calendar event" was literally true. Add `update_event` (fuzzy find by title fragment like `findTask` does; change title, starts_at, ends_at, location, notes) and `delete_event`. Drizzle migration: add `notes` to events if it doesn't exist.
2. **Reminders become first-class.** Add a `reminders` column (jsonb array of ISO timestamps, default `[]`) to BOTH tasks and events. Expose on create_task/update_task/create_event/update_event as `reminders: string[]` ("exact times as ISO 8601 in the user's timezone"). The Ash request maps to: update the event with notes "11:00 AM PT / 2:00 PM ET" + reminders [10:50, 10:55, 11:00 PT on Monday].
3. **Honest reminder semantics.** No push notifications exist yet, so: (a) tool result for reminder writes includes `"delivery": "logged-only"`; (b) persona tells the model to say reminders are logged on the dashboard but won't ring the device yet; (c) the briefing gains a line for today's upcoming reminders ("Reminders today: 10:50 AM, 10:55 AM — Ash meeting") so the secretary can actually surface them at session start — that's the delivery mechanism we DO have.
4. **Persona rule — capture fidelity:** every concrete detail the user states (times, timezone conversions, alarm offsets, names, places, amounts) must be written into structured fields or `notes` via tools in the same turn. A detail that exists only in the conversation transcript is a dropped detail. When the user says "add X to that meeting," prefer updating the existing event/task over creating a parallel task about it (creating a companion task is fine ONLY for genuine to-dos).
5. Tool descriptions updated so the model knows it can now edit events and set reminders. Keep the flat Realtime-compatible schema shape.

## Phase 2 — UI: nothing is write-only

1. **Task detail view.** Clicking any task row (open-loops list, board cards, project cards, timeline) opens a detail panel/popover: full title, project, status, due, priority, **notes rendered in full**, **reminders as time chips**, source + "heard" date, provenance link to the exact conversation moment, and the check-in history (postpones, status changes). Quick inline edits for due date, project, and status are welcome but secondary — SEEING everything is the requirement.
2. **Event details too.** Events (today strip, calendar, timeline) get the same treatment: click → title, time (show the user's timezone; if notes contain another timezone, it's visible), location, notes, reminders, provenance.
3. **Reminders visible at a glance** where there's room: a small clock chip on rows/cards that have reminders (e.g. "⏰ 3"), full list in the detail view.
4. **Audit for write-only data:** list every column tools can write (tasks, events, projects, memories) and verify each is visible somewhere in the UI. Fix any others you find (e.g. if `remindAt` exists but renders nowhere, fold it into the new reminders; if notes were already invisible everywhere, this phase fixes that globally).
5. Detail views must work in the split-pane dashboard AND the standalone /dashboard, both themes, mobile widths. Live-refresh (from the last round) must close/refresh gracefully if an open detail's task changes.

## Phase 3 — encode the adaptive-UI principle (small but important)

The product vision: the dashboard adapts to each user's life. The rule that keeps that sane: **the model never invents UI — it routes information into a fixed, polished component palette; the palette grows deliberately, in code.** This incident showed the palette was missing slots (notes display, reminders, event editing), so the model's only move was to flatten everything into a task title.

1. Write this principle down where future work will see it: extend the header comment in `lib/layout/spec.ts` (or a short `planning-documents/adaptive-ui-principles.md`) covering: fixed palette; every tool-writable field must have a visible home ("no write-only data"); when information fits no structured slot it goes to `notes`, which is always viewable; new life-patterns (recurring bills, travel, people) get new palette components/slots added in code, never improvised HTML.
2. Cheap adaptive win to prove the loop: if a user has any reminders in the next 24h, the layout generator may include a small "Coming up" strip (time + title, from tasks AND events). Add it to the component palette and renderer. Keep it minimal.

## Phase 4 — verify end-to-end (through the secretary itself, in split view)

1. Voice: "Add the East Coast time and the three alarms onto the Ash patent meeting." → the EVENT gets notes + 3 reminders (live update in the right pane), no new junk task. Click the event: 11:00 AM PT with ET noted, reminders 10:50 / 10:55 / 11:00.
2. Voice: "Remind me 30 minutes before the Caltrans budget is due." → reminder lands on that task, chip visible, detail view shows it.
3. Click any task row → detail view shows notes, reminders, provenance, history.
4. Ask the secretary what reminders exist today → it answers from the briefing.
5. `npm run build`, lint, vitest green; migration runs cleanly on the local DB (existing rows default to `[]` reminders).

Also do a one-off repair of the current bad state OR just perform test #1 live — either way, the "Add East Coast time and alarms to Ash meeting" task should end up either deleted (if fully absorbed into the event) or carrying the real details, not a bare title.
