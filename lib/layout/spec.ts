// Adaptive layout engine (A-1…A-4): the AI arranges the dashboard from a FIXED
// component palette — it emits a small ordered spec, and the renderer maps it
// onto hand-built components. Never AI-generated HTML at runtime.
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
    .max(8),
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
  ].join("-");
}
