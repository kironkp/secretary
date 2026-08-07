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
  create_event: z.object({
    title: z.string().min(1),
    starts_at: z.string().describe("Start date/time as ISO 8601 in the user's timezone"),
    ends_at: z.string().optional(),
    location: z.string().optional(),
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
    "Log a task the user needs to do. Call this the moment a to-do, deadline, or obligation comes up in conversation — don't wait to be asked.",
  update_task:
    "Change a task: status, due date, title, notes, or priority. Use when the user postpones ('I'll do it Friday'), starts, blocks, or edits something.",
  complete_task:
    "Mark a task done. Use when the user says they did it ('yeah I sent it this morning').",
  create_project: "Create a project to group related tasks (e.g. 'Mexico trip').",
  create_event:
    "Log a calendar event — meetings, appointments, social plans with a specific time.",
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
