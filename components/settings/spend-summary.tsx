// Where the money went. Server-rendered from priced usage rows.
//
// Designed to answer one question fast: what is costing the most? So the
// biggest bucket leads, every row carries a bar you can compare at a glance,
// and anything whose price rests on an assumption says so rather than
// presenting a guess as a fact.
import { formatUsd } from "@/lib/pricing";
import { KIND_LABEL, type SpendReport } from "@/lib/spend";

function Bar({ fraction, tone }: { fraction: number; tone: string }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <span
        className={`block h-full rounded-full ${tone}`}
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
  if (!buckets.length) return <p className="text-sm text-muted">Nothing recorded yet.</p>;
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
            <span className="shrink-0 tabular-nums font-semibold">{formatUsd(b.usd)}</span>
          </div>
          <Bar fraction={total ? b.usd / total : 0} tone={tone} />
          <div className="text-[11px] tabular-nums text-faint">
            {b.calls} call{b.calls === 1 ? "" : "s"} ·{" "}
            {(b.inputTokens / 1000).toFixed(0)}k in · {(b.outputTokens / 1000).toFixed(0)}k out
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SpendSummary({
  report,
  allTime,
}: {
  report: SpendReport;
  allTime: { usd: number; calls: number };
}) {
  const peak = Math.max(...report.daily.map((d) => d.usd), 0.0001);

  return (
    <section className="space-y-5 rounded-2xl border border-edge bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">API spend</h2>
          <p className="mt-0.5 text-xs text-muted">
            Last {report.days} days · {report.calls} model calls
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tabular-nums">{formatUsd(report.totalUsd)}</div>
          <div className="text-[11px] text-muted tabular-nums">
            ≈ {formatUsd(report.monthlyRunRateUsd)}/month at this rate
          </div>
        </div>
      </div>

      {report.daily.length > 1 && (
        <div className="flex h-14 items-end gap-[3px]" aria-hidden>
          {report.daily.map((d) => (
            <span
              key={d.day}
              title={`${d.day}: ${formatUsd(d.usd)}`}
              className="flex-1 rounded-sm bg-accent/70"
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
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Which model</h3>
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
                <span className="shrink-0 tabular-nums font-semibold">{formatUsd(b.usd)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="border-t border-edge pt-3 text-[11px] leading-relaxed text-faint">
        All time: {formatUsd(allTime.usd)} across {allTime.calls} calls.
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
