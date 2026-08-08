// Adaptive layout engine (A-1…A-4): the AI arranges the dashboard from a FIXED
// component palette — it emits a small ordered spec, and the renderer maps it
// onto hand-built components. Never AI-generated HTML at runtime.
//
// ADAPTIVE-UI PRINCIPLES (learned the hard way — the Ash-meeting incident,
// where times/timezones/alarms got flattened into a bare task title):
// 1. The palette is FIXED. The model routes information into it; it never
//    invents UI. New life-patterns (recurring bills, travel, people) earn new
//    palette components — added deliberately, in code, never improvised.
// 2. NO WRITE-ONLY DATA. Every field a tool can write must have a visible
//    home in the UI (detail dialogs at minimum). If the model can store it,
//    the user can see it — otherwise the model's only move is to flatten
//    details into titles, or drop them.
// 3. Information that fits no structured slot goes to `notes`, and notes are
//    always viewable. Structured slots (reminders, due dates, locations) are
//    preferred; notes are the safety net, not the default.
// 4. RENDER COMPLETENESS (the Ash-meeting-invisible-on-Open-Loops incident):
//    every zone renders every entity type within its declared scope. A new
//    entity or field ships only together with its appearance in ALL covering
//    zones — "it's in the calendar" is not visibility. Current contract
//    (tripwired by tests/zone-completeness.test.ts):
//
//      component            | must display
//      ---------------------|-------------------------------------------
//      list (open loops)    | open tasks + upcoming events, w/ reminders
//      project_grid         | tasks + each project's next event
//      focus_card           | soonest of tasks AND events, w/ reminders+notes
//      coming_up            | task AND event reminders (48h)
//      timeline (5-week)    | task deadline pressure + event markers
//      calendar/calendar_strip | events + dated tasks
//      stat_tiles           | counts over tasks + events (next commitment)
//      kanban/board, procrastination_zone, suggested_zone | tasks by scope
import { z } from "zod";

export const COMPONENT_PALETTE = [
  "overdue_callout",
  "stat_tiles",
  "focus_card",
  "kanban",
  "list",
  "calendar_strip",
  "timeline",
  "procrastination_zone",
  "suggested_zone",
  "project_grid",
  "coming_up",
] as const;

export type LayoutComponent = (typeof COMPONENT_PALETTE)[number];

export const layoutSpecSchema = z.object({
  sections: z
    .array(
      z.object({
        component: z.enum(COMPONENT_PALETTE),
        title: z.string().nullable().describe("Optional custom heading; null for the default"),
      })
    )
    .min(1)
    .max(9),
});

export type LayoutSpec = z.infer<typeof layoutSpecSchema>;

/** What a spec row's jsonb column holds: the spec plus the data shape it was built for. */
export type StoredLayout = LayoutSpec & { dataHash: string };

/** The designed Overview (planning-documents/secretary-target.html): stats →
 *  next-up hero → 5-week pressure timeline → project cards → zones → open
 *  loops. This is what users see before the AI ever rearranges anything. */
export const DEFAULT_SPEC: LayoutSpec = {
  sections: [
    { component: "overdue_callout", title: null },
    { component: "stat_tiles", title: null },
    // renders nothing unless a reminder falls in the next 48h — safe to keep high
    { component: "coming_up", title: null },
    { component: "focus_card", title: null },
    { component: "timeline", title: null },
    { component: "project_grid", title: null },
    { component: "suggested_zone", title: null },
    { component: "procrastination_zone", title: null },
    { component: "list", title: null },
  ],
};

export type DataShape = {
  openTasks: number;
  overdue: number;
  dueToday: number;
  events7d: number;
  projects: number;
  suggestions: number;
  procrastinated: number;
  done7d: number;
  reminders24h: number;
};

/** Cheap change detector: same shape → no regeneration. */
export function dataHash(shape: DataShape): string {
  // bucket counts so a single new task doesn't churn the layout
  const b = (n: number) => (n === 0 ? 0 : n <= 2 ? 1 : n <= 5 ? 2 : n <= 12 ? 3 : 4);
  return [
    b(shape.openTasks),
    shape.overdue > 0 ? 1 : 0,
    b(shape.dueToday),
    b(shape.events7d),
    b(shape.projects),
    shape.suggestions > 0 ? 1 : 0,
    shape.procrastinated > 0 ? 1 : 0,
    b(shape.done7d),
    shape.reminders24h > 0 ? 1 : 0,
  ].join("-");
}
