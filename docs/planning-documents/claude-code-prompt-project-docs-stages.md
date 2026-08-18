This round is about a shift in what Secretary is: right now projects only *track* my work. I want projects to be where work actually *happens*. You decide the architecture, schemas, tool design, and UI structure — you know this codebase and you'll make better implementation calls than a spec would. What follows is the vision, the scenes it has to serve, and the guardrails. Everything else is yours.

## The idea

Three capabilities, one theme — my stuff lives in the app, and I can work on it by talking:

1. **Documents that belong to projects.** Real, living documents — not tasks pretending to be documents.
2. **Progress that's visible.** Multi-step work shows its stages, not just done/not-done.
3. **Recurring things recur.** Rent, monthly reports — say it once, it keeps coming back.

Explicitly OUT of scope this round: notifications of any kind. Reminders stay dashboard-and-conversation only.

## The scenes this must serve (my real life, use these as acceptance tests)

**Scene 1 — the car.** I'm driving. I start a voice call and say "let's work on my duty statement." The secretary knows it's the Caltrans document, reads me what we have — or the one section I ask for, not a ten-minute recitation. I say "make the second responsibility stronger, emphasize that I supervise the auditorium project." It rewrites that section, tells me briefly what changed, and if I'm home with the split view open, I watch the document update on the right while we keep talking. If it botched an edit, "go back to how it was" works. Nothing I do by voice can permanently destroy writing.

**Scene 2 — the stages.** "Complete new duty statement" isn't a checkbox in real life. It's outline → draft → review with Marissa → submit. I want to see where I am at a glance — on the task, on the project card — and move it forward by saying "outline's done." Same for the DTC auditorium budget. The secretary should also be smart about offering this: when I mention a genuinely multi-step deliverable, it can propose breaking it down — but it shouldn't decorate every little errand with a checklist.

**Scene 3 — the deliverable.** The duty statement eventually goes to Caltrans as a real file. When the draft is ready I need to get it out of the app in a format an office accepts (Word, at minimum). One obvious button, not a ceremony.

**Scene 4 — the rent problem.** "Remind me to pay rent on the first, every month." That's one sentence from me, and from then on the task reappears each month after I complete it. The dashboard should make recurring items recognizable.

**Scene 5 — the quiet nudge.** If a document I care about hasn't moved in days, the secretary can mention it in conversation or the briefing — "your duty statement hasn't moved since Tuesday, want to work on it?" Conversational accountability, not alarms.

## Guardrails (the few things I actually insist on)

- **Voice-first ergonomics rule everything.** Tool interactions must fit how people talk: fuzzy references ("the budget doc"), section-level reading and editing, short confirmations of what changed. Be deliberate about how much document content flows through the realtime session — a long doc must never degrade or blow up a call.
- **The honesty rule extends to documents.** The secretary confirms edits from what tools actually returned. It never claims a doc changed when it didn't, and it says so plainly when something's beyond its tools.
- **No write-only data.** Every new thing (docs, versions, stages, recurrence) is visible and reachable in the UI — and follows the render-completeness principle already established: every zone that claims a scope shows everything in that scope. Live-refresh during calls applies to all of it.
- **Frozen:** the voice/audio plumbing (`lib/realtime/openai-webrtc.ts`, `lib/realtime/remote-audio.ts`, `app/api/realtime/*`). And don't regress the accumulated wins: honesty, fuzzy project matching, live refresh, detail views, reminders, events-in-every-zone.
- **Fits the design system:** both themes, split view and standalone dashboard, phone widths. Read the adaptive-UI principles doc in planning-documents and update it for the new capabilities.

## Setup for me

Seed my actual Caltrans work so I can test the moment you're done: a "Duty statement" doc and a "DTC auditorium budget" doc under the Caltrans project (sensible outline headings are fine), with their two existing tasks staged appropriately.

## Working style

Read the current state of the codebase first — many rounds have landed and file descriptions from earlier prompts are stale. Then work through your plan in phases, committing per phase, WITHOUT stopping to check in. Do a thorough final QA sweep (both themes, key widths, build/lint/tests green, new behavior covered by tests where they earn their keep). Then come back to me exactly once with: what you built and why you shaped it that way, any judgment calls, and a short car-test script — the exact things I should say on a voice call and what I should watch happen.
