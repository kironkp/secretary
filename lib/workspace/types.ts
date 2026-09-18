// The Workspace model — docs/workspace/SPEC.md §3.
//
// A board of independent widgets the SHELL positions. Geometry is grid units,
// never pixels: pixels do not survive both a phone and a 16-inch display. The
// model owns what is inside a widget; it never owns where the widget sits.
//
// A widget may carry a BindingQuery. The query lives HERE, on the widget, and
// never inside the markup: that keeps the vocabulary closed, keeps the
// sanitizer's job small, and makes every read trivially user-scoped. The model
// chooses what to show and how to lay it out; it never writes a task title.
import { z } from "zod";

/** Columns across the board at desktop width. Narrow screens collapse to 1. */
export const GRID_COLS = 12;
/** One grid row in CSS pixels, before the gap. */
export const GRID_ROW_PX = 44;
/** Gutter between widgets, in CSS pixels. */
export const GRID_GAP_PX = 12;

export const MIN_W = 2;
export const MIN_H = 2;
/** A board that grows past this is a sign the model is listing, not arranging. */
export const MAX_WIDGETS = 48;

const id = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case id");

// --------------------------------------------------------------------------
// Bindings (docs/workspace/SPEC.md §3.2-§3.3)
// --------------------------------------------------------------------------

/**
 * The FIELD VOCABULARY. Closed per source, on purpose: `data-field` names one
 * of these, never a column. A widget can therefore never reach a column it was
 * not meant to, and renaming a column does not break stored markup.
 */
export const FIELDS = {
  tasks: ["title", "due", "status", "project", "stage", "stakes", "blocked", "notes", "created"],
  events: ["title", "when", "location", "project", "notes"],
  projects: ["name", "status", "deadline", "open"],
  documents: ["title", "project", "updated"],
  checkins: ["note", "task", "when"],
} as const;

export type BindingSource = keyof typeof FIELDS;
export const SOURCES = Object.keys(FIELDS) as [BindingSource, ...BindingSource[]];

export const TASK_STATUSES = [
  "inbox",
  "todo",
  "in_progress",
  "blocked",
  "done",
  "dropped",
] as const;

/** Relative windows, resolved against the user's own timezone at query time. */
export const DUE_WINDOWS = ["overdue", "today", "week", "month", "none", "any"] as const;

export const bindingQuerySchema = z.object({
  source: z.enum(SOURCES),
  where: z
    .object({
      /** Project id or the user's words for it; resolved server-side. */
      project: z.string().max(120).optional(),
      status: z.array(z.enum(TASK_STATUSES)).max(6).optional(),
      /** "open" is the common case and means every not-done, not-dropped status. */
      open: z.boolean().optional(),
      due: z.enum(DUE_WINDOWS).optional(),
      blocked: z.boolean().optional(),
      stakes: z.boolean().optional(),
      search: z.string().max(80).optional(),
    })
    .optional(),
  sort: z.enum(["due", "created", "updated", "priority", "procrastination", "title"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export type BindingQuery = z.infer<typeof bindingQuerySchema>;

/** One resolved row: a flat map of field name to display string, plus its id. */
export type BoundRow = { id: string; fields: Record<string, string> };


export const widgetSchema = z.object({
  id,
  title: z.string().min(1).max(80),
  x: z.number().int().min(0).max(GRID_COLS - 1),
  y: z.number().int().min(0).max(400),
  w: z.number().int().min(MIN_W).max(GRID_COLS),
  h: z.number().int().min(MIN_H).max(60),
  z: z.number().int().min(0).max(999),
  collapsed: z.boolean(),
  /** Sanitized markup. Never rendered without passing the sanitizer again. */
  body: z.string().max(20_000),
  query: bindingQuerySchema.optional(),
});

export type Widget = z.infer<typeof widgetSchema>;

export const boardSchema = z.object({
  widgets: z.array(widgetSchema).max(MAX_WIDGETS),
  /**
   * Which starter set has been applied. Lets a later phase ADD widgets to an
   * existing board without touching what the user has already arranged.
   */
  seedVersion: z.number().int().min(0).default(0),
  /** Newest first. Geometry only — bodies are never in the undo stack. */
  undo: z.array(z.array(widgetSchema)).max(20).default([]),
  redo: z.array(z.array(widgetSchema)).max(20).default([]),
  /** The widget the user last touched, by drag, tap or voice. */
  focusId: z.string().nullable().default(null),
});

export type Board = z.infer<typeof boardSchema>;

export const EMPTY_BOARD: Board = {
  widgets: [],
  seedVersion: 0,
  undo: [],
  redo: [],
  focusId: null,
};

/** Bump when the starter set gains widgets. */
export const CURRENT_SEED = 2;

/**
 * Operations the shell applies with no model call.
 *
 * Deliberately FLAT, not a discriminated union, and every integer bounded:
 * zod renders a union as `oneOf`, which the Realtime API rejects outright, and
 * one rejected schema fails the whole voice session. `arrange_canvas` is shaped
 * this way for the same reason and tests/agent-voice-split.test.ts enforces it.
 * Phase 4 reuses this schema verbatim as the voice tool's argument type.
 */
export const opSchema = z.object({
  op: z.enum([
    "move",
    "resize",
    "collapse",
    "expand",
    "remove",
    "focus",
    "raise",
    "tidy",
    "undo",
    "redo",
  ]),
  id: z.string().max(64).optional(),
  x: z.number().int().min(0).max(GRID_COLS - 1).optional(),
  y: z.number().int().min(0).max(400).optional(),
  w: z.number().int().min(MIN_W).max(GRID_COLS).optional(),
  h: z.number().int().min(MIN_H).max(60).optional(),
});

export type Op = z.infer<typeof opSchema>;
