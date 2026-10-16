// Small pieces the detail dialog's task screen and event view share.

export function fmtFull(iso: string, withTime = true) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(new Date(iso));
}

export function Row({
  label,
  children,
  part,
  labelClass = "text-faint",
}: {
  label: string;
  children: React.ReactNode;
  part?: string;
  /** The task screen's labels are muted (4.5:1 on white); the event view keeps its own. */
  labelClass?: string;
}) {
  return (
    <div data-more-part={part} className="grid grid-cols-[92px_1fr] gap-2 py-1.5 text-sm">
      <span className={`pt-px text-xs ${labelClass}`}>{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}
