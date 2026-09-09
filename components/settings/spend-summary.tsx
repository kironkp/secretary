"use client";

// Where the money went, navigable.
//
// Two interactions: a 1-day / 7-day / 30-day toggle, and swiping left/right to
// step through specific days, weeks and months. Swipe is the primary gesture on
// the phone, so it has to coexist with vertical page scrolling — the handler
// locks to an axis on the first meaningful movement and never fights a scroll.
//
// The first period is server-rendered so the panel has real numbers before any
// JavaScript runs; later periods are fetched.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatUsd } from "@/lib/pricing";
// From spend-types, NOT lib/spend: importing a value from there would pull the
// database (and pg, and node:dns) into the browser bundle and fail the build.
import { KIND_LABEL, type SpendPeriod, type SpendReport } from "@/lib/spend-types";

const PERIODS: { id: SpendPeriod; label: string }[] = [
  { id: "day", label: "1 day" },
  { id: "week", label: "7 days" },
  { id: "month", label: "30 days" },
];

function Bar({ fraction, tone }: { fraction: number; tone: string }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <span
        className={`block h-full rounded-full ${tone} transition-[width] duration-300`}
        style={{ width: `${Math.max(1.5, Math.min(100, fraction * 100))}%` }}
      />
    </span>
  );
}

function Rows({
  buckets,
  total,
  label,
  tone,
}: {
  buckets: SpendReport["byKind"];
  total: number;
  label: (key: string) => string;
  tone: string;
}) {
  if (!buckets.length) return <p className="text-sm text-muted">Nothing in this period.</p>;
  return (
    <ul className="space-y-2.5">
      {buckets.map((b) => (
        <li key={b.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate">
              {label(b.key)}
              {b.estimated && (
                <span className="ml-1.5 text-[10px] uppercase tracking-wide text-warn">est</span>
              )}
            </span>
            <span className="shrink-0 font-semibold tabular-nums">{formatUsd(b.usd)}</span>
          </div>
          <Bar fraction={total ? b.usd / total : 0} tone={tone} />
          <div className="text-[11px] tabular-nums text-faint">
            {b.calls} call{b.calls === 1 ? "" : "s"} · {(b.inputTokens / 1000).toFixed(0)}k in ·{" "}
            {(b.outputTokens / 1000).toFixed(0)}k out
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SpendSummary({
  initial,
  allTime,
}: {
  initial: SpendReport;
  allTime: { usd: number; calls: number };
}) {
  const [period, setPeriod] = useState<SpendPeriod>(initial.window.period);
  const [offset, setOffset] = useState(initial.window.offset);
  const [report, setReport] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState(0);
  const seq = useRef(0);

  const go = useCallback(
    async (nextPeriod: SpendPeriod, nextOffset: number) => {
      if (nextOffset > 0) return; // no spend in the future
      setPeriod(nextPeriod);
      setOffset(nextOffset);
      const mine = ++seq.current;
      setLoading(true);
      try {
        const res = await fetch(`/api/spend?period=${nextPeriod}&offset=${nextOffset}`);
        if (!res.ok) return;
        const data = (await res.json()) as { report: SpendReport };
        // A slower earlier request must not overwrite a newer period.
        if (mine === seq.current) setReport(data.report);
      } catch {
        /* leave the last good report on screen */
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    []
  );

  const older = useCallback(() => void go(period, offset - 1), [go, period, offset]);
  const newer = useCallback(() => {
    if (offset < 0) void go(period, offset + 1);
  }, [go, period, offset]);

  // ── swipe ────────────────────────────────────────────────────────────────
  // Axis-locked: the first movement decides whether this is a horizontal step
  // or a vertical scroll, and a vertical gesture is released back to the page
  // immediately. Without that, the panel would swallow scrolling.
  const touch = useRef<{ x: number; y: number; axis: "" | "x" | "y" } | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY, axis: "" };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const state = touch.current;
    if (!state) return;
    const t = e.touches[0];
    const dx = t.clientX - state.x;
    const dy = t.clientY - state.y;
    if (!state.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      state.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (state.axis !== "x") return;
    // Rubber-band against the edge so "there is nothing newer" is felt.
    const limited = dx < 0 && offset >= 0 ? dx * 0.25 : dx;
    setDrag(Math.max(-120, Math.min(120, limited)));
  };
  const onTouchEnd = () => {
    const state = touch.current;
    touch.current = null;
    const dx = drag;
    setDrag(0);
    if (!state || state.axis !== "x" || Math.abs(dx) < 55) return;
    // Swiping right reaches back in time; left comes forward.
    if (dx > 0) older();
    else newer();
  };

  // Arrow keys, because a period stepper that only works by touch is unusable
  // on a laptop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if (e.key === "ArrowLeft") older();
      if (e.key === "ArrowRight") newer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [older, newer]);

  const peak = Math.max(...report.daily.map((d) => d.usd), 0.0001);
  const unit = period === "day" ? "day" : period === "week" ? "week" : "month";

  return (
    <section
      className="space-y-5 overflow-hidden rounded-2xl border border-edge bg-surface p-5"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">API spend</h2>
        <div className="flex gap-1 rounded-full border border-edge p-0.5" role="tablist">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={period === p.id}
              // Switching unit returns to the current period: "7 days" means
              // this week, not the same offset counted in weeks.
              onClick={() => void go(p.id, 0)}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                period === p.id ? "bg-accent text-white" : "text-muted hover:text-ink"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div
        className="space-y-4"
        style={{
          transform: drag ? `translateX(${drag}px)` : undefined,
          transition: drag ? "none" : "transform 200ms cubic-bezier(0.22,0.9,0.32,1)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={older}
            aria-label={`Previous ${unit}`}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <ChevronLeft size={18} />
          </button>
          <div className={`min-w-0 text-center transition-opacity ${loading ? "opacity-50" : ""}`}>
            <div className="truncate text-sm font-semibold">{report.window.label}</div>
            <div className="text-2xl font-bold tabular-nums">{formatUsd(report.totalUsd)}</div>
            <div className="text-[11px] tabular-nums text-muted">
              {report.calls} call{report.calls === 1 ? "" : "s"}
              {report.days > 1 && <> · {formatUsd(report.perDayUsd)}/day</>}
            </div>
          </div>
          <button
            onClick={newer}
            disabled={offset >= 0}
            aria-label={`Next ${unit}`}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-25"
          >
            <ChevronRight size={18} />
          </button>
        </div>

        {report.daily.length > 1 && (
          <div className="flex h-14 items-end gap-[3px]" aria-hidden>
            {report.daily.map((d) => (
              <span
                key={d.day}
                title={`${d.day}: ${formatUsd(d.usd)}`}
                className={`flex-1 rounded-sm transition-[height] duration-300 ${
                  d.usd > 0 ? "bg-accent/70" : "bg-surface-2"
                }`}
                style={{ height: `${Math.max(3, (d.usd / peak) * 100)}%` }}
              />
            ))}
          </div>
        )}

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              What it was doing
            </h3>
            <Rows
              buckets={report.byKind}
              total={report.totalUsd}
              label={(k) => KIND_LABEL[k] ?? k}
              tone="bg-accent"
            />
          </div>
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Which model
            </h3>
            <Rows
              buckets={report.byModel}
              total={report.totalUsd}
              label={(k) => k}
              tone="bg-grape"
            />
          </div>
        </div>

        {report.biggest.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Most expensive single calls
            </h3>
            <ul className="divide-y divide-edge text-[13px]">
              {report.biggest.map((b) => (
                <li key={b.id} className="flex items-baseline justify-between gap-3 py-1.5">
                  <span className="truncate">
                    {KIND_LABEL[b.kind] ?? b.kind}
                    <span className="ml-2 text-[11px] text-faint">{b.model ?? "unknown"}</span>
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-faint">
                    {(b.inputTokens / 1000).toFixed(0)}k in
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{formatUsd(b.usd)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <p className="border-t border-edge pt-3 text-[11px] leading-relaxed text-faint">
        Swipe to move between {unit}s. All time: {formatUsd(allTime.usd)} across {allTime.calls}{" "}
        calls.
        {report.anyEstimated && (
          <>
            {" "}
            Rows marked <span className="text-warn">est</span> are upper bounds — a voice call
            whose audio/text split wasn&rsquo;t recorded is priced as all audio, and a model with
            no published rate is priced at the most expensive one we know.
          </>
        )}{" "}
        Work done through the Shop runs on your Claude subscription and is not billed here.
      </p>
    </section>
  );
}
