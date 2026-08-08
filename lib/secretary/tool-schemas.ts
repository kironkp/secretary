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
} as const;

export type ToolName = keyof typeof toolSchemas;

const toolDescriptions: Record<ToolName, string> = {
  create_task:
    "Log a task the user needs to do. Call this the moment a to-do, deadline, or obligation comes up in conversation — don't wait to be asked. Supports notes and reminder times.",
  update_task:
    "Change a task: status, due date, title, notes, priority, or MOVE IT TO ANOTHER PROJECT (project: name, or \"none\" to unfile it). Use when the user postpones ('I'll do it Friday'), starts, blocks, edits, or refiles something.",
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
  get_agenda: "Tasks due and events happening on a given day.",
  get_overdue: "All open tasks past their due date.",
  get_tasks: "List the user's tasks, optionally filtered by status or project.",
  remember_fact:
    "Save a durable fact about the user (names, preferences, context) for future conversations.",
  recall_facts: "Everything remembered about the user.",
  get_current_datetime:
    "The current date and time in the user's timezone. Use this instead of guessing — never assume the date.",
  search_history: "Search past conversation transcripts.",
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
