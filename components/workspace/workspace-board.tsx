"use client";

// The board (docs/workspace/SPEC.md §4). The shell owns geometry; the widget
// owns only what is inside it.
//
// Two invariants, both learned from the Canvas, and both asserted in
// tests/workspace-ops.test.ts and e2e/workspace.spec.ts rather than left as
// comments:
//
//   1. DOM ORDER NEVER CHANGES. Widgets render sorted by id, forever, and every
//      visual position comes from style alone. Reordering React children is
//      what made a canvas reorder reload the whole board.
//   2. NOTHING IS CLIPPED. A widget's grid height is its MINIMUM height; content
//      that wants more scrolls inside its own body, and the board grows to fit
//      the tallest widget. No measuring loop, no feedback, no staircase. The
//      same rule holds for TEXT (docs/understanding/SPEC.md §9): a title, a
//      lede or a row wraps and is read in full; nothing here truncates, elides
//      or clamps. The header and the lede take the height they need and the
//      body gives it up (it scrolls); only when the body would be left with
//      less than one row does the widget grow past its grid height, and then
//      it grows by the lines rather than cutting them off.
//
// Widgets render INLINE, not in an iframe. That is the decision the whole
// surface rests on: the host can see pointer events, so drag and resize are
// possible at all, and heights are real DOM heights.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Type only: lib/understanding/words.ts reads Postgres and must never be
// bundled for the client. `import type` is erased at compile time.
import type { Lede } from "@/lib/understanding/words";
import { applyBindings } from "@/lib/workspace/apply-bindings";
import { boardRows } from "@/lib/workspace/ops";
import {
  GRID_COLS,
  GRID_GAP_PX,
  GRID_ROW_PX,
  MIN_H,
  MIN_W,
  type BoundRow,
  type Widget,
} from "@/lib/workspace/types";

/** How often the board checks for changes made elsewhere — voice on a phone,
 *  another tab, the extractor. Matches the Canvas's own poll. */
const POLL_MS = 15_000;

// The app's motion language (CLAUDE.md): 340ms, leading edge first. Geometry
// animates; a drag in progress does not, because the finger is the animation.
const DURATION = "340ms";
const EASE = "cubic-bezier(0.22, 0.9, 0.32, 1)";

type BoardState = {
  version: number;
  widgets: Widget[];
  /** Resolved rows per widget id. Live data; the template never changes. */
  rows: Record<string, BoundRow[]>;
  /**
   * One lede per widget id, from the understanding loop's records
   * (docs/understanding/SPEC.md §7, §9). Absent for a widget no run has
   * written about yet; stale when its project moved after it was written.
   */
  ledes: Record<string, Lede>;
  focusId: string | null;
  canUndo: boolean;
  canRedo: boolean;
};

type Gesture =
  | { kind: "idle" }
  | {
      kind: "drag" | "resize";
      id: string;
      startX: number;
      startY: number;
      origin: { x: number; y: number; w: number; h: number };
      dx: number;
      dy: number;
    };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// What a widget's frame takes before the body: the section's own borders
// (1px top and bottom), the 44px header row, and the header's bottom border.
// The body is capped at the grid height minus this, so the body scrolls and
// the widget stays its grid height. On the desktop grid the body also carries
// `contain: size`, so its rows add nothing to the widget's own height: the
// header and the lede take what they need and the body is the flex item that
// gives it up, which is how the cap subtracts a lede without measuring one.
// The maxHeight stays as the fallback for an engine without size containment,
// where the widget grows by the lede instead, and nothing is cut off either way.
const FRAME_PX = 2 + 44 + 1;
// The least a body keeps on the desktop grid: one row of text and its
// padding. A lede taller than the whole body area (a tiny widget, a long
// lede) pushes the widget past its grid height rather than leaving no rows
// visible; below this the grid height is 100px at MIN_H, so a widget without
// a lede never grows.
const BODY_MIN_PX = 44;

export function WorkspaceBoard({ initial }: { initial: BoardState }) {
  const [state, setState] = useState<BoardState>(initial);
  // The gesture lives in a REF, and state only mirrors it for rendering.
  // Reading it from state made the first pointermove events see `idle`,
  // because React had not committed the pointerdown update yet — under CI load
  // every move in a short drag could be dropped and the widget never moved.
  // A ref is current the instant the handler returns.
  const gestureRef = useRef<Gesture>({ kind: "idle" });
  const [gesture, setGesture] = useState<Gesture>({ kind: "idle" });
  const [narrow, setNarrow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  // State, not a ref: positions are computed from this during render, so a
  // width change has to re-render. As a ref it would go stale on rotate or
  // window resize and every widget would sit at yesterday's coordinates.
  const [colPx, setColPx] = useState(80);

  // Narrow screens stack: free positioning on a 390px phone is a worse answer
  // than a single column, and drag there fights the page scroll.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Freshness (docs/workspace/SPEC.md §5): three triggers, no new transport.
  // A refresh replaces ROWS, never the template, so scroll and selection inside
  // a widget survive — that is the point of applying bindings in the DOM.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setState((s) => ({
        version: data.version,
        // A gesture in flight owns geometry; a refresh must not yank it back.
        widgets: gestureRef.current.kind !== "idle" ? s.widgets : data.widgets,
        rows: data.rows ?? {},
        ledes: data.ledes ?? {},
        focusId: data.focusId ?? null,
        canUndo: !!data.canUndo,
        canRedo: !!data.canRedo,
      }));
    } catch {
      // A failed poll is not worth a message: the next one is 15s away.
    }
  }, []);

  useEffect(() => {
    const id = setInterval(refresh, POLL_MS);
    const onFocus = () => void refresh();
    // Any write elsewhere in the app can say so and the board updates at once.
    const onChanged = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("secretary:data-changed", onChanged);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("secretary:data-changed", onChanged);
    };
  }, [refresh]);

  const measure = useCallback(() => {
    const el = boardRef.current;
    if (!el) return;
    setColPx((el.clientWidth + GRID_GAP_PX) / GRID_COLS);
  }, []);

  useEffect(() => {
    measure();
    const el = boardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // Stable render order, independent of stacking and position. See invariant 1.
  const ordered = useMemo(
    () => [...state.widgets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [state.widgets]
  );

  const send = useCallback(
    async (operations: unknown[], optimistic?: Widget[]) => {
      const before = state;
      if (optimistic) setState((s) => ({ ...s, widgets: optimistic }));
      try {
        const res = await fetch("/api/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operations, version: before.version }),
        });
        const data = await res.json();
        if (!res.ok && res.status !== 409) throw new Error(data?.error ?? `HTTP ${res.status}`);
        // 409 carries the winning state: adopt it rather than keep a guess.
        setState({
          version: data.version,
          widgets: data.widgets,
          rows: data.rows ?? {},
          ledes: data.ledes ?? {},
          focusId: data.focusId ?? null,
          canUndo: !!data.canUndo,
          canRedo: !!data.canRedo,
        });
        setError(res.status === 409 ? "Reloaded: the board changed elsewhere." : null);
      } catch (e) {
        setState(before); // exact rollback, the Canvas's discipline
        setError(e instanceof Error ? e.message : "Could not save that move.");
      }
    },
    [state]
  );

  const pxRect = (w: Widget) => {
    const unit = colPx;
    return {
      left: w.x * unit,
      top: w.y * (GRID_ROW_PX + GRID_GAP_PX),
      width: Math.max(0, w.w * unit - GRID_GAP_PX),
      height: w.collapsed ? GRID_ROW_PX : w.h * (GRID_ROW_PX + GRID_GAP_PX) - GRID_GAP_PX,
    };
  };

  const onPointerDown = (e: React.PointerEvent, w: Widget, kind: "drag" | "resize") => {
    if (narrow) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const started: Gesture = {
      kind,
      id: w.id,
      startX: e.clientX,
      startY: e.clientY,
      origin: { x: w.x, y: w.y, w: w.w, h: w.h },
      dx: 0,
      dy: 0,
    };
    gestureRef.current = started;
    setGesture(started);
    // Deliberately no request here. A POST on pointer-down re-resolved every
    // binding on the board before the finger had even moved; focus and raise
    // ride along with the move that follows, or with the click if it was a tap.
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (g.kind === "idle") return;
    const next = { ...g, dx: e.clientX - g.startX, dy: e.clientY - g.startY };
    gestureRef.current = next;
    setGesture(next);
  };

  const endGesture = () => {
    const g = gestureRef.current;
    if (g.kind === "idle") return;
    const unit = colPx;
    const rowUnit = GRID_ROW_PX + GRID_GAP_PX;
    const dCols = Math.round(g.dx / unit);
    const dRows = Math.round(g.dy / rowUnit);
    gestureRef.current = { kind: "idle" };
    setGesture({ kind: "idle" });
    if (dCols === 0 && dRows === 0) return;

    if (g.kind === "drag") {
      const x = clamp(g.origin.x + dCols, 0, GRID_COLS - g.origin.w);
      const y = Math.max(0, g.origin.y + dRows);
      // One batch, so one request and one undo step for one gesture.
      void send(
        [
          { op: "move", id: g.id, x, y, w: g.origin.w },
          { op: "raise", id: g.id },
          { op: "focus", id: g.id },
        ],
        state.widgets.map((w) => (w.id === g.id ? { ...w, x, y } : w))
      );
    } else {
      const w = clamp(g.origin.w + dCols, MIN_W, GRID_COLS - g.origin.x);
      const h = Math.max(MIN_H, g.origin.h + dRows);
      void send(
        [{ op: "resize", id: g.id, w, h }],
        state.widgets.map((x) => (x.id === g.id ? { ...x, w, h } : x))
      );
    }
  };

  const rows = boardRows(state.widgets);
  const boardHeight = narrow ? undefined : Math.max(rows, 6) * (GRID_ROW_PX + GRID_GAP_PX);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Toolbutton onClick={() => void send([{ op: "tidy" }])} label="Tidy" />
        <Toolbutton
          onClick={() => void send([{ op: "undo" }])}
          label="Undo"
          disabled={!state.canUndo}
        />
        <Toolbutton
          onClick={() => void send([{ op: "redo" }])}
          label="Redo"
          disabled={!state.canRedo}
        />
        {narrow && <span className="text-xs text-muted">Stacked on narrow screens</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>

      <div
        ref={boardRef}
        data-testid="workspace-board"
        className={narrow ? "flex flex-col gap-3" : "relative w-full"}
        style={narrow ? undefined : { height: boardHeight }}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        {ordered.map((w) => {
          const active = gesture.kind !== "idle" && gesture.id === w.id;
          const rect = pxRect(w);
          const lede: Lede | undefined = state.ledes[w.id];
          const style: React.CSSProperties = narrow
            ? { order: w.y * GRID_COLS + w.x }
            : {
                position: "absolute",
                left: rect.left,
                top: rect.top,
                width: rect.width,
                // A minimum, not a height (docs/workspace/SPEC.md §3.1): the
                // body is capped and size-contained below, so a wrapped header
                // or a lede takes its lines from the body and the widget sits
                // exactly on its grid height; only a lede that would leave the
                // body under BODY_MIN_PX pushes it past (see FRAME_PX).
                minHeight: rect.height,
                zIndex: active ? 999 : w.z,
                transform: active
                  ? `translate3d(${gesture.dx}px, ${gesture.dy}px, 0)`
                  : undefined,
                // The finger is the animation during a gesture.
                transition: active ? "none" : `left ${DURATION} ${EASE}, top ${DURATION} ${EASE}, width ${DURATION} ${EASE}, min-height ${DURATION} ${EASE}`,
              };

          return (
            <section
              key={w.id}
              data-widget={w.id}
              data-focused={state.focusId === w.id ? "true" : undefined}
              aria-label={w.title}
              style={style}
              className={[
                "flex flex-col overflow-hidden rounded-2xl border bg-card",
                state.focusId === w.id ? "border-accent" : "border-edge",
                active ? "shadow-lg" : "",
                narrow ? "" : "motion-reduce:transition-none",
              ].join(" ")}
              onClick={() => {
                if (state.focusId !== w.id) void send([{ op: "focus", id: w.id }]);
              }}
            >
              <header className="flex shrink-0 items-center gap-1 border-b border-edge">
                {/* 44px minimum. The Canvas shipped an 18px target on a row that
                    navigated away on a near miss; nothing here goes below 44. */}
                <button
                  type="button"
                  data-drag-handle={w.id}
                  aria-label={`Move ${w.title}`}
                  onPointerDown={(e) => onPointerDown(e, w, "drag")}
                  className="flex h-11 w-11 shrink-0 cursor-grab items-center justify-center text-muted active:cursor-grabbing"
                  style={{ touchAction: "none" }}
                >
                  <span aria-hidden className="text-base leading-none">⠿</span>
                </button>
                {/* Wraps, never truncates (docs/understanding/SPEC.md §9). A
                    title the user cannot read in full is a title cut off. The
                    header grows and the body gives up the height: the body is
                    what scrolls, the title is never elided. min-w-0 lets the
                    flex item shrink so the wrap happens at all. */}
                <h2 className="min-w-0 flex-1 wrap-break-word py-2 text-sm font-semibold text-ink">
                  {w.title}
                </h2>
                <button
                  type="button"
                  data-collapse={w.id}
                  aria-label={w.collapsed ? `Expand ${w.title}` : `Collapse ${w.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void send([{ op: w.collapsed ? "expand" : "collapse", id: w.id }]);
                  }}
                  className="h-11 w-11 shrink-0 text-muted hover:text-ink"
                >
                  <span aria-hidden>{w.collapsed ? "▸" : "▾"}</span>
                </button>
              </header>

              {/* The lede slot (docs/understanding/SPEC.md §7, §9): up to
                  three sentences above the rows, from the record, never from
                  the template. A React text child, so nothing here reaches
                  innerHTML. It wraps in full and shrinks never; the body
                  below is what gives up the height. A stale lede is dimmed
                  until the next run replaces it. */}
              {!w.collapsed && lede && (
                <p
                  data-lede={w.id}
                  title={lede.stale ? "Being re-read" : undefined}
                  className={[
                    "wk-lede shrink-0 wrap-break-word px-4 pt-3 text-sm leading-snug text-ink",
                    lede.stale ? "opacity-60" : "",
                  ].join(" ")}
                >
                  {lede.text}
                </p>
              )}

              {!w.collapsed && (
                <WidgetBody
                  widget={w}
                  rows={state.rows[w.id]}
                  maxHeight={narrow ? undefined : Math.max(0, rect.height - FRAME_PX)}
                />
              )}

              {!narrow && !w.collapsed && (
                <button
                  type="button"
                  data-resize-handle={w.id}
                  aria-label={`Resize ${w.title}`}
                  onPointerDown={(e) => onPointerDown(e, w, "resize")}
                  className="absolute bottom-0 right-0 h-11 w-11 cursor-se-resize text-muted"
                  style={{ touchAction: "none" }}
                >
                  <span aria-hidden className="absolute bottom-1.5 right-1.5 text-xs">◢</span>
                </button>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A widget's content. The template is written to the DOM exactly ONCE — keyed
 * by its markup — and every later change is applied to the existing nodes by
 * applyBindings. That is what keeps scroll position, selection and focus inside
 * a widget alive across a data refresh, instead of the blank-then-rebuild the
 * Canvas does.
 */
function WidgetBody({
  widget,
  rows,
  maxHeight,
}: {
  widget: Widget;
  rows?: BoundRow[];
  /** The grid height less the frame; undefined when stacked, where a body grows to its content. */
  maxHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const written = useRef<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Sanitized on the server before it reached this file; see
    // app/(app)/workspace/page.tsx. Re-written only when the template itself
    // changes, which is a model edit, not a data change.
    if (written.current !== widget.body) {
      el.innerHTML = widget.body;
      written.current = widget.body;
    }
    if (widget.query) {
      applyBindings(el, rows ?? [], { checkable: widget.query.source === "tasks" });
    }
    // widget.query is an object from state and would change identity on every
    // render; its SOURCE is the only part this effect depends on.
  }, [widget.body, widget.query, rows]);

  return (
    <div
      ref={ref}
      data-body={widget.id}
      // Stacked (narrow): the body grows to its content. On the grid: size
      // containment keeps the rows out of the widget's own height, so a lede
      // or a wrapped header takes its lines from the body, which scrolls;
      // the floor keeps one row visible when a lede would take them all
      // (see FRAME_PX and BODY_MIN_PX above).
      style={
        maxHeight === undefined
          ? undefined
          : { maxHeight, minHeight: BODY_MIN_PX, contain: "size" }
      }
      className="wk-body min-h-0 flex-1 overflow-auto px-4 py-3 text-sm text-ink"
    />
  );
}

function Toolbutton({
  onClick,
  label,
  disabled,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-11 rounded-lg border border-edge bg-card px-4 text-sm text-ink transition-colors hover:border-faint disabled:opacity-40"
    >
      {label}
    </button>
  );
}
