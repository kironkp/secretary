// The shared world model: what "that", "this", "those" and "the other one"
// currently mean.
//
// ONE state, updated by BOTH voice and touch (CLAUDE.md north star: never a
// separate "voice state" and "touch state"). Tap a card and say "make this
// bigger" and the tap is what "this" means. Let the secretary create something
// and say "move that to the right" and the creation is what "that" means.
//
// Resolution is DETERMINISTIC wherever the answer is obvious — a pronoun, a
// position, a name that matches. The model is only needed when the phrase is
// genuinely semantic, and for a destructive action an ambiguous reference asks
// instead of guessing.
import { z } from "zod";

const blockId = z.string().regex(/^[-a-zA-Z0-9_]+$/).max(64);

/** Interaction state. Every field is "the last time something happened to a
 *  block", because that is what pronouns actually track in speech. */
export const canvasFocusSchema = z.object({
  /** Explicitly selected — a tap. The strongest referent for "this". */
  selected: blockId.optional(),
  /** Last block the user manipulated by any means (tap, drag, resize, voice). */
  lastTouched: blockId.optional(),
  lastMoved: blockId.optional(),
  lastCreated: blockId.optional(),
  /** Content changed (an edit), as opposed to geometry. */
  lastModified: blockId.optional(),
  /** The last block SECRETARY referred to out loud. */
  lastMentioned: blockId.optional(),
  /** "those" / "these" / "them" — the last set acted on or discussed. */
  lastGroup: z.array(blockId).max(40).optional(),
  /** Referent history, newest first — powers "no, the other one". */
  recent: z.array(blockId).max(8).optional(),
});
export type CanvasFocus = z.infer<typeof canvasFocusSchema>;

export const EMPTY_FOCUS: CanvasFocus = {};

/** Record that something happened to a block, from voice OR touch. */
export function noteFocus(
  focus: CanvasFocus,
  event:
    | { kind: "select"; id: string }
    | { kind: "move"; id: string }
    | { kind: "resize"; id: string }
    | { kind: "create"; id: string }
    | { kind: "modify"; id: string }
    | { kind: "mention"; id: string }
    | { kind: "group"; ids: string[] }
): CanvasFocus {
  if (event.kind === "group") {
    return { ...focus, lastGroup: event.ids.slice(0, 40) };
  }
  const id = event.id;
  const recent = [id, ...(focus.recent ?? []).filter((r) => r !== id)].slice(0, 8);
  const next: CanvasFocus = { ...focus, recent };

  switch (event.kind) {
    case "select":
      next.selected = id;
      next.lastTouched = id;
      break;
    case "move":
      next.lastMoved = id;
      next.lastTouched = id;
      break;
    case "resize":
      next.lastTouched = id;
      break;
    case "create":
      next.lastCreated = id;
      next.lastTouched = id;
      break;
    case "modify":
      next.lastModified = id;
      next.lastTouched = id;
      break;
    case "mention":
      next.lastMentioned = id;
      break;
  }
  return next;
}

/** Blocks disappear (a repaint drops one); stale referents must not survive. */
export function pruneFocus(focus: CanvasFocus, liveIds: string[]): CanvasFocus {
  const live = new Set(liveIds);
  const keep = (id?: string) => (id && live.has(id) ? id : undefined);
  return {
    selected: keep(focus.selected),
    lastTouched: keep(focus.lastTouched),
    lastMoved: keep(focus.lastMoved),
    lastCreated: keep(focus.lastCreated),
    lastModified: keep(focus.lastModified),
    lastMentioned: keep(focus.lastMentioned),
    lastGroup: focus.lastGroup?.filter((id) => live.has(id)),
    recent: focus.recent?.filter((id) => live.has(id)),
  };
}

export type Resolvable = { id: string; summary: string; position: number; hidden: boolean };

export type Resolution =
  | { ok: true; ids: string[]; via: string }
  | { ok: false; reason: string; candidates: string[] };

const SINGULAR = /^(it|that|this|the one|that one|this one|selected|current)$/;
const PLURAL = /^(those|these|them|they|both|all of (them|those|these))$/;
const OTHER = /^(the )?other( one)?$/;
const TOP = /^(the )?(top|first)( one)?$/;
const BOTTOM = /^(the )?(bottom|last)( one)?$/;

/**
 * Turn what the user said into block ids.
 *
 * Order matters: an explicit id beats a pronoun, a pronoun beats a guess, and a
 * name match beats nothing. Returns candidates rather than picking when the
 * phrase is genuinely ambiguous, so the caller can ask.
 */
export function resolveReference(
  ref: string,
  blocks: Resolvable[],
  focus: CanvasFocus
): Resolution {
  const raw = (ref ?? "").trim();
  if (!raw) return { ok: false, reason: "no reference given", candidates: [] };

  const exact = blocks.find((b) => b.id === raw);
  if (exact) return { ok: true, ids: [exact.id], via: "id" };

  // People do not speak in clean referents. "No, the other one", "actually
  // make this bigger", "ok hide those" all have to land.
  const phrase = raw
    .toLowerCase()
    .replace(/[.,!?]+/g, " ")
    .replace(/^\s*(no|nope|actually|wait|ok|okay|um|uh|and|then|please|just)\b\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const live = new Set(blocks.map((b) => b.id));
  const alive = (id?: string) => (id && live.has(id) ? id : undefined);

  const singular = () => {
    const id =
      alive(focus.selected) ??
      alive(focus.lastTouched) ??
      alive(focus.lastMentioned) ??
      alive(focus.lastCreated) ??
      alive(focus.lastModified);
    if (id) return { ok: true as const, ids: [id], via: "pronoun" };
    if (blocks.length === 1) return { ok: true as const, ids: [blocks[0].id], via: "only block" };
    return null;
  };

  // "the other one" can sit anywhere in the sentence.
  if (/\bother\b/.test(phrase)) {
    const recent = (focus.recent ?? []).filter((id) => live.has(id));
    if (recent.length >= 2) return { ok: true, ids: [recent[1]], via: "the other one" };
    if (blocks.length === 2) {
      const current = alive(focus.selected) ?? alive(focus.lastTouched);
      const other = blocks.find((b) => b.id !== current);
      if (other) return { ok: true, ids: [other.id], via: "the other one" };
    }
    return { ok: false, reason: "not sure which other one", candidates: blocks.map((b) => b.id) };
  }

  if (SINGULAR.test(phrase)) {
    const id =
      alive(focus.selected) ??
      alive(focus.lastTouched) ??
      alive(focus.lastMentioned) ??
      alive(focus.lastCreated) ??
      alive(focus.lastModified);
    if (id) return { ok: true, ids: [id], via: "pronoun" };
    // One block on screen makes "that" unambiguous regardless of history.
    if (blocks.length === 1) return { ok: true, ids: [blocks[0].id], via: "only block" };
    return {
      ok: false,
      reason: "nothing has been touched or mentioned yet, so \"that\" is ambiguous",
      candidates: blocks.map((b) => b.id),
    };
  }

  if (PLURAL.test(phrase)) {
    const group = focus.lastGroup?.filter((id) => live.has(id));
    if (group?.length) return { ok: true, ids: group, via: "group" };
    if (blocks.length) return { ok: true, ids: blocks.map((b) => b.id), via: "everything visible" };
    return { ok: false, reason: "nothing on the canvas", candidates: [] };
  }

  if (OTHER.test(phrase)) {
    // "no, the other one" — the previous referent, not the current one.
    const recent = (focus.recent ?? []).filter((id) => live.has(id));
    if (recent.length >= 2) return { ok: true, ids: [recent[1]], via: "the other one" };
    if (blocks.length === 2) {
      const current = alive(focus.selected) ?? alive(focus.lastTouched);
      const other = blocks.find((b) => b.id !== current);
      if (other) return { ok: true, ids: [other.id], via: "the other one" };
    }
    return { ok: false, reason: "not sure which other one", candidates: blocks.map((b) => b.id) };
  }

  const visible = blocks.filter((b) => !b.hidden);
  if (TOP.test(phrase) && visible.length) return { ok: true, ids: [visible[0].id], via: "position" };
  if (BOTTOM.test(phrase) && visible.length)
    return { ok: true, ids: [visible[visible.length - 1].id], via: "position" };

  // A name: "the caltrans one", "overdue", "my music projects". Strip the
  // filler people actually say around a name.
  const needle = phrase
    .replace(/^(the|my|that|this|those|these)\s+/g, "")
    .replace(/\s+(one|ones|block|card|section|thing|stuff|items?)$/g, "")
    .trim();
  if (needle) {
    const hay = (b: Resolvable) => `${b.id} ${b.summary}`.toLowerCase();
    const matches = blocks.filter((b) => hay(b).includes(needle));
    if (matches.length === 1) return { ok: true, ids: [matches[0].id], via: "name" };
    if (matches.length > 1) {
      // Prefer an id that matches outright over a summary mention.
      const byId = matches.filter((b) => b.id.toLowerCase().includes(needle));
      if (byId.length === 1) return { ok: true, ids: [byId[0].id], via: "name" };
      return {
        ok: false,
        reason: `"${ref}" matches ${matches.length} things on the canvas`,
        candidates: matches.map((b) => b.id),
      };
    }
    // Every word matching somewhere is still a usable group ("the caltrans ones").
    const words = needle.split(/\s+/).filter((w) => w.length > 2);
    if (words.length) {
      const loose = blocks.filter((b) => words.every((w) => hay(b).includes(w)));
      if (loose.length === 1) return { ok: true, ids: [loose[0].id], via: "name" };
      if (loose.length > 1) return { ok: true, ids: loose.map((b) => b.id), via: "name group" };
    }
  }

  // Last resort: a pronoun buried in a sentence ("make this bigger", "shove
  // that up"). Checked AFTER name matching so "the caltrans one" still wins.
  if (/\b(those|these|them|they)\b/.test(phrase)) {
    const group = focus.lastGroup?.filter((id) => live.has(id));
    if (group?.length) return { ok: true, ids: group, via: "group" };
    if (blocks.length) return { ok: true, ids: blocks.map((b) => b.id), via: "everything visible" };
  }
  if (/\b(this|that|it)\b/.test(phrase)) {
    const hit = singular();
    if (hit) return hit;
    return {
      ok: false,
      reason: 'nothing has been touched or mentioned yet, so "that" is ambiguous',
      candidates: blocks.map((b) => b.id),
    };
  }

  return {
    ok: false,
    reason: `nothing on the canvas matches "${ref}"`,
    candidates: blocks.map((b) => b.id),
  };
}
