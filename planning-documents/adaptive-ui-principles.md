# Adaptive-UI principles

The product vision is a dashboard that adapts to each user's life. These rules
keep that sane. They were learned from real incidents (noted inline) and are
partially enforced by `tests/zone-completeness.test.ts`. The short version
lives as a comment atop `lib/layout/spec.ts`.

## 1. The palette is fixed

The model never invents UI. It routes information into a fixed, polished
component palette (`COMPONENT_PALETTE` in `lib/layout/spec.ts`) by emitting a
small ordered layout spec. New life-patterns (recurring bills, travel, people,
documents) earn **new palette components, added deliberately in code** — never
improvised HTML at runtime.

## 2. No write-only data

Every field a tool can write must have a visible home in the UI (the detail
dialogs are the floor). If the model can store it and the user can't see it,
the model's only move is to flatten details into titles — or drop them.
*(Incident: the Ash meeting's timezone conversion and alarm times were
perfectly captured into a task's `notes`… which rendered nowhere.)*

## 3. Notes are the safety net, not the default

Information that fits no structured slot goes to `notes`, and notes are always
viewable. Structured slots (reminders, due dates, stages, recurrence,
locations, sections) are preferred — they're what zones can render and reason
over.

## 4. Render completeness

Every zone renders **every entity type within its declared scope**, and a new
entity or field ships only together with its appearance in all covering zones.
"It's in the calendar" is not visibility. *(Incident: events were calendar-only
footnotes — invisible in Open Loops and Projects, the zones actually looked
at.)*

Current contract (tripwired by `tests/zone-completeness.test.ts`):

| Palette component | Must display |
|---|---|
| `list` (Open loops) | open tasks + upcoming events (14d), with stage/recurrence/reminder chips |
| `project_grid` | tasks + each project's next event |
| `focus_card` (Next up) | soonest of tasks AND events, with reminders + notes |
| `coming_up` | task AND event reminders (48h) |
| `timeline` (5-week) | task deadline pressure + event markers |
| `documents` | all documents with project, freshness, outline |
| `calendar` / `calendar_strip` | events + dated tasks |
| `stat_tiles` | counts over tasks + events |
| `kanban`, `procrastination_zone`, `suggested_zone` | tasks in their scope |
| task rows, anywhere | stage progress + recurrence + reminder chips |
| detail dialogs / document page | every tool-writable field, including history/versions |

## 5. Voice-first content budgets

Zones and tools serve a realtime voice session. Document reads are
section-level by design: `read_document` returns headings-only above ~1,500
chars and caps any section at 4,000 — a long document must never degrade or
blow up a call. The same instinct applies to any future large entity.

## 6. Destructive-by-voice is forbidden

Anything the user can change by talking must be recoverable: document edits
snapshot the prior state (`document_versions`, last 20 kept), reverts are
themselves revertible, and the honesty rule requires confirming what tools
actually returned — never intentions.
