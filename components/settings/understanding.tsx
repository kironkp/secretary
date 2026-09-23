"use client";

// The understanding loop's Settings surface (docs/understanding/SPEC.md §8,
// §11 phase 6): whether the model can be called at all (the Model row, from
// GET /api/understanding/progress, where the thinking strip's "Settings"
// link lands), what the sweep is doing, the last run per project, and a
// button to run it now. Fetched on mount rather than server-rendered so the
// list refreshes after "Understand now" without a page reload.
import { useCallback, useEffect, useState } from "react";
import { Button, ErrorNote } from "@/components/ui";
import { PROGRESS_URL, type Progress, type ProviderSide } from "@/components/today/thinking-strip";

type ProjectRun = {
  projectId: string;
  projectName: string;
  lastStatus: "ok" | "failed" | "skipped";
  lastFinishedAt: string;
  lastModel: string | null;
  lastInputTokens: number;
  lastOutputTokens: number;
  lastErrors: string[];
};

type Status = {
  /** Which provider a run would use (lib/understanding/sweep.ts describeProvider); `provider` on the wire is the health object. */
  providerId: "anthropic" | "openai" | "none";
  model: string | null;
  sweepMinutes: number;
  disabled: boolean;
  projects: ProjectRun[];
  questionsOpen: number;
};

type RunNow = { ran: number; skipped: number; failed: number };

const STATUS_WORD: Record<ProjectRun["lastStatus"], string> = {
  ok: "read",
  failed: "failed",
  skipped: "skipped",
};

const STATUS_TONE: Record<ProjectRun["lastStatus"], string> = {
  ok: "text-ok",
  failed: "text-danger",
  skipped: "text-muted",
};

/** "just now", "4 minutes ago", "3 hours ago", "2 days ago". Digits, never rounded up to a lie. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * "October 1", in UTC like the server's line (lib/understanding/provider-health.ts
 * resetDay): the cap names its day in UTC, and the strip and this row must
 * name the same one. Nothing when the stamp does not parse.
 */
function monthDay(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" }).format(at);
}

/**
 * One model's standing, in a few words: "ready", "limit reached, resets
 * October 1", "no credits", "key not accepted", "no key". A connected key
 * is named by its tail, never shown.
 */
export function sideInWords(side: ProviderSide, keyTail: string | null): string {
  const state: Record<ProviderSide["state"], string> = {
    ok: "ready",
    capped: side.until ? `limit reached, resets ${monthDay(side.until)}` : "limit reached",
    "no-credits": "no credits",
    auth: "key not accepted",
    missing: "no key",
    unknown: "unknown",
  };
  const key = side.connected ? `your key${keyTail ? ` ····${keyTail}` : ""}, ` : "";
  return `${key}${state[side.state]}`;
}

/** "Claude: limit reached, resets October 1 · OpenAI: no credits" */
export function modelLine(provider: Progress["provider"], tails: { anthropic: string | null; openai: string | null }): string {
  return [
    `Claude: ${sideInWords(provider.anthropic, tails.anthropic)}`,
    `OpenAI: ${sideInWords(provider.openai, tails.openai)}`,
  ].join(" · ");
}

type Connection = { provider: string; keyTail: string };

function providerLine(status: Status): string {
  if (status.disabled) return "Turned off (UNDERSTANDING_DISABLED).";
  if (status.providerId === "none") {
    return "No model available: no API key is set and no Claude account is connected.";
  }
  const name = status.providerId === "anthropic" ? "Claude" : "OpenAI";
  return `${name}, ${status.model}.`;
}

export function UnderstandingSettings() {
  const [status, setStatus] = useState<Status | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<RunNow | null>(null);

  const load = useCallback(async () => {
    // Three reads, each shown as it lands: the Model row is two small
    // queries and should not wait for the per-project list. A part that
    // fails renders what it last had; the next load is a click away.
    const read = async <T,>(url: string, apply: (body: T) => void) => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) apply((await res.json()) as T);
      } catch {}
    };
    await Promise.all([
      read<Progress>(PROGRESS_URL, setProgress),
      read<{ connections?: Connection[] }>("/api/connections", (b) => setConnections(b.connections ?? [])),
      read<Status>("/api/understanding", setStatus),
    ]);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const runNow = async () => {
    setRunning(true);
    setError("");
    setOutcome(null);
    try {
      const res = await fetch("/api/understanding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json().catch(() => null)) as
        | (RunNow & { error?: string })
        | { error?: string }
        | null;
      if (!res.ok || !body || !("ran" in body)) {
        setError(body?.error ?? "That did not go through. Try again.");
        return;
      }
      setOutcome({ ran: body.ran, skipped: body.skipped, failed: body.failed });
    } catch {
      setError("Could not reach the server.");
    } finally {
      setRunning(false);
      void load();
    }
  };

  const tails = {
    anthropic: connections.find((c) => c.provider === "anthropic")?.keyTail ?? null,
    openai: connections.find((c) => c.provider === "openai")?.keyTail ?? null,
  };

  return (
    // The id is where the thinking strip's "Settings" link lands (SETTINGS_HREF).
    <div id="understanding" className="scroll-mt-4 space-y-4">
      {/* The Model row: can the model be called right now, and if not, why
          and what to do. The same facts the thinking strip shows as paused. */}
      <div data-model-row className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-wide text-muted">Model</p>
        {progress ? (
          <>
            <p className="text-sm">
              <span
                data-model-state={progress.provider.ok ? "ok" : "paused"}
                className={`font-semibold ${progress.provider.ok ? "text-ok" : "text-warn"}`}
              >
                {progress.provider.ok ? "Ready" : "Paused"}
              </span>
              <span className="text-muted"> · </span>
              <span className="wrap-anywhere text-muted" data-model-line>
                {modelLine(progress.provider, tails)}
              </span>
            </p>
            {progress.provider.action && (
              <p className="wrap-anywhere text-xs text-muted" data-model-action>
                {progress.provider.action}
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-muted">Loading.</p>
        )}
      </div>

      {status ? (
        <p className="text-xs text-muted">
          Reads your projects every {status.sweepMinutes} minutes; calls the model only when
          something changed. {providerLine(status)}
          {status.questionsOpen > 0 && (
            <>
              {" "}
              {status.questionsOpen} open question{status.questionsOpen === 1 ? "" : "s"}.
            </>
          )}
        </p>
      ) : (
        <p className="text-xs text-muted">Loading.</p>
      )}

      {status && status.projects.length === 0 && (
        <p className="text-sm text-muted">Nothing has run yet.</p>
      )}
      {status && status.projects.length > 0 && (
        <ul className="divide-y divide-edge text-sm">
          {status.projects.map((p) => (
            <li key={p.projectId} className="space-y-1 py-2">
              <p className="wrap-anywhere">
                <span className="font-semibold">{p.projectName}</span>
                <span className="text-muted"> · </span>
                <span className={STATUS_TONE[p.lastStatus]}>{STATUS_WORD[p.lastStatus]}</span>
                <span className="text-muted"> · {relativeTime(p.lastFinishedAt)}</span>
                {p.lastModel && (
                  <span className="text-[11px] text-faint"> · {p.lastModel}</span>
                )}
              </p>
              {/* Every error the validator gave, each in full: a failed run is
                  a list of path-and-rule messages and the first alone does
                  not say what to fix (SPEC §9, nothing is cut off). */}
              {p.lastStatus === "failed" &&
                p.lastErrors.map((e, i) => (
                  <p key={i} className="wrap-anywhere text-xs text-danger">
                    {e}
                  </p>
                ))}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={running || status?.disabled === true}
          onClick={() => void runNow()}
        >
          {running ? "Reading" : "Understand now"}
        </Button>
        {outcome && (
          <p className="text-xs text-muted">
            Ran {outcome.ran}, unchanged {outcome.skipped}, failed {outcome.failed}
          </p>
        )}
      </div>
      <ErrorNote>{error}</ErrorNote>
    </div>
  );
}
