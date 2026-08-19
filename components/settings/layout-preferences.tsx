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
    case "pin_section":
      return `Keep ${p.value.section?.replaceAll("_", " ")} where it is`;
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

  const remove = async (id: string) => {
    setRows((r) => r.filter((row) => row.id !== id));
    const res = await fetch("/api/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove_preference", id }),
    });
    if (res.ok) router.refresh();
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
      {rows.map((p) => (
        <li
          key={p.id}
          className="flex items-center justify-between rounded-lg border border-edge bg-card px-3 py-2"
        >
          <span className="text-sm">{describe(p)}</span>
          <button
            onClick={() => remove(p.id)}
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
