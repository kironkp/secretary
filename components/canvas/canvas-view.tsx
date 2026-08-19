"use client";

// The Canvas host (SPEC §7.6): renders the latest sanitized snapshot in a
// sandboxed iframe and owns ALL interactivity from the host side — the
// document itself can never execute anything (no allow-scripts + CSP).
// Polls while a paint is streaming so the render lands progressively.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { History, Paintbrush } from "lucide-react";
import { CANVAS_SANDBOX } from "@/lib/canvas/sanitize";

type Snapshot = {
  id: string;
  brief: string;
  painting: boolean;
  createdAt: string;
  srcdoc: string;
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

  const load = useCallback(async () => {
    const dark = document.documentElement.classList.contains("dark") ? "1" : "0";
    const res = await fetch(`/api/canvas?dark=${dark}`);
    if (!res.ok) return;
    const data = (await res.json()) as { snapshot: Snapshot | null };
    setSnapshot((prev) =>
      prev && data.snapshot && prev.id === data.snapshot.id && prev.srcdoc === data.snapshot.srcdoc
        ? prev
        : data.snapshot
    );
  }, []);

  // Initial load + poll: fast while painting (progressive render), slow otherwise.
  useEffect(() => {
    const timeout = setTimeout(() => void load(), 0);
    const interval = setInterval(() => void load(), snapshot?.painting ? 1000 : pollMs);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [snapshot?.painting, load, pollMs]);

  // Shell interaction primitives: host-attached, never from model markup.
  const wireShellBehaviors = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    doc.addEventListener("click", (e) => {
      const target = (e.target as Element | null)?.closest?.("[data-expand],[data-link]");
      if (!target) return;
      const link = target.getAttribute("data-link");
      if (link) {
        router.push(`/projects/${encodeURIComponent(link)}`);
        return;
      }
      target.classList.toggle("cv-expanded");
    });
  }, [router]);

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
