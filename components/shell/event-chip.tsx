"use client";

// The header today-strip's next-event pill — click for full event detail.
import { Calendar } from "lucide-react";
import { openDetail } from "@/components/dashboard/shared";

export function EventChipButton({ id, label }: { id: string; label: string }) {
  return (
    <button
      onClick={() => openDetail("event", id)}
      title="Event details"
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-edge bg-card px-3 py-1 text-muted transition-colors hover:border-faint hover:text-ink"
    >
      <Calendar size={11} strokeWidth={1.75} />
      {label}
    </button>
  );
}
