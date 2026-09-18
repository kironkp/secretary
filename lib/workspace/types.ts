// The Workspace model — docs/workspace/SPEC.md §3.
//
// A board of independent widgets the SHELL positions. Geometry is grid units,
// never pixels: pixels do not survive both a phone and a 16-inch display. The
// model owns what is inside a widget; it never owns where the widget sits.
//
// Phase 1 carries static bodies. The `query` field is declared here so the
// storage shape does not change when bindings land in phase 2, but nothing
// reads it yet.
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
  /** Phase 2. Present in the type so the stored shape is stable. */
  query: z.unknown().optional(),
});

export type Widget = z.infer<typeof widgetSchema>;

export const boardSchema = z.object({
  widgets: z.array(widgetSchema).max(MAX_WIDGETS),
  /** Newest first. Geometry only — bodies are never in the undo stack. */
  undo: z.array(z.array(widgetSchema)).max(20).default([]),
  redo: z.array(z.array(widgetSchema)).max(20).default([]),
  /** The widget the user last touched, by drag, tap or voice. */
  focusId: z.string().nullable().default(null),
});

export type Board = z.infer<typeof boardSchema>;

export const EMPTY_BOARD: Board = { widgets: [], undo: [], redo: [], focusId: null };

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
