"use client";

// Overview renderer (phase 7 engine, reference visual language): maps the AI
// layout spec onto the fixed component palette. Quiet "arranged for you" line
// only when the AI has actually rearranged; pins appear on section hover.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pin, Sparkles, Undo2 } from "lucide-react";
import type { LayoutComponent, LayoutSpec } from "@/lib/layout/spec";
import type { DocRow, EventRow, TaskRow } from "./shared";
import { BoardView } from "./task-views";
import {
  CalendarStrip,
  ComingUpStrip,
  DocumentsZone,
  FiveWeekTimeline,
  NextUpHero,
  OpenLoopsTable,
  OverdueCallout,
  ProcrastinationZone,
  ProjectGrid,
  StatTiles,
  SuggestedZone,
} from "./zones";

const DEFAULT_TITLES: Record<LayoutComponent, string | null> = {
  overdue_callout: null,
  stat_tiles: null,
  focus_card: "Next up",
  kanban: "Board",
  list: "Open loops",
  calendar_strip: "This week",
  timeline: "Next 5 weeks",
  procrastination_zone: null,
  suggested_zone: null,
  project_grid: "Projects",
  coming_up: "Coming up",
  documents: "Documents",
};

const SECTION_NOTES: Partial<Record<LayoutComponent, string>> = {
  focus_card: "The one thing that matters before anything else does.",
  project_grid: "The unit your life is actually organized in.",
  timeline: "Colour is deadline pressure, not project identity.",
  list: "Grouped by project · undated items sink to the bottom of their group.",
};

export function AdaptiveView({
  layout,
  version,
  pinned: initialPinned,
  updatedAt,
  tasks,
  suggestions,
  events,
  docs,
  crossing,
  onDone,
  fresh,
}: {
  layout: LayoutSpec;
  version: number;
  pinned: string[];
  updatedAt: string | null;
  tasks: TaskRow[];
  suggestions: TaskRow[];
  events: EventRow[];
  docs: DocRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
  fresh?: Set<string>;
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
        return <NextUpHero tasks={tasks} events={events} />;
      case "kanban":
        return <BoardView tasks={tasks} crossing={crossing} onDone={onDone} fresh={fresh} />;
      case "list":
        return (
          <OpenLoopsTable
            tasks={tasks}
            events={events}
            crossing={crossing}
            onDone={onDone}
            fresh={fresh}
          />
        );
      case "calendar_strip":
        return <CalendarStrip events={events} />;
      case "timeline":
        return <FiveWeekTimeline tasks={tasks} events={events} />;
      case "procrastination_zone":
        return <ProcrastinationZone tasks={tasks} />;
      case "suggested_zone":
        return <SuggestedZone suggestions={suggestions} />;
      case "project_grid":
        return <ProjectGrid tasks={tasks} events={events} crossing={crossing} onDone={onDone} />;
      case "coming_up":
        return <ComingUpStrip tasks={tasks} events={events} />;
      case "documents":
        return <DocumentsZone docs={docs} fresh={fresh} />;
    }
  };

  return (
    <div className="space-y-7">
      {version > 0 && (
        <p className="flex items-center gap-2 text-xs text-faint">
          <Sparkles size={12} strokeWidth={1.75} />
          Arranged for you
          {updatedAt &&
            ` · ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(updatedAt))}`}
          <button
            onClick={revert}
            disabled={reverting}
            className="inline-flex items-center gap-1 text-faint underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
          >
            <Undo2 size={11} strokeWidth={2} /> revert
          </button>
        </p>
      )}

      {layout.sections.map((s, i) => {
        const body = render(s.component);
        if (!body) return null;
        const title = s.title ?? DEFAULT_TITLES[s.component];
        const note = SECTION_NOTES[s.component];
        const isPinned = pinned.has(s.component);
        return (
          <section key={`${s.component}-${i}`} className="group/section">
            {(title || isPinned) && (
              <div className="mb-2.5 flex items-baseline gap-3">
                {title && (
                  <h2 className="text-xs font-bold uppercase tracking-[0.1em] text-faint">
                    {title}
                  </h2>
                )}
                {note && <span className="hidden text-[11px] text-faint/80 sm:inline">{note}</span>}
                <button
                  onClick={() => togglePin(s.component)}
                  title={isPinned ? "Unpin — let the AI move this" : "Pin — never move this"}
                  aria-label={isPinned ? "Unpin section" : "Pin section"}
                  className={`ml-auto inline-flex items-center gap-1 text-[11px] transition-opacity ${
                    isPinned
                      ? "text-accent opacity-100"
                      : "text-muted opacity-0 hover:!opacity-100 group-hover/section:opacity-50"
                  }`}
                >
                  <Pin size={11} strokeWidth={1.75} fill={isPinned ? "currentColor" : "none"} />
                  {isPinned ? "pinned" : "pin"}
                </button>
              </div>
            )}
            {body}
          </section>
        );
      })}
    </div>
  );
}
