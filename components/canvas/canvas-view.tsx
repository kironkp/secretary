"use client";

// The Canvas host (SPEC §7.6): a WORKSPACE, not a picture.
//
// The shell owns geometry — where each block sits, how wide it is, what order
// they are in, and every animation. The model owns only what is inside each
// block, rendered in its own sandboxed document that can never execute.
//
// Two rules make the motion work, and both are easy to get wrong:
//   1. DOM ORDER NEVER CHANGES. React reordering a keyed array does
//      insert-before, which reloads any iframe inside it. Blocks live in an
//      absolutely positioned layer and move by transform only, so reordering
//      recomputes numbers and nothing remounts or reloads.
//   2. Transitions are armed one frame AFTER first placement, or every block
//      slides in from the origin on load.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { History, Paintbrush } from "lucide-react";
import { CANVAS_SANDBOX } from "@/lib/canvas/sanitize";
import { CANVAS_REFRESH_EVENT } from "@/lib/canvas/refresh";
import { isMomentumTap } from "@/components/dashboard/shared";
import { canvasPerf, perfEnabled, type PerfSnapshot } from "@/lib/canvas/perf";

type Block = { id: string; span: "full" | "half"; pinned: boolean; srcdoc: string };
type Snapshot = {
  id: string;
  brief: string;
  painting: boolean;
  createdAt: string;
  srcdoc: string;
  blocks: Block[];
  doneTaskIds: string[];
};
type HistoryRow = { id: string; brief: string; painting: boolean; createdAt: string };

// The app's motion language (components/shell/nav-tabs.tsx): the moved thing
// leads, everything displaced settles behind it.
const DURATION = 340;
const LEAD = "cubic-bezier(0.22, 0.9, 0.32, 1)";
const TRAIL = "cubic-bezier(0.6, 0.05, 0.35, 1)";
const GAP = 14;
const TWO_COL_MIN = 560;

export function CanvasView({ pollMs = 15000 }: { pollMs?: number } = {}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);

  const boardRef = useRef<HTMLDivElement>(null);
  const frameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const holderRefs = useRef(new Map<string, HTMLDivElement>());
  const heights = useRef(new Map<string, number>());
  const [boardH, setBoardH] = useState(0);
  const armed = useRef(false);
  // The block that moved most recently leads the motion; the rest trail.
  const leadId = useRef<string | null>(null);
  const prevOrder = useRef<string[]>([]);

  // Legacy single-document fallback: snapshots painted before the workspace
  // model, or any canvas whose blocks failed verification.
  const singleFrameRef = useRef<HTMLIFrameElement>(null);
  const blocks = useMemo(() => snapshot?.blocks ?? [], [snapshot]);
  const useBlocks = blocks.length > 0;

  // ── done state ────────────────────────────────────────────────────────────
  // The SERVER is authoritative; this is replaced per load, never unioned, so a
  // task reopened elsewhere stops showing as crossed off here.
  const checkedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  const isChecked = useCallback(
    (id: string) => checkedRef.current.has(id) || pendingRef.current.has(id),
    []
  );

  const applyDoneMarks = useCallback(
    (doc: Document) => {
      for (const el of Array.from(doc.querySelectorAll("[data-check]"))) {
        const id = el.getAttribute("data-check");
        if (!id) continue;
        // A table row can't host a positioned box; use its first cell.
        const host =
          el.tagName === "TR"
            ? (el.querySelector(":scope > td, :scope > th") as HTMLElement | null)
            : (el as HTMLElement);
        if (!host) continue;
        let box = host.querySelector(":scope > .cv-box");
        if (!box) {
          box = doc.createElement("span");
          box.className = "cv-box";
          box.setAttribute("role", "checkbox");
          host.classList.add("cv-checkable");
          // Painted cards carry inline padding, which beats the stylesheet —
          // reserve the gutter inline, and only if it isn't already wide enough.
          const current = parseFloat(doc.defaultView?.getComputedStyle(host).paddingLeft || "0");
          if (!(current >= 30)) host.style.paddingLeft = "30px";
          host.insertBefore(box, host.firstChild);
        }
        const on = isChecked(id);
        box.setAttribute("aria-checked", on ? "true" : "false");
        el.classList.toggle("cv-done", on);
      }
    },
    [isChecked]
  );

  const eachDoc = useCallback(
    (fn: (doc: Document) => void) => {
      if (useBlocks) {
        for (const frame of frameRefs.current.values()) {
          const doc = frame.contentDocument;
          if (doc) fn(doc);
        }
      } else {
        const doc = singleFrameRef.current?.contentDocument;
        if (doc) fn(doc);
      }
    },
    [useBlocks]
  );

  // ── layout ────────────────────────────────────────────────────────────────
  // Pack blocks into rows, then place each by transform. Pure geometry: no
  // model call, no network, no remount.
  const layout = useCallback(() => {
    const board = boardRef.current;
    if (!board || !blocks.length) return;
    const width = board.clientWidth;
    const twoCol = width >= TWO_COL_MIN;
    const colW = twoCol ? (width - GAP) / 2 : width;

    const rows: Block[][] = [];
    let row: Block[] = [];
    for (const b of blocks) {
      const span = twoCol ? b.span : "full";
      if (span === "full") {
        if (row.length) {
          rows.push(row);
          row = [];
        }
        rows.push([b]);
      } else {
        row.push(b);
        if (row.length === 2) {
          rows.push(row);
          row = [];
        }
      }
    }
    if (row.length) rows.push(row);

    let y = 0;
    for (const r of rows) {
      const full = r.length === 1 && (!twoCol || r[0].span === "full");
      let rowH = 0;
      r.forEach((b) => (rowH = Math.max(rowH, heights.current.get(b.id) ?? 120)));
      r.forEach((b, i) => {
        const holder = holderRefs.current.get(b.id);
        if (!holder) return;
        const x = full ? 0 : i * (colW + GAP);
        holder.style.width = `${full ? width : colW}px`;
        holder.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        if (armed.current) {
          const lead = b.id === leadId.current;
          holder.style.transition = `transform ${DURATION}ms ${lead ? LEAD : TRAIL} ${
            lead ? 0 : 55
          }ms, width ${DURATION}ms ${lead ? LEAD : TRAIL}`;
        }
      });
      y += rowH + GAP;
    }
    setBoardH(Math.max(0, y - GAP));
  }, [blocks]);

  useLayoutEffect(() => {
    layout();
    if (!armed.current && blocks.length) {
      // One frame later, or everything slides in from the origin on first paint.
      const raf = requestAnimationFrame(() => {
        armed.current = true;
        layout();
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [layout, blocks]);

  // Which block moved: it leads, the displaced ones trail behind it. This is
  // also where an operation stops being a request and becomes visible motion —
  // the number that answers "did the world respond when I spoke?".
  useEffect(() => {
    const order = blocks.map((b) => b.id);
    const before = prevOrder.current;
    if (before.length && order.length) {
      const moved = order.find((id, i) => before[i] !== id && before.includes(id));
      leadId.current = moved ?? null;
      if (moved) {
        canvasPerf.opPainted();
        canvasPerf.sampleFrames();
      }
    }
    prevOrder.current = order;
    canvasPerf.blocks = order.length;
  }, [blocks]);

  useEffect(() => {
    const onResize = () => layout();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [layout]);

  // Grow each frame to its own content so the PAGE scrolls, never the iframe —
  // an inner-scrolling fixed-height iframe is what breaks on iOS. Applied
  // imperatively: this is shell-owned geometry, not render state.
  const measure = useCallback(
    (id: string) => {
      const frame = frameRefs.current.get(id);
      const doc = frame?.contentDocument;
      if (!frame || !doc?.body) return;
      const h = Math.max(doc.body.scrollHeight, doc.documentElement?.scrollHeight ?? 0);
      if (h > 8 && heights.current.get(id) !== h) {
        heights.current.set(id, h);
        frame.style.height = `${h}px`;
        layout();
      }
    },
    [layout]
  );

  // ── wiring inside each block document ─────────────────────────────────────
  // Idempotent per DOCUMENT: iOS WebKit can swap the initial about:blank
  // document for the srcdoc one AFTER load fires, discarding listeners attached
  // to the first — a retry loop re-wires whichever document actually committed.
  const wiredDocs = useRef(new WeakSet<Document>());

  const completeTask = useCallback(
    async (taskId: string) => {
      if (isChecked(taskId)) return;
      pendingRef.current.add(taskId);
      eachDoc(applyDoneMarks);
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done", source: "canvas" }),
      }).catch(() => null);
      if (!res?.ok) {
        pendingRef.current.delete(taskId);
        eachDoc(applyDoneMarks);
      }
    },
    [applyDoneMarks, eachDoc, isChecked]
  );

  // Selection lives on the SERVER because voice reads it there. Optimistic
  // locally so the ring appears on touch, not on the round trip.
  const [selected, setSelected] = useState<string | null>(null);
  const selectBlock = useCallback(async (id: string) => {
    setSelected(id);
    await fetch("/api/canvas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "select", id }),
    }).catch(() => null);
  }, []);

  const wireDoc = useCallback(
    (doc: Document, blockId: string | null) => {
      if (wiredDocs.current.has(doc)) return;
      wiredDocs.current.add(doc);
      applyDoneMarks(doc);
      doc.addEventListener("click", (e) => {
        // The tap that STOPS a momentum scroll is not intent.
        if (isMomentumTap()) return;
        const el = e.target as Element | null;
        const box = el?.closest?.(".cv-box");
        if (box) {
          const id = box.closest("[data-check]")?.getAttribute("data-check");
          if (id) void completeTask(id);
          return;
        }
        // Any tap inside a block SELECTS it — this is the shared world model:
        // tapping here is what makes "make this bigger" mean this block a
        // second later, on the same state the voice tools read.
        if (blockId) void selectBlock(blockId);

        const target = el?.closest?.("[data-expand],[data-link],[data-check]");
        if (!target) return;
        const link = target.getAttribute("data-link");
        if (link) {
          router.push(`/projects/${encodeURIComponent(link)}`);
          return;
        }
        target.classList.toggle("cv-expanded");
        if (blockId) requestAnimationFrame(() => measure(blockId));
      });
    },
    [applyDoneMarks, completeTask, measure, router, selectBlock]
  );

  const wireAll = useCallback(() => {
    if (useBlocks) {
      for (const [id, frame] of frameRefs.current) {
        const doc = frame.contentDocument;
        if (doc) {
          wireDoc(doc, id);
          measure(id);
        }
      }
    } else {
      const doc = singleFrameRef.current?.contentDocument;
      if (doc) wireDoc(doc, null);
    }
  }, [measure, useBlocks, wireDoc]);

  useEffect(() => {
    if (!snapshot) return;
    let tries = 0;
    const t = setInterval(() => {
      wireAll();
      if (++tries >= 16) clearInterval(t);
    }, 300);
    return () => clearInterval(t);
  }, [snapshot, wireAll]);

  // ── data ──────────────────────────────────────────────────────────────────
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const root = document.documentElement;
    const stamped = root.getAttribute("data-theme");
    const isDark =
      stamped === "dark" ||
      (stamped !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const res = await fetch(`/api/canvas?dark=${isDark ? "1" : "0"}`);
    if (!res.ok) return;
    const data = (await res.json()) as { snapshot: Snapshot | null };
    if (seq !== loadSeq.current) return; // a newer load already applied
    if (data.snapshot) {
      const done = new Set(data.snapshot.doneTaskIds ?? []);
      checkedRef.current = done;
      for (const id of Array.from(pendingRef.current)) if (done.has(id)) pendingRef.current.delete(id);
      eachDoc(applyDoneMarks);
    }
    setSnapshot((prev) =>
      prev &&
      data.snapshot &&
      prev.id === data.snapshot.id &&
      prev.srcdoc === data.snapshot.srcdoc &&
      prev.painting === data.snapshot.painting &&
      sameBlocks(prev.blocks, data.snapshot.blocks)
        ? prev
        : data.snapshot
    );
  }, [applyDoneMarks, eachDoc]);

  useEffect(() => {
    const timeout = setTimeout(() => void load(), 0);
    const interval = setInterval(() => void load(), snapshot?.painting ? 1000 : pollMs);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [snapshot?.painting, load, pollMs]);

  // A canvas operation just started: reload now rather than waiting out the
  // idle poll, which was invisible-for-15s exactly when the user was watching.
  // This is also the clock start for "spoke → saw it move".
  useEffect(() => {
    const onRefresh = () => {
      canvasPerf.opStarted();
      void load();
    };
    window.addEventListener(CANVAS_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(CANVAS_REFRESH_EVENT, onRefresh);
  }, [load]);

  const mountedAt = useRef(0);
  const [perf, setPerf] = useState<PerfSnapshot | null>(null);
  useEffect(() => {
    mountedAt.current = performance.now();
    if (!perfEnabled()) return;
    canvasPerf.start();
    const update = () => setPerf(canvasPerf.snapshot());
    const off = canvasPerf.subscribe(update);
    const t = setInterval(update, 1000);
    return () => {
      off();
      clearInterval(t);
      canvasPerf.stop();
    };
  }, []);

  const restore = async (id: string) => {
    const res = await fetch("/api/canvas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore", id }),
    });
    if (res.ok) {
      setHistory(null);
      void load();
    }
  };

  const toggleHistory = async () => {
    if (history) return setHistory(null);
    const res = await fetch("/api/canvas?list=1");
    if (res.ok) setHistory(((await res.json()) as { snapshots: HistoryRow[] }).snapshots);
  };

  if (!snapshot) {
    return (
      <div className="flex h-[70vh] flex-col items-center justify-center gap-3 rounded-2xl border border-edge bg-surface text-center">
        <Paintbrush className="text-muted" size={28} aria-hidden />
        <p className="max-w-sm text-sm text-muted">
          Nothing painted yet. Ask the secretary — &ldquo;paint my week&rdquo;,
          &ldquo;show the album as a burndown&rdquo; — and it lands here in seconds.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {perf && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 rounded-xl border border-edge bg-surface-2 p-2.5 font-mono text-[10px] leading-snug text-muted sm:grid-cols-4">
          <Stat k="blocks" v={`${perf.blocks} · ${perf.frames} frames`} />
          <Stat k="first render" v={perf.firstRenderMs === null ? "—" : `${perf.firstRenderMs}ms`} />
          <Stat
            k="frame load"
            v={perf.frameLoadMs ? `${perf.frameLoadMs.mean}ms ~ ${perf.frameLoadMs.max}ms` : "—"}
          />
          <Stat
            k="op → moved"
            v={
              perf.opLatencyMs.n
                ? `${perf.opLatencyMs.last ?? "—"}ms (~${perf.opLatencyMs.mean}, max ${perf.opLatencyMs.max})`
                : "—"
            }
          />
          <Stat
            k="long tasks"
            v={
              perf.longTasks.count
                ? `${perf.longTasks.count} · max ${perf.longTasks.maxMs}ms`
                : "0 (or unsupported)"
            }
          />
          <Stat
            k="slow frames"
            v={perf.jank.sampled ? `${perf.jank.slow}/${perf.jank.sampled}` : "—"}
          />
          <Stat k="heap" v={perf.memoryMB === null ? "n/a" : `${perf.memoryMB} MB`} />
          <Stat k="selected" v={selected ?? "—"} />
        </dl>
      )}
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Paintbrush
            size={12}
            className={snapshot.painting ? "animate-pulse text-accent" : "text-accent"}
            aria-hidden
          />
          {snapshot.painting ? "Painting…" : snapshot.brief}
        </span>
        <button
          onClick={toggleHistory}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-muted transition-colors hover:text-ink"
        >
          <History size={12} aria-hidden /> History
        </button>
      </div>
      {history && (
        <ul className="space-y-1 rounded-xl border border-edge bg-surface p-2">
          {history.map((h) => (
            <li
              key={h.id}
              className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-card"
            >
              <span className="truncate text-xs">
                {h.brief}
                <span className="ml-2 text-muted">
                  {new Date(h.createdAt).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </span>
              <button
                onClick={() => restore(h.id)}
                className="ml-3 shrink-0 text-xs font-semibold text-accent hover:underline"
              >
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}

      {useBlocks ? (
        <div
          ref={boardRef}
          style={{ height: boardH ? `${boardH}px` : undefined }}
          className="relative w-full rounded-2xl bg-bg p-0"
        >
          {blocks.map((b) => (
            <div
              key={b.id}
              ref={(el) => {
                if (el) holderRefs.current.set(b.id, el);
                else holderRefs.current.delete(b.id);
              }}
              data-block={b.id}
              className={`absolute left-0 top-0 overflow-hidden rounded-2xl border bg-surface ${
                selected === b.id ? "border-accent ring-2 ring-accent/25" : "border-edge"
              }`}
            >
              <iframe
                ref={(el) => {
                  if (el) frameRefs.current.set(b.id, el);
                  else frameRefs.current.delete(b.id);
                }}
                title={b.id}
                sandbox={CANVAS_SANDBOX}
                srcDoc={b.srcdoc}
                onLoad={() => {
                  canvasPerf.frameLoaded(performance.now() - mountedAt.current);
                  wireAll();
                  measure(b.id);
                  setTimeout(() => measure(b.id), 350);
                }}
                scrolling="no"
                className="block w-full border-0 bg-transparent p-3"
              />
            </div>
          ))}
        </div>
      ) : (
        <iframe
          ref={singleFrameRef}
          title="Canvas"
          sandbox={CANVAS_SANDBOX}
          srcDoc={snapshot.srcdoc}
          onLoad={() => {
            wireAll();
            const doc = singleFrameRef.current?.contentDocument;
            const h = Math.max(doc?.body?.scrollHeight ?? 0, doc?.documentElement?.scrollHeight ?? 0);
            if (h > 40) setBoardH(h + 24);
          }}
          style={boardH ? { height: `${boardH}px` } : undefined}
          className="min-h-[45vh] w-full rounded-2xl border border-edge bg-surface"
        />
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex min-w-0 justify-between gap-2">
      <dt className="shrink-0 opacity-70">{k}</dt>
      <dd className="truncate text-ink">{v}</dd>
    </div>
  );
}

/** Identity by id+span+content, so a poll that changes nothing doesn't remount
 *  every frame (which would reload every document and undo the whole point). */
function sameBlocks(a: Block[], b: Block[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i].id && x.span === b[i].span && x.srcdoc === b[i].srcdoc);
}
