"use client";

// The composer's model chip (Claude-app style): "Opus 5 · High" opens a small
// sheet with the model list (both providers) and the effort ladder for the
// selected provider. Persisted to persona — every window and device follows.
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

// Mirror of CHAT_MODELS/CHAT_EFFORTS in lib/anthropic.ts (server truth).
const MODELS = [
  { id: "claude-fable-5", label: "Fable 5", provider: "anthropic", hint: "toughest problems" },
  { id: "claude-opus-5", label: "Opus 5", provider: "anthropic", hint: "complex work" },
  { id: "claude-sonnet-5", label: "Sonnet 5", provider: "anthropic", hint: "fast + efficient" },
  { id: "gpt-5.5", label: "GPT-5.5", provider: "openai", hint: "default" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", provider: "openai", hint: "quick answers" },
] as const;

const EFFORTS: Record<string, readonly { id: string; label: string }[]> = {
  anthropic: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra" },
    { id: "max", label: "Max" },
  ],
  openai: [
    { id: "none", label: "Instant" },
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "xhigh", label: "Extra" },
  ],
};

function clampEffort(provider: string, effort: string): string {
  if (EFFORTS[provider].some((e) => e.id === effort)) return effort;
  if (effort === "max") return "xhigh";
  if (effort === "none") return "low";
  return "medium";
}

export function ModelChip({
  initialModel,
  initialEffort,
}: {
  initialModel: string;
  initialEffort: string;
}) {
  const [model, setModel] = useState(
    MODELS.some((m) => m.id === initialModel) ? initialModel : "gpt-5.5"
  );
  const [effort, setEffort] = useState(initialEffort);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = MODELS.find((m) => m.id === model) ?? MODELS[3];
  const ladder = EFFORTS[current.provider];
  const effortLabel = ladder.find((e) => e.id === effort)?.label ?? "Medium";

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const persist = (body: { chatModel?: string; chatEffort?: string }) => {
    void fetch("/api/persona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  };

  const pickModel = (id: string) => {
    const next = MODELS.find((m) => m.id === id)!;
    const nextEffort = clampEffort(next.provider, effort);
    setModel(id);
    setEffort(nextEffort);
    persist({ chatModel: id, chatEffort: nextEffort });
  };

  const pickEffort = (id: string) => {
    setEffort(id);
    persist({ chatEffort: id });
  };

  return (
    <div ref={rootRef} className="relative flex-none">
      {open && (
        <div className="absolute bottom-11 left-0 z-30 w-64 rounded-2xl border border-edge bg-surface p-2 shadow-2xl">
          <p className="px-2 pb-1 pt-0.5 text-[10px] font-bold uppercase tracking-wide text-faint">
            Model
          </p>
          {MODELS.map((m) => (
            <button
              key={m.id}
              onClick={() => pickModel(m.id)}
              className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm hover:bg-card"
            >
              <span>
                {m.label}
                <span className="ml-2 text-xs text-faint">{m.hint}</span>
              </span>
              {m.id === model && <Check size={14} strokeWidth={2.5} className="text-accent" />}
            </button>
          ))}
          <p className="px-2 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wide text-faint">
            Effort
          </p>
          <div className="flex gap-1 px-1 pb-1">
            {ladder.map((e) => (
              <button
                key={e.id}
                onClick={() => pickEffort(e.id)}
                className={`flex-1 rounded-lg px-1 py-1.5 text-[11px] font-semibold transition-colors ${
                  e.id === effort
                    ? "bg-accent text-bg"
                    : "bg-card text-muted hover:text-ink"
                }`}
              >
                {e.label}
              </button>
            ))}
          </div>
          <p className="px-2 pb-1 text-[10px] text-faint">
            Higher effort thinks longer before answering.
          </p>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Model and effort"
        aria-label="Model and effort"
        className={`flex h-9 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold transition-colors ${
          open ? "border-accent text-accent" : "border-edge text-muted hover:text-ink"
        }`}
      >
        {current.label}
        <span className="font-normal text-faint">{effortLabel}</span>
      </button>
    </div>
  );
}
