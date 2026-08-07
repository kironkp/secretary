"use client";

// Phase 7 renderer: maps the AI-generated layout spec onto the fixed component
// palette. "Layout updated" affordance with revert; 📌 pins lock a section's
// position against future regenerations.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pin, Sparkles, Undo2 } from "lucide-react";
import type { LayoutComponent, LayoutSpec } from "@/lib/layout/spec";
import type { EventRow, TaskRow } from "./shared";
import { BoardView, ListTable } from "./task-views";
import { CalendarStrip, FocusCard, OverdueCallout, ProcrastinationZone, ProjectGrid, StatTiles, SuggestedZone } from "./zones";
import { TimelineView } from "./timeline-view";

const DEFAULT_TITLES: Record<LayoutComponent, string | null> = {
  overdue_callout: null,
  stat_tiles: null,
  focus_card: null,
  kanban: "Board",
  list: "Tasks",
  calendar_strip: "This week",
  timeline: "Timeline",
  procrastination_zone: null,
  suggested_zone: null,
  project_grid: "Projects",
};

export function AdaptiveView({
  layout,
  version,
  pinned: initialPinned,
  updatedAt,
  tasks,
  suggestions,
  events,
  crossing,
  onDone,
}: {
  layout: LayoutSpec;
  version: number;
  pinned: string[];
  updatedAt: string | null;
  tasks: TaskRow[];
  suggestions: TaskRow[];
  events: EventRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
}) {
  const router = useRouter();
  const [pinned, setPinned] = useState<Set<string>>(new Set(initialPinned));
  const [reverting, setReverting] = useState(false);

  const togglePin = async (component: LayoutComponent) => {
    const next = !pinned.has(component);
    setPinned((p) => {
      const s = new Set(p);
      if (next) s.add(component);
      else s.delete(component);
      return s;
    });
    await fetch("/api/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pin", component, pinned: next }),
    });
  };

  const revert = async () => {
    setReverting(true);
    const res = await fetch("/api/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revert" }),
    });
    setReverting(false);
    if (res.ok) router.refresh();
  };

  const render = (component: LayoutComponent) => {
    switch (component) {
      case "overdue_callout":
        return <OverdueCallout tasks={tasks} />;
      case "stat_tiles":
        return <StatTiles tasks={tasks} events={events} />;
      case "focus_card":
        return <FocusCard tasks={tasks} crossing={crossing} onDone={onDone} />;
      case "kanban":
        return <BoardView tasks={tasks} crossing={crossing} onDone={onDone} />;
      case "list":
        return <ListTable tasks={tasks} crossing={crossing} onDone={onDone} />;
      case "calendar_strip":
        return <CalendarStrip events={events} />;
      case "timeline":
        return <TimelineView tasks={tasks} events={events} crossing={crossing} onDone={onDone} />;
      case "procrastination_zone":
        return <ProcrastinationZone tasks={tasks} />;
      case "suggested_zone":
        return <SuggestedZone suggestions={suggestions} />;
      case "project_grid":
        return <ProjectGrid tasks={tasks} />;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-edge bg-surface px-4 py-2 text-xs text-muted">
        {version === 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <Sparkles size={13} strokeWidth={1.75} /> Default arrangement — the AI reorganizes this
            as your life changes.
          </span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1.5">
              <Sparkles size={13} strokeWidth={1.75} /> AI-arranged (v{version}
              {updatedAt
                ? `, ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(updatedAt))}`
                : ""}
              )
            </span>
            <button
              onClick={revert}
              disabled={reverting}
              className="inline-flex items-center gap-1 rounded-full border border-edge px-2.5 py-0.5 hover:border-faint hover:text-ink disabled:opacity-50"
            >
              <Undo2 size={12} strokeWidth={2} /> revert
            </button>
          </>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-faint">
          <Pin size={12} strokeWidth={1.75} /> pin a section to lock its spot
        </span>
      </div>

      {layout.sections.map((s, i) => {
        const body = render(s.component);
        if (!body) return null;
        const title = s.title ?? DEFAULT_TITLES[s.component];
        const isPinned = pinned.has(s.component);
        return (
          <section key={`${s.component}-${i}`} className="group/section">
            <div className="mb-1.5 flex items-center gap-2">
              {title && <h2 className="text-sm font-bold text-muted">{title}</h2>}
              <button
                onClick={() => togglePin(s.component)}
                title={isPinned ? "Unpin — let the AI move this" : "Pin — never move this"}
                aria-label={isPinned ? "Unpin section" : "Pin section"}
                className={`ml-auto inline-flex items-center gap-1 text-xs transition-opacity ${
                  isPinned
                    ? "text-accent opacity-100"
                    : "text-muted opacity-0 hover:!opacity-100 group-hover/section:opacity-40"
                }`}
              >
                <Pin size={12} strokeWidth={1.75} fill={isPinned ? "currentColor" : "none"} />
                {isPinned ? "" : "pin"}
              </button>
            </div>
            {body}
          </section>
        );
      })}
    </div>
  );
}
