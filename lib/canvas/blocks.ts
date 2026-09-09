// Canvas blocks: turning one sanitized fragment into independently addressable
// pieces, and back again.
//
// This is the substrate for the workspace model (CLAUDE.md north star). The
// canvas stops being one anonymous blob and becomes a stack of blocks with
// stable ids, so the shell can own geometry — order, size, visibility — and
// change it with no model call at all, while the model keeps owning what is
// INSIDE each block. That split is what makes "move the overdue one up" free
// and "add one more thing" cost one small block instead of the whole screen.
//
// Pure and dependency-free on purpose: it runs on the server when a paint
// lands and on the client when the shell rearranges, and it sits on the
// security path, so it is unit-testable in isolation.
//
// It parses only markup the sanitizer has ALREADY normalized (attributes are
// name="value", ids are id-shaped, tags are lowercase and allowlisted), which
// is what makes a small scanner adequate here where a general HTML parser
// would not be.

/** Void elements the sanitizer emits without a closing tag. */
const VOID_TAGS = new Set(["br", "hr", "stop"]);

export type CanvasBlock = {
  /** Stable, model-authored, kebab-case. Unique within a canvas. */
  id: string;
  /** The block's own sanitized markup, exactly one balanced root element. */
  markup: string;
};

type Token = { tag: string; close: boolean; selfClose: boolean; start: number; end: number };

function* tokens(markup: string): Generator<Token> {
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup))) {
    const tag = m[2].toLowerCase();
    yield {
      tag,
      close: m[1] === "/",
      selfClose: VOID_TAGS.has(tag) || /\/\s*$/.test(m[3]),
      start: m.index,
      end: m.index + m[0].length,
    };
  }
}

/** The `id="…"` of a start tag, if it has one. Values are already id-shaped. */
function idOf(startTag: string): string | null {
  const m = /\sid="([-a-zA-Z0-9_]+)"/.exec(startTag);
  return m ? m[1] : null;
}

/**
 * Split sanitized markup into its top-level elements.
 *
 * Depth is tracked across the whole fragment so a nested `<div>` never looks
 * like a new block. Text between top-level elements is dropped: the painter
 * emits elements, and stray text has nowhere to live in a block model.
 */
export function segmentBlocks(markup: string): CanvasBlock[] {
  const out: CanvasBlock[] = [];
  const seen = new Set<string>();
  let depth = 0;
  let openStart = -1;
  let openTag = "";
  let anonymous = 0;

  for (const t of tokens(markup)) {
    if (t.close) {
      if (depth > 0) depth--;
      if (depth === 0 && openStart >= 0) {
        const slice = markup.slice(openStart, t.end);
        out.push({ id: uniqueId(idOf(openTag), seen, ++anonymous), markup: slice });
        openStart = -1;
      }
      continue;
    }
    if (t.selfClose) {
      if (depth === 0) {
        const slice = markup.slice(t.start, t.end);
        out.push({
          id: uniqueId(idOf(slice), seen, ++anonymous),
          markup: slice,
        });
      }
      continue;
    }
    if (depth === 0) {
      openStart = t.start;
      openTag = markup.slice(t.start, t.end);
    }
    depth++;
  }

  // An unterminated final element (truncated stream) is not a block.
  return out;
}

function uniqueId(candidate: string | null, seen: Set<string>, n: number): string {
  // Duplicate ids survive sanitization, and a duplicate would make a targeted
  // edit ambiguous — first one keeps the name, the rest are suffixed.
  let id = candidate ?? `block-${n}`;
  if (seen.has(id)) {
    let i = 2;
    while (seen.has(`${id}-${i}`)) i++;
    id = `${id}-${i}`;
  }
  seen.add(id);
  return id;
}

/**
 * Is this fragment safe to treat as one block?
 *
 * Exactly one balanced root element. An unbalanced fragment does not merely
 * break itself — spliced into a document it re-parents its siblings, which is
 * how one bad block would corrupt a whole canvas. Rejecting is always correct
 * here: the caller falls back to a full repaint.
 */
export function verifyBlock(markup: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = markup.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  let depth = 0;
  let roots = 0;
  let closedEarly = false;

  for (const t of tokens(trimmed)) {
    if (t.close) {
      if (depth === 0) {
        closedEarly = true;
        break;
      }
      depth--;
      if (depth === 0) roots++;
      continue;
    }
    if (t.selfClose) {
      if (depth === 0) roots++;
      continue;
    }
    depth++;
  }

  if (closedEarly) return { ok: false, reason: "closing tag with no matching open" };
  if (depth !== 0) return { ok: false, reason: "unclosed element" };
  if (roots === 0) return { ok: false, reason: "no element" };
  if (roots > 1) return { ok: false, reason: `${roots} root elements, expected 1` };
  return { ok: true };
}

/** Blocks back into one fragment, in the order given. The inverse of segment. */
export function composeBlocks(blocks: CanvasBlock[]): string {
  return blocks.map((b) => b.markup).join("\n");
}

/** Replace one block's markup by id, leaving every other block untouched.
 *  Returns null when the id is unknown or the replacement is malformed — the
 *  caller repaints rather than writing something it can't vouch for. */
export function replaceBlock(
  blocks: CanvasBlock[],
  id: string,
  markup: string
): CanvasBlock[] | null {
  const i = blocks.findIndex((b) => b.id === id);
  if (i === -1) return null;
  if (!verifyBlock(markup).ok) return null;
  const next = blocks.slice();
  next[i] = { id, markup };
  return next;
}

/** Move a block to a new index. Pure geometry — no model call, ever. */
export function moveBlock(blocks: CanvasBlock[], id: string, to: number): CanvasBlock[] | null {
  const from = blocks.findIndex((b) => b.id === id);
  if (from === -1) return null;
  const clamped = Math.max(0, Math.min(to, blocks.length - 1));
  const next = blocks.slice();
  const [moved] = next.splice(from, 1);
  next.splice(clamped, 0, moved);
  return next;
}
