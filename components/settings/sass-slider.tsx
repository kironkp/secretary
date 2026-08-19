"use client";

// The sass dial (Monday-inspired): 1 robotic … 5 full sass. Writes the same
// persona the update_persona chat tool does; applies to chat, voice delivery,
// and the nag engine from the next conversation on.
import { useState } from "react";
import { useRouter } from "next/navigation";

const LEVELS = ["Robotic", "Dry professional", "Deadpan", "Sardonic", "Full sass"] as const;

export function SassSlider({ initial }: { initial: number }) {
  const router = useRouter();
  const [level, setLevel] = useState(initial);
  const [saving, setSaving] = useState(false);

  const commit = async (next: number) => {
    setSaving(true);
    const res = await fetch("/api/persona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sass: next }),
    });
    setSaving(false);
    if (!res.ok) setLevel(initial);
    else router.refresh();
  };

  return (
    <div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={1}
          max={5}
          step={1}
          value={level}
          disabled={saving}
          onChange={(e) => setLevel(Number(e.target.value))}
          onMouseUp={() => void commit(level)}
          onTouchEnd={() => void commit(level)}
          onKeyUp={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") void commit(level);
          }}
          className="flex-1 accent-accent"
          aria-label="Sass level"
        />
        <span className="w-32 text-right text-xs font-semibold">{LEVELS[level - 1]}</span>
      </div>
      <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wide text-faint">
        <span>Robotic</span>
        <span>Full sass</span>
      </div>
    </div>
  );
}
