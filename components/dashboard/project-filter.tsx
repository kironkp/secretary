"use client";

// Project filter chips for Board, List and Calendar (SEC-A007, T1): All, then
// each project by most recent activity, one tap to narrow the view to it.
// Remembered on this device; the Timeline keeps its own (its progress strip).
// A filter applied before the views render: the shell's, no model involved.
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { PlanProject } from "./plan-view";
import type { TaskRow } from "./shared";

const KEY = "secretary:project-filter";
const EVENT = "secretary:project-filter";

function read(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** The project the views are narrowed to, or "all", and how to change it. */
export function useProjectFilter(projects: PlanProject[]): [string, (id: string) => void] {
  const raw = useSyncExternalStore(
    (cb) => {
      window.addEventListener(EVENT, cb);
      return () => window.removeEventListener(EVENT, cb);
    },
    read,
    () => null
  );
  // A project since deleted or archived falls back to All.
  const value = raw && projects.some((p) => p.id === raw) ? raw : "all";
  const set = useCallback((id: string) => {
    try {
      if (id === "all") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, id);
    } catch {
      /* not remembered on this device; still applies now */
    }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [value, set];
}

/** Active projects (lists left out), the most recently active first. */
export function byActivity(projects: PlanProject[], tasks: TaskRow[]): PlanProject[] {
  const last = new Map<string, string>();
  for (const t of tasks) {
    if (!t.projectId) continue;
    const seen = last.get(t.projectId);
    if (!seen || t.updatedAt > seen) last.set(t.projectId, t.updatedAt);
  }
  return projects
    .filter((p) => p.kind !== "list" && (p.status ?? "active") === "active")
    .toSorted((a, b) => (last.get(b.id) ?? "").localeCompare(last.get(a.id) ?? "") || a.name.localeCompare(b.name));
}

export function ProjectFilterChips({
  projects,
  tasks,
  value,
  onChange,
}: {
  projects: PlanProject[];
  tasks: TaskRow[];
  value: string;
  onChange: (id: string) => void;
}) {
  const ordered = useMemo(() => byActivity(projects, tasks), [projects, tasks]);
  if (ordered.length === 0) return null;
  const chip = (on: boolean) =>
    `inline-flex min-h-11 flex-none items-center rounded-full border px-3.5 text-xs font-semibold whitespace-nowrap ${
      on ? "border-accent bg-accent/10 text-accent" : "border-edge text-muted hover:text-ink"
    }`;
  return (
    <div role="group" aria-label="Show one project" data-testid="project-filter" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      <button type="button" aria-pressed={value === "all"} onClick={() => onChange("all")} className={chip(value === "all")}>
        All
      </button>
      {ordered.map((p) => (
        <button key={p.id} type="button" aria-pressed={value === p.id} onClick={() => onChange(p.id)} className={chip(value === p.id)}>
          {p.name}
        </button>
      ))}
    </div>
  );
}
