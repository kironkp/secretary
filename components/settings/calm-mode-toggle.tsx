"use client";

// Calm mode (SPEC §1 invariant 7): the dashboard renders DEFAULT_PLAN
// unconditionally and the planner is never consulted — the user's total veto
// over adaptation, one tap, no questions asked.
import { useState } from "react";
import { useRouter } from "next/navigation";

export function CalmModeToggle({ initial }: { initial: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    const next = !on;
    setOn(next);
    setBusy(true);
    const res = await fetch("/api/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "calm_mode", enabled: next }),
    });
    setBusy(false);
    if (!res.ok) setOn(!next);
    else router.refresh();
  };

  return (
    <button
      onClick={toggle}
      disabled={busy}
      role="switch"
      aria-checked={on}
      className="flex w-full items-center justify-between rounded-lg border border-edge bg-card px-3 py-2 text-left"
    >
      <span className="text-sm font-medium">{on ? "Calm mode is on" : "Calm mode is off"}</span>
      <span
        className={`relative h-5 w-9 rounded-full transition-colors ${on ? "bg-accent" : "bg-edge"}`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
            on ? "translate-x-4.5" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}
