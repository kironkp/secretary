"use client";

// Stored layout preferences (SPEC §7.5): a dislike stated once in chat never
// has to be re-stated — and can be un-stated here with one tap.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

export type PreferenceRow = {
  id: string;
  kind: string;
  value: Record<string, string>;
};

function describe(p: PreferenceRow): string {
  switch (p.kind) {
    case "ban_component":
      return `Never show ${p.value.component?.replaceAll("_", " ")}`;
    case "placed":
      return `Keep ${p.value.name} where you put it`;
    case "hide_section":
      return `Hide ${p.value.name}`;
    case "default_variant_for":
      return `Always show ${p.value.project} as ${p.value.variant}`;
    case "accent_policy":
      return p.value.policy === "never" ? "Never use the accent ring" : "Accent ring: automatic";
    default:
      return p.kind;
  }
}

export function LayoutPreferences({ initial }: { initial: PreferenceRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [refused, setRefused] = useState<string | null>(null);

  const remove = async (row: PreferenceRow) => {
    setRefused(null);
    setRows((r) => r.filter((other) => other.id !== row.id));
    // Letting go of something he placed is a request about the board, the
    // same one the pin button makes; the rest are stored preferences.
    const res = await fetch("/api/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row.kind === "placed" ? { action: "pin", component: row.value.section, pinned: false } : { action: "remove_preference", id: row.id }),
    });
    if (res.ok) return router.refresh();
    // Refused (a section he added stays placed): the row is back, with why.
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    setRows(initial);
    setRefused(body?.error ?? "That could not be removed.");
  };

  if (!rows.length) {
    return (
      <p className="text-xs text-muted">
        None yet. Tell the secretary things like &ldquo;stop showing me the people
        section&rdquo; and they&rsquo;ll be kept here.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {refused && <li className="text-xs text-muted">{refused}</li>}
      {rows.map((p) => (
        <li
          key={p.id}
          className="flex items-center justify-between rounded-lg border border-edge bg-card px-3 py-2"
        >
          <span className="text-sm">{describe(p)}</span>
          <button
            onClick={() => remove(p)}
            title="Remove this preference"
            className="text-muted transition-colors hover:text-ink"
          >
            <X size={14} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}
