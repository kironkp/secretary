// Tool definitions shared by the Realtime session (voice) and the Responses
// API (text chat). One source of truth: zod schemas → OpenAI JSON schemas.
import { z } from "zod";

export const toolSchemas = {
  create_task: z.object({
    title: z.string().min(1).describe("Short imperative title, e.g. 'Renew passport'"),
    notes: z.string().optional().describe("Extra context worth keeping"),
    due_at: z
      .string()
      .optional()
      .describe("Due date/time as ISO 8601 in the user's timezone, if mentioned"),
    project: z.string().optional().describe("Project name to file it under (created if new)"),
    priority: z.number().int().min(0).max(3).optional().describe("0 none · 1 low · 2 medium · 3 high"),
    reminders: z
      .array(z.string())
      .optional()
      .describe("Reminder times — exact ISO 8601 timestamps in the user's timezone"),
    stages: z
      .array(z.string())
      .optional()
      .describe(
        "For genuinely multi-step deliverables: ordered stage names, e.g. ['Outline','Draft','Review with Marissa','Submit']"
      ),
    recurrence: z
      .enum(["daily", "weekly", "monthly", "yearly"])
      .optional()
      .describe("Recurring task: completing it spawns the next occurrence from its due date"),
  }),
  update_task: z.object({
    task: z.string().min(1).describe("Task id, or a distinctive fragment of its title"),
    status: z
      .enum(["inbox", "todo", "in_progress", "blocked", "done", "dropped"])
      .optional(),
    due_at: z.string().optional().describe("New due date/time, ISO 8601"),
    title: z.string().optional(),
    notes: z.string().optional(),
    priority: z.number().int().min(0).max(3).optional(),
    project: z
      .string()
      .optional()
      .describe(
        'Move the task into this project (fuzzy-matched against existing names). The literal value "none" removes it from its project.'
      ),
    reminders: z
      .array(z.string())
      .optional()
      .describe("Replace the task's reminder times — exact ISO 8601 timestamps; [] clears them"),
    stages: z
      .array(z.string())
      .optional()
      .describe("Replace the task's stage list (ordered names); [] removes staging"),
    stage_done: z
      .string()
      .optional()
      .describe("Mark this stage complete (fuzzy name match), e.g. user says 'outline's done'"),
    recurrence: z
      .enum(["daily", "weekly", "monthly", "yearly", "none"])
      .optional()
      .describe('Make the task recurring, or "none" to stop it recurring'),
    postpone_reason: z
      .string()
      .optional()
      .describe("If the user is pushing the due date, why (logged as a check-in)"),
  }),
  complete_task: z.object({
    task: z.string().min(1).describe("Task id, or a distinctive fragment of its title"),
  }),
  create_project: z.object({
    name: z.string().min(1),
    color: z.string().optional().describe("Hex color like #7aa2ff"),
  }),
  list_projects: z.object({}),
  update_project: z.object({
    project: z.string().min(1).describe("Existing project name (fuzzy-matched)"),
    name: z.string().optional().describe("Rename the project to this"),
    color: z.string().optional().describe("Hex color like #7aa2ff"),
    merge_into: z
      .string()
      .optional()
      .describe("Move ALL of its tasks into this other project, then delete it"),
    delete: z
      .boolean()
      .optional()
      .describe("Delete the project — only allowed when it has no tasks (use merge_into otherwise)"),
  }),
  create_event: z.object({
    title: z.string().min(1),
    starts_at: z.string().describe("Start date/time as ISO 8601 in the user's timezone"),
    ends_at: z.string().optional(),
    location: z.string().optional(),
    project: z
      .string()
      .optional()
      .describe(
        "Project to file it under (fuzzy-matched) — a meeting about an ongoing workstream belongs to that project"
      ),
    notes: z
      .string()
      .optional()
      .describe("Detail worth keeping — e.g. timezone conversions ('11:00 AM PT / 2:00 PM ET')"),
    reminders: z
      .array(z.string())
      .optional()
      .describe("Reminder times — exact ISO 8601 timestamps in the user's timezone"),
  }),
  update_event: z.object({
    event: z.string().min(1).describe("Event id, or a distinctive fragment of its title"),
    title: z.string().optional(),
    starts_at: z.string().optional().describe("New start, ISO 8601"),
    ends_at: z.string().optional(),
    location: z.string().optional(),
    notes: z.string().optional(),
    project: z
      .string()
      .optional()
      .describe('Move the event into this project (fuzzy-matched); "none" unfiles it'),
    reminders: z
      .array(z.string())
      .optional()
      .describe("Replace the event's reminder times — exact ISO 8601 timestamps; [] clears them"),
  }),
  delete_event: z.object({
    event: z.string().min(1).describe("Event id, or a distinctive fragment of its title"),
  }),
  create_document: z.object({
    title: z.string().min(1),
    project: z.string().optional().describe("Project it belongs to (fuzzy-matched)"),
    sections: z
      .array(z.object({ heading: z.string().min(1), content: z.string() }))
      .optional()
      .describe("Initial outline — headings with content (content may be empty to start)"),
  }),
  list_documents: z.object({}),
  read_document: z.object({
    document: z.string().min(1).describe("Document id, or a fragment of its title ('the budget doc')"),
    section: z
      .string()
      .optional()
      .describe("Read just this section (fuzzy heading match, or a number like '2'). Long docs REQUIRE section-level reads."),
  }),
  edit_document_section: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
    section: z.string().min(1).describe("Section heading (fuzzy) or number"),
    content: z
      .string()
      .optional()
      .describe("The section's NEW full text (replaces the old text)"),
    heading: z.string().optional().describe("Rename the section to this"),
    append: z
      .string()
      .optional()
      .describe("Text to add to the END of the section instead of replacing"),
  }),
  add_document_section: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
    heading: z.string().min(1),
    content: z.string().optional(),
    after: z.string().optional().describe("Insert after this existing section (fuzzy); default: at the end"),
  }),
  remove_document_section: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
    section: z.string().min(1).describe("Section heading (fuzzy) or number"),
  }),
  revert_document: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
  }),
  update_document: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
    title: z.string().optional(),
    project: z.string().optional().describe('Move to this project (fuzzy); "none" unfiles it'),
  }),
  delete_document: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
  }),
  get_agenda: z.object({
    date: z
      .string()
      .optional()
      .describe("'today' (default), 'tomorrow', or a YYYY-MM-DD date"),
  }),
  get_overdue: z.object({}),
  get_tasks: z.object({
    status: z
      .enum(["inbox", "todo", "in_progress", "blocked", "done", "dropped"])
      .optional(),
    project: z.string().optional().describe("Filter to a project by name"),
  }),
  remember_fact: z.object({
    fact: z.string().min(1).describe("A durable fact about the user worth remembering"),
    tags: z.array(z.string()).optional(),
  }),
  recall_facts: z.object({}),
  get_current_datetime: z.object({}),
  search_history: z.object({
    query: z.string().min(1).describe("Text to search past conversations for"),
  }),
  // --- Layout tools (SPEC §7.5 tier 1): the dashboard's arrangement is data ---
  get_current_plan: z.object({}),
  edit_layout_plan: z.object({
    operations: z
      .array(
        z.discriminatedUnion("op", [
          z.object({
            op: z.literal("remove"),
            section: z.string().describe("Section key, e.g. 'timeline' or 'project_card:<project_id>'"),
          }),
          z.object({
            op: z.literal("move"),
            section: z.string().describe("Section key to move"),
            to: z.number().int().min(0).describe("New position, 0 = top"),
          }),
          z.object({
            op: z.literal("set_props"),
            section: z.string().describe("Section key to change"),
            props: z
              .record(z.string(), z.unknown())
              .describe("New props merged over current, e.g. {\"variant\":\"compact\"} or {\"expanded\":true}"),
          }),
          z.object({
            op: z.literal("add"),
            component: z.string().describe("Registry component to add"),
            props: z.record(z.string(), z.unknown()).optional(),
            at: z.number().int().min(0).optional().describe("Position; omit = end"),
          }),
        ])
      )
      .min(1),
  }),
  // --- Canvas tools (SPEC §7.6): the model-painted visual surface ---
  paint_canvas: z.object({
    brief: z
      .string()
      .min(1)
      .describe(
        "What to paint, in the user's words plus any specifics they gave, e.g. 'my week as a timeline with the album work highlighted'"
      ),
  }),
  edit_canvas: z.object({
    patch: z
      .string()
      .min(1)
      .describe("The targeted change, e.g. 'make the album section bigger' — the rest stays"),
  }),
  set_layout_preference: z.object({
    kind: z.enum(["ban_component", "pin_section", "default_variant_for", "accent_policy"]),
    component: z
      .string()
      .optional()
      .describe("ban_component: the registry component to never show, e.g. 'people_index'"),
    section: z.string().optional().describe("pin_section: section key to freeze in place"),
    project: z.string().optional().describe("default_variant_for: project name or id"),
    variant: z.enum(["full", "compact", "nested"]).optional().describe("default_variant_for: the variant"),
    policy: z.enum(["never", "auto"]).optional().describe("accent_policy: 'never' kills the glow ring"),
    remove: z.boolean().optional().describe("true = delete this preference instead of adding it"),
  }),
} as const;

export type ToolName = keyof typeof toolSchemas;

const toolDescriptions: Record<ToolName, string> = {
  create_task:
    "Log a task the user needs to do. Call this the moment a to-do, deadline, or obligation comes up in conversation — don't wait to be asked. Supports notes, reminder times, stages (multi-step deliverables), and recurrence (e.g. rent monthly).",
  update_task:
    "Change a task: status, due date, title, notes, priority, MOVE IT TO ANOTHER PROJECT (project: name, or \"none\"), define stages, mark a stage done (stage_done: 'outline'), or set/clear recurrence. Use when the user postpones, starts, advances a stage, or edits anything.",
  complete_task:
    "Mark a task done. Use when the user says they did it ('yeah I sent it this morning').",
  create_project:
    "Create a project to group related tasks (e.g. 'Mexico trip'). Check list_projects first — close names are matched to existing projects instead of creating duplicates.",
  list_projects:
    "All projects with open/done counts. Check this before filing a task when unsure of the exact project name.",
  update_project:
    "Rename a project, change its color, MERGE it into another (merge_into moves all tasks then deletes the duplicate), or delete an empty one. Use this to clean up duplicate projects.",
  create_event:
    "Log a calendar event — meetings, appointments, social plans with a specific time. Supports notes (timezone conversions, agenda) and reminder times.",
  update_event:
    "Edit an EXISTING event: retitle, move its time, set location, add notes (e.g. an East-Coast time conversion), or set reminder times. When the user says 'add X to that meeting', use THIS — don't create a task about it.",
  delete_event: "Remove an event that was cancelled or logged by mistake.",
  create_document:
    "Start a real living document under a project — duty statements, budgets, drafts. Give it outline sections up front when the shape is known.",
  list_documents: "All documents with their project, section headings, and last-edited time.",
  read_document:
    "Read a document. For long documents you get headings only — read one section at a time (section: heading fragment or number). Summarize aloud; don't recite long text verbatim unless asked.",
  edit_document_section:
    "Rewrite one section of a document (content replaces the section's text; append adds to it). The previous state is snapshotted — edits are always revertible. Confirm briefly what changed.",
  add_document_section: "Add a new section to a document.",
  remove_document_section: "Remove a section (snapshotted first — revertible).",
  revert_document:
    "Undo the last change to a document, restoring the previous version. Use when the user says 'go back to how it was'.",
  update_document: "Rename a document or move it to another project.",
  delete_document: "Delete a document entirely. Confirm with the user first.",
  get_agenda: "Tasks due and events happening on a given day.",
  get_overdue: "All open tasks past their due date.",
  get_tasks: "List the user's tasks, optionally filtered by status or project.",
  remember_fact:
    "Save a durable fact about the user (names, preferences, context) for future conversations.",
  recall_facts: "Everything remembered about the user.",
  get_current_datetime:
    "The current date and time in the user's timezone. Use this instead of guessing — never assume the date.",
  search_history: "Search past conversation transcripts.",
  get_current_plan:
    "The dashboard's current layout plan: sections in order (with keys), the component registry, and the user's stored layout preferences. Call before editing the layout.",
  edit_layout_plan:
    "Rearrange the user's dashboard NOW: move/remove/add sections or change their props (variant, expanded, accent). User-initiated changes apply immediately. For 'never show X again' use set_layout_preference instead.",
  paint_canvas:
    "Paint the Canvas page: a free-form visual the user watches build live — posters, charts, big-number summaries, week views. Use for ANY 'show me / draw / visualize' ask ('paint my week'). Never say you can't draw — this is how you draw. The result appears on the Canvas tab; say so.",
  edit_canvas:
    "Targeted change to the current canvas ('make the album section bigger') without repainting the rest. Requires an existing canvas — otherwise use paint_canvas.",
  set_layout_preference:
    "Store a durable layout preference: ban_component ('stop showing me people' → component: people_index), pin_section (freeze a section), default_variant_for (a project always compact/full/nested), accent_policy: never ('I hate the glowing ring'). remove: true deletes it. Enforced on every future plan until removed in Settings.",
};

/** OpenAI tool definitions (same flat shape works for Realtime and Responses). */
export function openAIToolDefs() {
  return (Object.keys(toolSchemas) as ToolName[]).map((name) => ({
    type: "function" as const,
    name,
    description: toolDescriptions[name],
    parameters: z.toJSONSchema(toolSchemas[name]),
  }));
}
