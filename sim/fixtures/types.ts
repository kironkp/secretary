// Fixture schemas — zod-validated on load so bad generated fixtures fail fast.
import { z } from "zod";

export const personaSchema = z.object({
  id: z.string().regex(/^p-[a-z0-9-]+$/),
  name: z.string(),
  seed: z.number().int(),
  timezone: z.string(),
  background: z.string(),
  style: z.object({
    verbosity: z.enum(["terse", "normal", "rambly"]),
    typos: z.boolean(),
    selfCorrections: z.enum(["never", "sometimes", "often"]),
  }),
  quirks: z.array(z.string()),
});
export type Persona = z.infer<typeof personaSchema>;

export const expectedOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("task_created"),
    title_like: z.string(),
    count: z.number().int().optional(),
    due: z.string().optional(), // "+1d", "today", ISO
    project: z.string().optional(),
    recurrence: z.string().optional(),
    reminders_count: z.number().int().optional(),
    stages_count: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("task_updated"),
    title_like: z.string(),
    status: z.string().optional(),
    stage_done: z.string().optional(),
    due: z.string().optional(),
    // SPEC §11: a blocked task must end up carrying WHY, not just the word.
    blocked_reason: z.string().optional(),
  }),
  z.object({ kind: z.literal("task_completed"), title_like: z.string() }),
  z.object({
    kind: z.literal("event_created"),
    title_like: z.string(),
    project: z.string().optional(),
    reminders_count: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("event_updated"), title_like: z.string() }),
  z.object({ kind: z.literal("event_deleted"), title_like: z.string() }),
  z.object({ kind: z.literal("project_created"), name_like: z.string() }),
  z.object({ kind: z.literal("task_filed"), title_like: z.string(), project: z.string() }),
  z.object({ kind: z.literal("document_created"), title_like: z.string() }),
  z.object({
    kind: z.literal("document_section_edited"),
    doc_like: z.string(),
    section_like: z.string().optional(),
  }),
  z.object({ kind: z.literal("memory_created"), fact_like: z.string() }),
  z.object({ kind: z.literal("no_duplicate"), table: z.enum(["tasks", "events"]), title_like: z.string() }),
  z.object({ kind: z.literal("recurrence_respawn"), title_like: z.string() }),
  z.object({ kind: z.literal("none") }),
]);
export type ExpectedOutcome = z.infer<typeof expectedOutcomeSchema>;

export const voiceStepSchema = z.union([
  z.object({ userLine: z.string() }),
  z.object({ toolCall: z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) }) }),
  z.object({ assistantLine: z.string() }),
]);
export type VoiceStep = z.infer<typeof voiceStepSchema>;

export const scenarioSchema = z.object({
  id: z.string().regex(/^s-[a-z0-9-]+$/),
  personaId: z.string(),
  surface: z.enum(["chat", "voice"]),
  seedData: z
    .array(
      z.object({
        table: z.enum(["projects", "tasks", "events"]),
        values: z.record(z.string(), z.unknown()),
      })
    )
    .default([]),
  goal: z.string(),
  scriptHints: z.array(z.string()).default([]),
  maxTurns: z.number().int().min(1).max(10).default(6),
  voiceSteps: z.array(voiceStepSchema).default([]),
  expected_outcomes: z.array(expectedOutcomeSchema).default([]),
  llm_checks: z.array(z.string()).default([]),
});
export type Scenario = z.infer<typeof scenarioSchema>;

export type Violation = {
  severity: "error" | "warn";
  checker: string;
  turn: number | null;
  summary: string;
  evidence?: Record<string, unknown>;
};

export type TranscriptTurn = {
  turn: number;
  user: string;
  assistant: string;
  toasts: { icon: string; text: string }[];
};
