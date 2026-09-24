"use client";

// The Memory tab (the user's words: "I'm going to remember for the future
// that this is how a CPO works, so that if he mentions a CPO, I can remember
// these steps"). Two lists, read once on the server: the processes Secretary
// can replay (pipeline_templates) and the facts it keeps (memories). The only
// write is forgetting one, confirmed inline on the row itself.
import { useState } from "react";

export type MemoryProcess = {
  id: string;
  name: string;
  recurrence: string | null;
  steps: { name: string; blocked_by?: number | null; offset_days?: number | null }[];
};

export type MemoryFact = {
  id: string;
  fact: string;
  tags: string[];
  /** Pre-formatted on the server in the user's timezone, so hydration agrees. */
  date: string;
};

/** Tags that every fact of a kind carries; they say how it arrived, not what
 *  it is about, so on a list of facts they are noise. */
const QUIET_TAGS = new Set(["answer", "inferred"]);

const PAGE = 40;

type Kind = "facts" | "processes";

async function forget(kind: Kind, id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/memory/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
    // Already gone is as good as gone.
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/** The inline "Forget" control: one tap arms it, the second confirms. */
function ForgetButton({
  label,
  onForget,
}: {
  label: string;
  onForget: () => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        aria-label={`Forget ${label}`}
        className="-my-2 -mr-2 grid min-h-11 min-w-11 flex-none place-items-center text-faint active:opacity-60"
      >
        <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    );
  }
  return (
    <span className="-my-2 -mr-1 flex flex-none items-center gap-1" data-forget-confirm>
      <button
        type="button"
        onClick={() => setArmed(false)}
        disabled={busy}
        className="min-h-11 px-2 text-[15px] text-faint disabled:opacity-50"
      >
        Keep
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onForget();
          setBusy(false);
          setArmed(false);
        }}
        className="min-h-11 px-2 text-[15px] font-semibold text-danger disabled:opacity-50"
      >
        {busy ? "Forgetting…" : "Forget"}
      </button>
    </span>
  );
}

function SectionLabel({ children, count }: { children: React.ReactNode; count: number }) {
  return (
    <h2 className="px-4 text-[13px] font-semibold text-faint">
      {children}
      {count > 0 && <span className="font-normal"> · {count}</span>}
    </h2>
  );
}

function stepMeta(step: MemoryProcess["steps"][number], i: number): string | null {
  const parts: string[] = [];
  // A plain chain (each step waits on the one before) needs no note; only a
  // step that waits on something further back does.
  if (step.blocked_by != null && step.blocked_by !== i - 1 && step.blocked_by >= 0 && step.blocked_by < i) {
    parts.push(`after step ${step.blocked_by + 1}`);
  }
  if (step.offset_days != null && step.offset_days !== 0) {
    parts.push(step.offset_days > 0 ? `day ${step.offset_days}` : `${-step.offset_days}d before`);
  }
  return parts.length ? parts.join(" · ") : null;
}

export function MemoryView({
  processes: initialProcesses,
  facts: initialFacts,
}: {
  processes: MemoryProcess[];
  facts: MemoryFact[];
}) {
  const [processes, setProcesses] = useState(initialProcesses);
  const [facts, setFacts] = useState(initialFacts);
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);

  async function forgetProcess(id: string) {
    setError(null);
    if (await forget("processes", id)) setProcesses((p) => p.filter((x) => x.id !== id));
    else setError("That didn't go through. Try again in a moment.");
  }
  async function forgetFact(id: string) {
    setError(null);
    if (await forget("facts", id)) setFacts((f) => f.filter((x) => x.id !== id));
    else setError("That didn't go through. Try again in a moment.");
  }

  const visibleFacts = facts.slice(0, shown);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-1.5" data-testid="memory">
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-semibold text-faint">What I keep between conversations</p>
        <h1 className="text-[34px] font-bold leading-[1.2] tracking-[-0.01em]">Memory</h1>
      </div>

      {error && (
        <p role="alert" className="px-1 text-[15px] text-danger">
          {error}
        </p>
      )}

      <section className="flex flex-col gap-2" data-testid="memory-processes">
        <SectionLabel count={processes.length}>Processes</SectionLabel>
        {processes.length === 0 ? (
          <p className="px-4 text-[15px] leading-[1.4] text-faint">
            No processes yet. Describe one in an answer or in chat and it lands here.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {processes.map((p) => (
              <li key={p.id} className="rounded-2xl bg-card px-4 pb-3 pt-3.5" data-process={p.id}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[17px] font-semibold leading-[1.3] wrap-anywhere">{p.name}</h3>
                    <p className="text-[13px] text-faint">
                      {p.steps.length} {p.steps.length === 1 ? "step" : "steps"}
                      {p.recurrence ? ` · ${p.recurrence}` : ""}
                    </p>
                  </div>
                  <ForgetButton label={p.name} onForget={() => forgetProcess(p.id)} />
                </div>
                <ol className="mt-2 flex flex-col">
                  {p.steps.map((s, i) => {
                    const meta = stepMeta(s, i);
                    return (
                      <li key={i} className="flex gap-3 py-1.5 text-[15px] leading-[1.4]">
                        <span className="w-5 flex-none text-right tabular-nums text-faint">{i + 1}</span>
                        <span className="min-w-0 flex-1 wrap-anywhere">
                          {s.name}
                          {meta && <span className="text-[13px] text-faint"> · {meta}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2" data-testid="memory-facts">
        <SectionLabel count={facts.length}>Facts</SectionLabel>
        {facts.length === 0 ? (
          <p className="px-4 text-[15px] leading-[1.4] text-faint">
            Nothing yet. When you tell me something worth keeping, it shows up here.
          </p>
        ) : (
          <>
            <ul className="ios-group rounded-2xl bg-card">
              {visibleFacts.map((f) => {
                const tags = f.tags.filter((t) => !QUIET_TAGS.has(t.toLowerCase()));
                return (
                  <li key={f.id} className="flex items-start gap-3 px-4 py-3" data-fact={f.id}>
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] leading-[1.4] wrap-anywhere">{f.fact}</p>
                      <p className="mt-0.5 text-[13px] text-faint wrap-anywhere">
                        {f.date}
                        {tags.length > 0 && ` · ${tags.join(", ")}`}
                      </p>
                    </div>
                    <ForgetButton label="this fact" onForget={() => forgetFact(f.id)} />
                  </li>
                );
              })}
            </ul>
            {facts.length > shown && (
              <button
                type="button"
                onClick={() => setShown((n) => n + PAGE)}
                className="grid min-h-11 w-full place-items-center text-[17px] text-accent"
              >
                Show more ({facts.length - shown})
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
