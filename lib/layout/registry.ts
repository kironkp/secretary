// Component registry v2 (SPEC §2 + INTEGRATION Decision 2): the ONLY building
// blocks a planner may reference. SPEC's 8 components plus the 5 pre-existing
// zones this app already ships. v0's overdue_callout retires into focus_banner.
//
// Adding a component = bump REGISTRY_VERSION + add its prop schema here + add
// a render arm in components/dashboard/plan-view.tsx + update SPEC §2's table.
// Never mid-session. Generated code never registers itself.
import { z } from "zod";

export const REGISTRY_VERSION = 2;

// Props are optional throughout (SPEC §2 v1.2 note): a section with omitted
// props renders its computed-from-data default, which is what DEFAULT_PLAN
// relies on. The planner sets props only to deviate from those defaults.
export const PROP_SCHEMAS = {
  focus_banner: z
    .object({
      text: z.string().max(200),
      tone: z.enum(["info", "serious", "critical"]).default("info"),
    })
    .strict(),
  hero_next_up: z.object({ event_id: z.string().optional() }).strict(),
  stat_row: z
    .object({
      tiles: z
        .array(
          z
            .object({
              value: z.string(),
              label: z.string(),
              tone: z.enum(["neutral", "good", "warn", "bad"]).optional(),
            })
            .strict()
        )
        .max(5)
        .optional(),
    })
    .strict(),
  project_card: z
    .object({
      project_id: z.string(),
      variant: z.enum(["full", "compact", "nested"]).default("full"),
      accent: z.boolean().default(false),
      inline_loops: z.boolean().default(false),
    })
    .strict(),
  timeline: z
    .object({
      span_days: z.union([z.literal(14), z.literal(21), z.literal(35)]).default(21),
      expanded: z.boolean().default(false),
    })
    .strict(),
  open_loops: z
    .object({
      group_by: z.enum(["project", "date"]).default("project"),
      include_done: z.boolean().default(true),
    })
    .strict(),
  date_chase: z.object({ item_ids: z.array(z.string()).optional() }).strict(),
  people_index: z.object({}).strict(),
  // Pre-existing zones kept as registry members (Decision 2):
  documents: z.object({}).strict(),
  coming_up: z.object({}).strict(),
  kanban: z.object({}).strict(),
  procrastination_zone: z.object({}).strict(),
  suggested_zone: z.object({}).strict(),
} as const;

export const REGISTRY_COMPONENTS = Object.keys(PROP_SCHEMAS) as RegistryComponent[];
export type RegistryComponent = keyof typeof PROP_SCHEMAS;

export function isRegistryComponent(name: unknown): name is RegistryComponent {
  return typeof name === "string" && name in PROP_SCHEMAS;
}
