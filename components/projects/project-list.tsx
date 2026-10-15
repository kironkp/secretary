"use client";

// One group of the Projects tab, in his order, with a grab handle on every row
// (docs/projects/SPEC.md §5): drag the handle, or use its arrow keys, and the
// project goes to that place and stays. The row moves at once; the moves are
// stored one after the other (lib/projects/move-queue.ts); a failed store puts
// it back with a plain line. A drag starts only at the handle: the rest of the
// row scrolls the page and opens the project on a tap. Held near the top or the
// bottom edge of the list's view, the list scrolls under the row.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { createMoveQueue, type MoveQueueState } from "@/lib/projects/move-queue";

export type ProjectRowView = { id: string; name: string; color: string | null; count: string };

// The app's motion (nav-tabs.tsx): 340 ms on the leading curve.
const MOVE_MS = 340;
const MOVE_EASE = "cubic-bezier(0.22, 0.9, 0.32, 1)";
const REDUCED = "(prefers-reduced-motion: reduce)";
/** The lifted row's height (the approved screen); the rows around it do not move for the extra. */
const LIFTED_PX = 60;
/** Held this close to an edge of the list's view, the list scrolls; faster the nearer, up to EDGE_SPEED px a frame. */
const EDGE_PX = 64;
const EDGE_SPEED = 18;
const useReducedMotion = () =>
  useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCED);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false
  );

/** The six-dot grab handle, 20 px. */
function Dots() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
      <circle cx="7" cy="4" r="1.6" />
      <circle cx="13" cy="4" r="1.6" />
      <circle cx="7" cy="10" r="1.6" />
      <circle cx="13" cy="10" r="1.6" />
      <circle cx="7" cy="16" r="1.6" />
      <circle cx="13" cy="16" r="1.6" />
    </svg>
  );
}

/**
 * A drag: where it started (the rows' centres, measured when it was picked up), how far the pointer has moved,
 * and how far the list has scrolled under it since.
 */
type Drag = { index: number; pointerId: number; startY: number; dy: number; scrolled: number; target: number; centers: number[]; height: number };

/**
 * The top of what covers the bottom of the screen (the tab bar, the voice button above it: [data-covers-bottom] in
 * the shell), or `bottom` if nothing does. The bottom edge zone sits above it, where a finger can see the rows.
 */
function coveredFrom(bottom: number): number {
  let top = bottom;
  for (const el of document.querySelectorAll("[data-covers-bottom]")) {
    const r = el.getBoundingClientRect();
    if (r.height > 0 && getComputedStyle(el).opacity !== "0") top = Math.min(top, r.top);
  }
  return top;
}

/** The element that scrolls the list: the nearest ancestor that scrolls, or the page. */
function scrollerOf(el: Element | null): HTMLElement {
  for (let e = el?.parentElement ?? null; e; e = e.parentElement) {
    const y = getComputedStyle(e).overflowY;
    if ((y === "auto" || y === "scroll") && e.scrollHeight > e.clientHeight) return e;
  }
  return document.scrollingElement as HTMLElement;
}

export function ProjectList({ group, rows, leading = null }: { group: string; rows: ProjectRowView[]; leading?: React.ReactNode }) {
  const reduced = useReducedMotion();
  const [state, setState] = useState<MoveQueueState<ProjectRowView[]>>({ shown: rows, line: null, says: null });
  const queue = useMemo(
    () =>
      createMoveQueue<ProjectRowView[]>(
        rows,
        async (m) => {
          const res = await fetch("/api/projects/order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: m.projectId, to: m.to }),
          });
          if (!res.ok) return { ok: false, error: `status ${res.status}` };
          const body = (await res.json().catch(() => ({}))) as { says?: string };
          return { ok: true, says: body.says };
        },
        setState
      ),
    // One queue for the life of the list; a fresh load of the page is taken by reset() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useEffect(() => queue.reset(rows), [queue, rows]);
  const [drag, setDragState] = useState<Drag | null>(null);
  // The same drag for the edge-scroll loop, which runs between renders.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const scroller = useRef<HTMLElement | null>(null);
  const startScroll = useRef(0);
  // The list's end, measured at the pickup, before the held row's transform can add to the scroller's overflow
  // (Chromium counts it): the edge scroll never goes past it.
  const endScroll = useRef(0);
  const pointerY = useRef(0);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const shown = state.shown;
  const dragging = drag !== null;

  /** Where the held row stands: under the pointer, plus however far the list has scrolled under it. */
  const place = (d: Drag, clientY: number, scrolled: number): Drag => {
    const dy = clientY - d.startY;
    const held = d.centers[d.index] + dy + scrolled;
    // Its new place: how many of the other rows stand above where it is held.
    const target = d.centers.filter((c, i) => i !== d.index && c < held).length;
    return { ...d, dy, scrolled, target };
  };

  // Held near an edge of the list's view, the list scrolls under it, every frame, until it is let go or moved away.
  // The bottom edge is above whatever covers the bottom of the screen; below it (over the tab bar) is full speed.
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const step = () => {
      const d = dragRef.current;
      const el = scroller.current;
      if (!d || !el) return;
      const view = el === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : el.getBoundingClientRect();
      const bottom = coveredFrom(view.bottom);
      const y = pointerY.current;
      const near = (depth: number) => Math.ceil(EDGE_SPEED * Math.min(1, depth / EDGE_PX));
      const speed = y < view.top + EDGE_PX ? -near(view.top + EDGE_PX - y) : y > bottom - EDGE_PX ? near(y - (bottom - EDGE_PX)) : 0;
      if (speed) {
        const to = Math.max(0, Math.min(endScroll.current, el.scrollTop + speed));
        if (to !== el.scrollTop) el.scrollTop = to;
      }
      // The row follows the list wherever its scroll stands, a clamp by the browser included.
      const scrolled = el.scrollTop - startScroll.current;
      if (scrolled !== d.scrolled) setDrag(place(d, y, scrolled));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);

  const moveTo = (from: number, to: number) => {
    if (to === from || to < 0 || to >= shown.length) return;
    const after = [...shown];
    const [moved] = after.splice(from, 1);
    after.splice(to, 0, moved);
    queue.move({ projectId: moved.id, name: moved.name, to }, after);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>, index: number) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rects = shown.map((r) => rowRefs.current.get(r.id)!.getBoundingClientRect());
    scroller.current = scrollerOf(e.currentTarget);
    startScroll.current = scroller.current.scrollTop;
    endScroll.current = Math.max(scroller.current.scrollTop, scroller.current.scrollHeight - scroller.current.clientHeight);
    pointerY.current = e.clientY;
    setDrag({ index, pointerId: e.pointerId, startY: e.clientY, dy: 0, scrolled: 0, target: index, centers: rects.map((r) => r.top + r.height / 2), height: rects[index].height });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    pointerY.current = e.clientY;
    // How far the list has scrolled, read now: a value kept from before a clamp would leave the row off the finger.
    setDrag(place(drag, e.clientY, (scroller.current?.scrollTop ?? startScroll.current) - startScroll.current));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { index, target } = drag;
    setDrag(null);
    moveTo(index, target);
  };
  const shiftOf = (i: number): number => {
    if (!drag || i === drag.index) return 0;
    if (drag.index < i && i <= drag.target) return -drag.height;
    if (drag.target <= i && i < drag.index) return drag.height;
    return 0;
  };

  return (
    <>
      <ul data-project-group={group} className="relative flex flex-col rounded-[12px] bg-card">
        {leading}
        {shown.map((p, i) => {
          const lifted = drag?.index === i;
          return (
            <li
              key={p.id}
              ref={(el) => {
                if (el) rowRefs.current.set(p.id, el);
                else rowRefs.current.delete(p.id);
              }}
              data-project-row=""
              data-project-name={p.name}
              data-lifted={lifted ? "true" : undefined}
              className={`relative flex min-h-14 items-center pl-4 pr-1 ${i > 0 || leading ? "border-t border-hairline" : ""} ${
                lifted ? "z-10 -mx-1.5 select-none rounded-[12px] border-transparent bg-lifted pl-[22px]" : "bg-card first:rounded-t-[12px] last:rounded-b-[12px]"
              }`}
              style={{
                // Under the pointer: it moved, and the list scrolled under it.
                transform: lifted ? `translateY(${drag!.dy + drag!.scrolled}px)` : `translateY(${shiftOf(i)}px)`,
                transition: lifted || reduced ? "none" : `transform ${MOVE_MS}ms ${MOVE_EASE}`,
                boxShadow: lifted ? "0 10px 28px rgba(0, 0, 0, 0.18)" : undefined,
                // Lifted, it is 60 tall, and gives the extra back above and below so no other row moves.
                ...(lifted && drag!.height < LIFTED_PX
                  ? { minHeight: LIFTED_PX, marginTop: -(LIFTED_PX - drag!.height) / 2, marginBottom: -(LIFTED_PX - drag!.height) / 2 }
                  : {}),
              }}
            >
              {/* The link takes the row up to the handle, the 12 px before it included: a tap there opens the project. */}
              <Link href={`/projects/${p.id}`} className="flex min-h-14 min-w-0 flex-1 items-center gap-3 self-stretch pr-3">
                <span data-project-dot="" aria-hidden className="h-3 w-3 flex-none rounded-full" style={{ background: p.color ?? "var(--color-accent)" }} />
                <span data-project-name-text="" className={`min-w-0 flex-1 truncate text-[17px] text-ink ${lifted ? "font-semibold" : "font-normal"}`}>
                  {p.name}
                </span>
                <span data-project-count="" className="flex-none text-[15px] text-muted">
                  {p.count}
                </span>
              </Link>
              <button
                type="button"
                aria-label={`Reorder ${p.name}`}
                className={`flex h-11 w-11 flex-none touch-none items-center justify-center ${lifted ? "cursor-grabbing text-accent-ink" : "cursor-grab text-faint"}`}
                onPointerDown={(e) => onPointerDown(e, i)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.preventDefault();
                    moveTo(i, e.key === "ArrowUp" ? i - 1 : i + 1);
                  }
                }}
              >
                <Dots />
              </button>
            </li>
          );
        })}
      </ul>
      {(state.line ?? state.says) && (
        <p role="status" className="px-4 pt-2 text-[15px] text-muted">
          {state.line ?? state.says}
        </p>
      )}
    </>
  );
}
