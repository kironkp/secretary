// Small pieces the detail dialog's task screen and event view share.

export function fmtFull(iso: string, withTime = true) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(new Date(iso));
}

export function Row({ label, children, part }: { label: string; children: React.ReactNode; part?: string }) {
  return (
    <div data-more-part={part} className="grid grid-cols-[92px_1fr] gap-2 py-1.5 text-sm">
      <span className="pt-px text-xs text-faint">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}
