// The canvas as a WORKSPACE (CLAUDE.md north star): a composition of blocks the
// shell arranges, not one picture the model repaints.
//
// The split this file encodes:
//   the SHELL owns geometry — order, span, visibility, theme, type scale
//   the MODEL owns content — the markup inside each block
//
// Everything in the first list is a data operation: "move the overdue one up",
// "make that bigger", "hide the finished ones", "bigger font" all resolve to an
// op below and change a jsonb column. No model call, no repaint, no waiting.
// Only changing what a block SAYS costs a generation, and then only that block.
//
// Deliberately NOT a component registry: `kind` does not exist here and no
// shell code branches on block identity. A canvas may be a priority stack, a
// timeline, one giant card, or something we have not thought of — the shell
// understands universal properties (where, how big, visible) and nothing about
// what a block means. That is what keeps canvases from all looking alike.
import { z } from "zod";
import { composeBlocks, segmentBlocks, verifyBlock } from "./blocks";
import { canvasFocusSchema, noteFocus, pruneFocus, type CanvasFocus } from "./focus";

/** Ids are already id-shaped by the sanitizer; mirror that exactly. */
const idSchema = z.string().regex(/^[-a-zA-Z0-9_]+$/).max(64);

/** Universal visual properties. Enums, never free text: the model may choose a
 *  theme, and an enum keeps that choice DATA rather than style it authors. */
export const canvasThemeSchema = z.object({
  /** Type scale multiplier — "make the text bigger" without a repaint. */
  scale: z.number().min(0.75).max(2).default(1),
  density: z.enum(["tight", "normal", "roomy"]).default("normal"),
  font: z.enum(["system", "serif", "mono", "condensed"]).default("system"),
  accent: z.enum(["default", "grape", "ok", "warn", "danger"]).default("default"),
  radius: z.enum(["sharp", "soft", "round"]).default("soft"),
});
export type CanvasTheme = z.infer<typeof canvasThemeSchema>;

export const canvasBlockSchema = z.object({
  id: idSchema,
  markup: z.string(),
  /** How wide, in a 2-column field. Phones always render full. */
  span: z.enum(["full", "half"]).default("full"),
  hidden: z.boolean().default(false),
  /** Touched by the user (moved/resized): the model may not re-place it. */
  pinned: z.boolean().default(false),
});
export type CanvasBlockSpec = z.infer<typeof canvasBlockSchema>;

const MAX_BLOCKS = 40;

/** Undo state for SHELL operations. Geometry only — no markup — so the stack
 *  stays tiny and undo is a pure, instant swap with no model call and no
 *  regeneration. Content changes are undone by restoring a snapshot instead
 *  (history already does that), which is why markup never enters here. */
const geometrySchema = z.object({
  theme: canvasThemeSchema,
  blocks: z.array(
    z.object({
      id: idSchema,
      span: z.enum(["full", "half"]),
      hidden: z.boolean(),
      pinned: z.boolean(),
      /** Position, so undo restores order without carrying markup. */
      at: z.number().int().min(0),
    })
  ),
});
export type CanvasGeometry = z.infer<typeof geometrySchema>;

const UNDO_DEPTH = 25;

export const canvasCompositionSchema = z.object({
  v: z.literal(1),
  theme: canvasThemeSchema,
  blocks: z.array(canvasBlockSchema).max(MAX_BLOCKS),
  /** Shared world model: what "that" and "those" currently mean. */
  focus: canvasFocusSchema.optional(),
  past: z.array(geometrySchema).max(UNDO_DEPTH).optional(),
  future: z.array(geometrySchema).max(UNDO_DEPTH).optional(),
});
export type CanvasComposition = z.infer<typeof canvasCompositionSchema>;

export const DEFAULT_THEME: CanvasTheme = canvasThemeSchema.parse({});

/**
 * Build a composition from sanitized markup. This is how every paint becomes a
 * workspace, and how the single-wrapper canvases already in the database
 * migrate — they simply become a one-block composition.
 */
export function compositionFromMarkup(
  markup: string,
  opts: { theme?: Partial<CanvasTheme>; previous?: CanvasComposition } = {}
): CanvasComposition {
  const blocks = segmentBlocks(markup)
    .filter((b) => verifyBlock(b.markup).ok)
    .slice(0, MAX_BLOCKS);

  // Geometry the user set by hand survives a repaint when the block is still
  // there — the assistant arranges the room, what his hand touched stays put.
  const prior = new Map(opts.previous?.blocks.map((b) => [b.id, b]));

  const next = canvasCompositionSchema.parse({
    v: 1,
    theme: { ...(opts.previous?.theme ?? {}), ...(opts.theme ?? {}) },
    blocks: blocks.map((b) => {
      const was = prior.get(b.id);
      return {
        id: b.id,
        markup: b.markup,
        span: was?.pinned ? was.span : (was?.span ?? "full"),
        hidden: was?.hidden ?? false,
        pinned: was?.pinned ?? false,
      };
    }),
    // Referents survive a repaint, minus anything that no longer exists — a
    // pronoun pointing at a vanished block is worse than no pronoun.
    focus: opts.previous?.focus
      ? pruneFocus(opts.previous.focus, blocks.map((b) => b.id))
      : undefined,
  });

  // A block that wasn't there before IS the thing "that" refers to next: after
  // "add my music projects", "move that to the right" must mean the new one.
  const added = blocks.filter((b) => !prior.has(b.id));
  if (added.length === 1) {
    next.focus = noteFocus(next.focus ?? {}, { kind: "create", id: added[0].id });
  } else if (added.length > 1) {
    next.focus = noteFocus(next.focus ?? {}, { kind: "group", ids: added.map((b) => b.id) });
  }
  return next;
}

/** The composed fragment: visible blocks, in order. Kept in sync with the
 *  snapshot's `markup` column so every existing reader (done-marks, history,
 *  restore) keeps working unchanged. */
export function compositionToMarkup(composition: CanvasComposition): string {
  return composeBlocks(composition.blocks.filter((b) => !b.hidden));
}

/**
 * Validate an untrusted composition, never throwing. Same contract as the
 * layout validator: a bad part is dropped with a warning and the rest survives,
 * because refusing the whole thing would take the user's canvas away.
 */
export function validateComposition(
  input: unknown
): { composition: CanvasComposition | null; warnings: string[] } {
  const warnings: string[] = [];
  const parsed = canvasCompositionSchema.safeParse(input);
  if (!parsed.success) {
    return { composition: null, warnings: [`composition rejected: ${parsed.error.message}`] };
  }

  const seen = new Set<string>();
  const blocks = parsed.data.blocks.filter((b) => {
    if (seen.has(b.id)) {
      warnings.push(`duplicate block id dropped: ${b.id}`);
      return false;
    }
    const v = verifyBlock(b.markup);
    if (!v.ok) {
      warnings.push(`block ${b.id} dropped: ${v.reason}`);
      return false;
    }
    seen.add(b.id);
    return true;
  });

  if (!blocks.length) return { composition: null, warnings: [...warnings, "no usable blocks"] };
  return { composition: { ...parsed.data, blocks }, warnings };
}

// ── Operations ────────────────────────────────────────────────────────────────
// A CLOSED vocabulary, like edit_layout_plan: an unknown op is rejected outright
// rather than interpreted. These are the whole point — each one is instant.

/** Geometry alone, for the undo stack. */
export function snapshotGeometry(c: CanvasComposition): CanvasGeometry {
  return {
    theme: c.theme,
    blocks: c.blocks.map((b, at) => ({
      id: b.id,
      span: b.span,
      hidden: b.hidden,
      pinned: b.pinned,
      at,
    })),
  };
}

/** Put a geometry back on the current blocks. Blocks that appeared since are
 *  kept (appended) rather than destroyed — undoing a move must not delete
 *  something that arrived afterwards. */
function restoreGeometry(c: CanvasComposition, g: CanvasGeometry): CanvasComposition {
  const byId = new Map(c.blocks.map((b) => [b.id, b]));
  const ordered = g.blocks
    .slice()
    .sort((a, b) => a.at - b.at)
    .flatMap((spec) => {
      const block = byId.get(spec.id);
      if (!block) return [];
      byId.delete(spec.id);
      return [{ ...block, span: spec.span, hidden: spec.hidden, pinned: spec.pinned }];
    });
  return { ...c, theme: g.theme, blocks: [...ordered, ...byId.values()] };
}

export type UndoResult = { composition: CanvasComposition; changed: boolean; label: string };

/** Instant, deterministic, no model call. */
export function undoCanvas(c: CanvasComposition): UndoResult {
  const past = c.past ?? [];
  if (!past.length) return { composition: c, changed: false, label: "nothing to undo" };
  const previous = past[past.length - 1];
  const restored = restoreGeometry(c, previous);
  return {
    composition: {
      ...restored,
      past: past.slice(0, -1),
      future: [...(c.future ?? []), snapshotGeometry(c)].slice(-UNDO_DEPTH),
    },
    changed: true,
    label: "undone",
  };
}

export function redoCanvas(c: CanvasComposition): UndoResult {
  const future = c.future ?? [];
  if (!future.length) return { composition: c, changed: false, label: "nothing to redo" };
  const next = future[future.length - 1];
  const restored = restoreGeometry(c, next);
  return {
    composition: {
      ...restored,
      past: [...(c.past ?? []), snapshotGeometry(c)].slice(-UNDO_DEPTH),
      future: future.slice(0, -1),
    },
    changed: true,
    label: "redone",
  };
}

export const canvasOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("move"), id: idSchema, to: z.number().int().min(0).max(MAX_BLOCKS) }),
  z.object({ op: z.literal("resize"), id: idSchema, span: z.enum(["full", "half"]) }),
  z.object({ op: z.literal("hide"), id: idSchema }),
  z.object({ op: z.literal("show"), id: idSchema }),
  z.object({ op: z.literal("remove"), id: idSchema }),
  z.object({ op: z.literal("set_theme"), theme: canvasThemeSchema.partial() }),
]);
export type CanvasOp = z.infer<typeof canvasOpSchema>;

/** Merge a partial theme, CLAMPING rather than rejecting. "Way bigger" should
 *  give the user the biggest legible canvas, not an error — and a theme op must
 *  never be able to throw inside a request. */
function mergeTheme(current: CanvasTheme, patch: Partial<CanvasTheme>): CanvasTheme {
  const merged: Record<string, unknown> = { ...current, ...patch };
  if (typeof merged.scale === "number" && Number.isFinite(merged.scale)) {
    merged.scale = Math.max(0.75, Math.min(2, merged.scale));
  } else {
    merged.scale = current.scale;
  }
  const parsed = canvasThemeSchema.safeParse(merged);
  return parsed.success ? parsed.data : current;
}

export type OpResult = {
  composition: CanvasComposition;
  applied: string[];
  rejected: { op: string; reason: string }[];
};

/** Apply ops in order. Pure. Unknown ids are reported, never guessed at — a
 *  silently-wrong move is worse than a "which one?" back to the user. */
export function applyCanvasOps(base: CanvasComposition, ops: CanvasOp[]): OpResult {
  let blocks = base.blocks.slice();
  let theme = base.theme;
  let focus: CanvasFocus = base.focus ?? {};
  const applied: string[] = [];
  const rejected: { op: string; reason: string }[] = [];
  const touched: string[] = [];

  const indexOf = (id: string) => blocks.findIndex((b) => b.id === id);

  for (const op of ops) {
    if (op.op === "set_theme") {
      theme = mergeTheme(theme, op.theme);
      applied.push("set_theme");
      continue;
    }

    const i = indexOf(op.id);
    if (i === -1) {
      rejected.push({ op: op.op, reason: `no block "${op.id}" on the canvas` });
      continue;
    }

    switch (op.op) {
      case "move": {
        const to = Math.max(0, Math.min(op.to, blocks.length - 1));
        const next = blocks.slice();
        const [moved] = next.splice(i, 1);
        // Touching a block pins it: the user's hand beats the planner.
        next.splice(to, 0, { ...moved, pinned: true });
        blocks = next;
        focus = noteFocus(focus, { kind: "move", id: op.id });
        applied.push(`move ${op.id}→${to}`);
        break;
      }
      case "resize":
        blocks = blocks.map((b, n) => (n === i ? { ...b, span: op.span, pinned: true } : b));
        focus = noteFocus(focus, { kind: "resize", id: op.id });
        applied.push(`resize ${op.id}=${op.span}`);
        break;
      case "hide":
        blocks = blocks.map((b, n) => (n === i ? { ...b, hidden: true } : b));
        applied.push(`hide ${op.id}`);
        break;
      case "show":
        blocks = blocks.map((b, n) => (n === i ? { ...b, hidden: false } : b));
        applied.push(`show ${op.id}`);
        break;
      case "remove":
        blocks = blocks.filter((_, n) => n !== i);
        applied.push(`remove ${op.id}`);
        break;
    }
    touched.push(op.id);
  }

  // Never leave the user with an empty canvas: a remove/hide that would clear
  // the board is undone rather than obeyed.
  if (!blocks.some((b) => !b.hidden)) {
    return {
      composition: base,
      applied: [],
      rejected: [...rejected, { op: "*", reason: "that would empty the canvas" }],
    };
  }

  // A batch acting on several blocks is what "those" means next time.
  const distinct = [...new Set(touched)];
  if (distinct.length > 1) focus = noteFocus(focus, { kind: "group", ids: distinct });

  return {
    composition: {
      v: 1,
      theme,
      blocks,
      focus,
      // One undo entry per BATCH, not per op: "move it up" is one thing the
      // user did, even when the model emits it as several operations.
      past: [...(base.past ?? []), snapshotGeometry(base)].slice(-UNDO_DEPTH),
      // A new action forks the timeline; anything redone-past is gone.
      future: [],
    },
    applied,
    rejected,
  };
}

/** What the model is told is on screen, so it can refer to it by name.
 *  Markup is deliberately excluded — this is a map of the world, not its
 *  contents, and it stays small enough to ship on every voice turn. */
export function describeComposition(composition: CanvasComposition): {
  id: string;
  position: number;
  span: string;
  hidden: boolean;
  summary: string;
}[] {
  return composition.blocks.map((b, i) => ({
    id: b.id,
    position: i,
    span: b.span,
    hidden: b.hidden,
    summary: summarize(b.markup),
  }));
}

/** First readable text in a block — enough for "the one about Caltrans". */
function summarize(markup: string): string {
  const text = markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 80 ? text.slice(0, 79) + "…" : text;
}
