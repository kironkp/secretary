"use client";

// The brain picker: which Claude model parses your conversations (extraction,
// canvas painter, layout planner) and how hard it thinks. Voice stays OpenAI
// realtime — this is the intelligence behind it, not the mouth.
import { useState } from "react";
import { useRouter } from "next/navigation";

const MODELS = [
  { id: "claude-fable-5", label: "Fable 5", hint: "smartest — 2× Opus price" },
  { id: "claude-opus-5", label: "Opus 5", hint: "default — deep reasoning" },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "fast + cheaper" },
] as const;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_LABELS = ["Low", "Medium", "High", "Extra high", "Max"] as const;

export function BrainSettings({
  initialModel,
  initialEffort,
}: {
  initialModel: string;
  initialEffort: string;
}) {
  const router = useRouter();
  const [model, setModel] = useState(initialModel);
  const effortIndex = Math.max(0, EFFORTS.indexOf(initialEffort as (typeof EFFORTS)[number]));
  const [effort, setEffort] = useState(effortIndex >= 0 ? effortIndex : 2);
  const [saving, setSaving] = useState(false);

  const save = async (body: { brainModel?: string; brainEffort?: string }) => {
    setSaving(true);
    const res = await fetch("/api/persona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (res.ok) router.refresh();
  };

  return (
    <div className="space-y-4">
      <div>
        <select
          value={model}
          disabled={saving}
          onChange={(e) => {
            setModel(e.target.value);
            void save({ brainModel: e.target.value });
          }}
          className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm"
          aria-label="Brain model"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.hint}
            </option>
          ))}
        </select>
      </div>
      <div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={4}
            step={1}
            value={effort}
            disabled={saving}
            onChange={(e) => setEffort(Number(e.target.value))}
            onMouseUp={() => void save({ brainEffort: EFFORTS[effort] })}
            onTouchEnd={() => void save({ brainEffort: EFFORTS[effort] })}
            onKeyUp={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight")
                void save({ brainEffort: EFFORTS[effort] });
            }}
            className="flex-1 accent-accent"
            aria-label="Thinking effort"
          />
          <span className="w-32 text-right text-xs font-semibold">{EFFORT_LABELS[effort]}</span>
        </div>
        <div className="mt-1 flex justify-between text-[10px] uppercase tracking-wide text-faint">
          <span>Fast</span>
          <span>Deepest</span>
        </div>
        <p className="mt-2 text-[11px] text-faint">
          Effort applies to conversation parsing; the canvas painter and layout
          planner run the same model at low effort to stay fast.
        </p>
      </div>
    </div>
  );
}
