"use client";

// Dashboard orchestrator: Adaptive / Board / List / Calendar / Timeline (D-3),
// with the suggested zone on classic views and one shared cross-off handler.
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { LayoutSpec } from "@/lib/layout/spec";
import type { EventRow, TaskRow } from "./shared";
import { AdaptiveView } from "./adaptive-view";
import { CalendarView } from "./calendar-view";
import { TimelineView } from "./timeline-view";
import { BoardView, ListTable } from "./task-views";
import { OverdueCallout, SuggestedZone } from "./zones";

export type { EventRow, TaskRow } from "./shared";

const VIEWS = ["adaptive", "board", "list", "calendar", "timeline"] as const;
type View = (typeof VIEWS)[number];

export function DashboardViews({
  tasks: initial,
  suggestions,
  events,
  layout,
  layoutVersion,
  layoutPinned,
  layoutUpdatedAt,
}: {
  tasks: TaskRow[];
  suggestions: TaskRow[];
  events: EventRow[];
  layout: LayoutSpec;
  layoutVersion: number;
  layoutPinned: string[];
  layoutUpdatedAt: string | null;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>("adaptive");
  const [tasks, setTasks] = useState(initial);
  const [crossing, setCrossing] = useState<Set<string>>(new Set());

  const markDone = async (id: string) => {
    setCrossing((s) => new Set(s).add(id));
    // let the cross-off animation play before the row visually settles
    setTimeout(() => {
      setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, status: "done" as const } : t)));
    }, 500);
    const res = await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    if (!res.ok) {
      setTasks(initial);
      setCrossing((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      return;
    }
    router.refresh();
  };

  return (
    <div className="space-y-4 py-6">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-bold">Dashboard</h1>
        <div className="ml-auto flex overflow-x-auto rounded-lg border border-edge bg-surface p-0.5 text-xs">
          {VIEWS.map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-md px-3 py-1.5 font-semibold capitalize transition-colors ${
                view === v ? "bg-card text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === "adaptive" ? (
        <AdaptiveView
          layout={layout}
          version={layoutVersion}
          pinned={layoutPinned}
          updatedAt={layoutUpdatedAt}
          tasks={tasks}
          suggestions={suggestions}
          events={events}
          crossing={crossing}
          onDone={markDone}
        />
      ) : (
        <>
          <OverdueCallout tasks={tasks} />
          <SuggestedZone suggestions={suggestions} />
          {view === "list" && <ListTable tasks={tasks} crossing={crossing} onDone={markDone} />}
          {view === "board" && <BoardView tasks={tasks} crossing={crossing} onDone={markDone} />}
          {view === "calendar" && <CalendarView tasks={tasks} events={events} />}
          {view === "timeline" && (
            <TimelineView tasks={tasks} events={events} crossing={crossing} onDone={markDone} />
          )}
        </>
      )}
    </div>
  );
}
