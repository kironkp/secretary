"use client";

// The Canvas host (SPEC §7.6): renders the latest sanitized snapshot in a
// sandboxed iframe and owns ALL interactivity from the host side — the
// document itself can never execute anything (no allow-scripts + CSP).
// Polls while a paint is streaming so the render lands progressively.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { History, Paintbrush } from "lucide-react";
import { CANVAS_SANDBOX } from "@/lib/canvas/sanitize";
import { CANVAS_REFRESH_EVENT } from "@/lib/canvas/refresh";
import { isMomentumTap } from "@/components/dashboard/shared";

type Snapshot = {
  id: string;
  brief: string;
  painting: boolean;
  createdAt: string;
  srcdoc: string;
  doneTaskIds: string[];
};
type HistoryRow = { id: string; brief: string; painting: boolean; createdAt: string };

export function CanvasView({
  pollMs = 15000,
}: {
  /** Idle poll interval; tighter when embedded in a live call. */
  pollMs?: number;
} = {}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The iframe grows to its content so the PAGE scrolls — an inner-scrolling
  // fixed-height iframe is exactly what breaks on iOS.
  const [frameH, setFrameH] = useState<number | null>(null);

  const measure = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc?.body) return;
    const h = Math.max(doc.body.scrollHeight, doc.documentElement?.scrollHeight ?? 0);
    if (h > 40) setFrameH(h + 24);
  }, []);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // Task ids crossed off: optimistic taps this session, plus server-seeded
  // done marks (doneTaskIds) so cross-offs survive a reload. Each poll/repaint
  // loads a fresh iframe document from the same static snapshot markup, so the
  // marks must be re-applied on every load or ticks would visually revert.
  // The SERVER is authoritative about what is done — this set is REPLACED on
  // every load, not unioned into. Unioning meant a task reopened elsewhere
  // stayed visibly crossed off here forever, and (once edits stop repainting)
  // a stale id would let a tap silently re-complete a task the user had
  // deliberately reopened. `pendingRef` carries the optimistic window between
  // a tap and the server agreeing.
  const checkedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  const isChecked = useCallback(
    (id: string) => checkedRef.current.has(id) || pendingRef.current.has(id),
    []
  );

  /** Shell-owned checkbox: the model never draws it and cannot fake one.
   *  Injected host-side into every [data-check], styled by the srcdoc's own
   *  stylesheet — so "put checkboxes on those" is a UI state change, not a
   *  repaint. */
  const applyDoneMarks = useCallback(
    (doc: Document) => {
      for (const el of Array.from(doc.querySelectorAll("[data-check]"))) {
        const id = el.getAttribute("data-check");
        if (!id) continue;
        // A table row can't host a positioned box (padding doesn't apply, and a
        // stray child becomes a phantom leading column), so put it in the row's
        // first cell. The id still resolves via closest("[data-check]").
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
          // Painted cards carry their own INLINE padding, which beats the
          // stylesheet's padding-left and would leave the box on top of the
          // text. Reserve the gutter inline, and only when it isn't already
          // wide enough.
          const current = parseFloat(
            doc.defaultView?.getComputedStyle(host).paddingLeft || "0"
          );
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

  // load() runs from three places (initial, poll, refresh event) with nothing
  // sequencing them. Without this, a slow earlier response can land after a
  // newer one and REPLACE the authoritative done-set with stale data — visibly
  // un-ticking a task the user just ticked.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    // The app stamps data-theme on <html> (there is no "dark" class anywhere),
    // so the old check always reported light and the canvas rendered light
    // inside a dark app.
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
      for (const id of Array.from(pendingRef.current)) {
        if (done.has(id)) pendingRef.current.delete(id);
      }
      const doc = frameRef.current?.contentDocument;
      if (doc) applyDoneMarks(doc);
    }
    // `painting` must be part of the identity check: now that the row is seeded
    // with the existing markup, an edit produces an IDENTICAL srcdoc while
    // painting flips true→false. Comparing markup alone left the view stuck
    // believing a paint was still in flight — polling every second forever and
    // showing "Painting…" over a finished canvas.
    setSnapshot((prev) =>
      prev &&
      data.snapshot &&
      prev.id === data.snapshot.id &&
      prev.srcdoc === data.snapshot.srcdoc &&
      prev.painting === data.snapshot.painting
        ? prev
        : data.snapshot
    );
  }, [applyDoneMarks]);

  // Initial load + poll: fast while painting (progressive render), slow otherwise.
  useEffect(() => {
    const timeout = setTimeout(() => void load(), 0);
    const interval = setInterval(() => void load(), snapshot?.painting ? 1000 : pollMs);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [snapshot?.painting, load, pollMs]);

  // A paint or edit just started: reload immediately rather than waiting out
  // the idle poll. Without this, a canvas operation was invisible for up to
  // pollMs (15s) whenever the user was already looking at the Canvas tab.
  useEffect(() => {
    const onRefresh = () => void load();
    window.addEventListener(CANVAS_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(CANVAS_REFRESH_EVENT, onRefresh);
  }, [load]);

  // data-check tap (SPEC §7.6): optimistic cross-off, then the same PATCH the
  // dashboard checkbox sends — including its rollback-on-failure contract.
  const completeTask = useCallback(
    async (taskId: string) => {
      if (isChecked(taskId)) return; // already done or in flight
      pendingRef.current.add(taskId);
      const doc = frameRef.current?.contentDocument;
      if (doc) applyDoneMarks(doc);
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done", source: "canvas" }),
      }).catch(() => null);
      if (!res?.ok) {
        pendingRef.current.delete(taskId);
        const cur = frameRef.current?.contentDocument;
        if (cur) applyDoneMarks(cur);
      }
    },
    [applyDoneMarks, isChecked]
  );

  // Shell interaction primitives: host-attached, never from model markup.
  // Idempotent per DOCUMENT (WeakSet), because iframe onLoad is not a
  // reliable wiring point everywhere: iOS WebKit can swap the initial
  // about:blank document for the srcdoc one AFTER load fires, discarding any
  // listeners attached to the first — taps then silently die (the iPhone
  // data-check bug). A retry loop below re-wires whichever document actually
  // committed; swapped-out documents fall out of the WeakSet on GC.
  const wiredDocs = useRef(new WeakSet<Document>());
  const wireShellBehaviors = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc || wiredDocs.current.has(doc)) return;
    wiredDocs.current.add(doc);
    applyDoneMarks(doc);
    doc.addEventListener("click", (e) => {
      // The tap that STOPS a momentum scroll is not intent. Without this the
      // canvas could silently complete a real task while the user was only
      // catching the page — the dashboard has guarded this for a while; the
      // canvas never did.
      if (isMomentumTap()) return;
      const el = e.target as Element | null;

      // Completion now requires the checkbox itself. Tapping anywhere on a
      // card used to complete it, which is a destructive action on a huge
      // target; the rest of the card expands instead.
      const box = el?.closest?.(".cv-box");
      if (box) {
        const owner = box.closest("[data-check]");
        const id = owner?.getAttribute("data-check");
        if (id) void completeTask(id);
        return;
      }

      const target = el?.closest?.("[data-expand],[data-link],[data-check]");
      if (!target) return;
      const link = target.getAttribute("data-link");
      if (link) {
        router.push(`/projects/${encodeURIComponent(link)}`);
        return;
      }
      target.classList.toggle("cv-expanded");
    });
  }, [router, applyDoneMarks, completeTask]);

  // Wiring retry: after every snapshot (re)load, keep re-attempting for a few
  // seconds so the committed document gets wired even where onLoad lied (see
  // wireShellBehaviors). The per-document marker makes repeats free.
  useEffect(() => {
    if (!snapshot) return;
    let tries = 0;
    const t = setInterval(() => {
      wireShellBehaviors();
      measure();
      if (++tries >= 16) clearInterval(t);
    }, 300);
    return () => clearInterval(t);
  }, [snapshot, wireShellBehaviors, measure]);

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
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <Paintbrush size={12} className={snapshot.painting ? "animate-pulse text-accent" : "text-accent"} aria-hidden />
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
            <li key={h.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-card">
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
      <iframe
        ref={frameRef}
        title="Canvas"
        sandbox={CANVAS_SANDBOX}
        srcDoc={snapshot.srcdoc}
        onLoad={() => {
          wireShellBehaviors();
          measure();
          // re-measure after fonts/layout settle
          setTimeout(measure, 350);
        }}
        style={frameH ? { height: `${frameH}px` } : undefined}
        className="min-h-[45vh] w-full rounded-2xl border border-edge bg-surface"
      />
    </div>
  );
}
