"use client";

// Dashboard orchestrator: Overview / Board / List / Calendar / Timeline, one
// shared cross-off handler. Server props stay authoritative (router.refresh()
// re-sends them); optimistic done-marks are overlaid, never copied — so live
// updates from the secretary flow straight through, with an entrance
// animation on tasks that appear mid-session.
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { LayoutSpec } from "@/lib/layout/spec";
import { RefreshOnFocus } from "@/components/shell/refresh-on-focus";
import type { EventRow, TaskRow } from "./shared";
import { AdaptiveView } from "./adaptive-view";
import { CalendarView } from "./calendar-view";
import { TimelineView } from "./timeline-view";
import { BoardView, ListTable } from "./task-views";
import { OverdueCallout, SuggestedZone } from "./zones";

export type { EventRow, TaskRow } from "./shared";

const VIEWS = [
  { key: "adaptive", label: "Overview" },
  { key: "board", label: "Board" },
  { key: "list", label: "List" },
  { key: "calendar", label: "Calendar" },
  { key: "timeline", label: "Timeline" },
] as const;
type View = (typeof VIEWS)[number]["key"];

export function DashboardViews({
  tasks: serverTasks,
  suggestions,
  events,
  layout,
  layoutVersion,
  layoutPinned,
  layoutUpdatedAt,
  compact = false,
}: {
  tasks: TaskRow[];
  suggestions: TaskRow[];
  events: EventRow[];
  layout: LayoutSpec;
  layoutVersion: number;
  layoutPinned: string[];
  layoutUpdatedAt: string | null;
  compact?: boolean;
}) {
  const router = useRouter();
  const [view, setView] = useState<View>("adaptive");
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [crossing, setCrossing] = useState<Set<string>>(new Set());

  // Optimistic done-marks overlaid on the authoritative server rows.
  const tasks = useMemo(
    () =>
      serverTasks.map((t) =>
        doneIds.has(t.id) && t.status !== "done" ? { ...t, status: "done" as const } : t
      ),
    [serverTasks, doneIds]
  );

  // Entrance animation: ids (tasks AND events) that appeared after this
  // component mounted — i.e. the secretary logged them live. `seen` absorbs
  // them shortly after so the class drops once the animation has played.
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const fresh = useMemo(() => {
    if (!seen) return new Set<string>();
    return new Set(
      [...serverTasks, ...events].filter((x) => !seen.has(x.id)).map((x) => x.id)
    );
  }, [serverTasks, events, seen]);
  useEffect(() => {
    const ids = [...serverTasks.map((x) => x.id), ...events.map((x) => x.id)];
    const t = setTimeout(
      () => setSeen((prev) => new Set([...(prev ?? []), ...ids])),
      seen === null ? 0 : 1500
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverTasks, events]);

  const markDone = async (id: string) => {
    setCrossing((s) => new Set(s).add(id));
    // let the cross-off animation play before the row visually settles
    setTimeout(() => {
      setDoneIds((s) => new Set(s).add(id));
    }, 500);
    const res = await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    if (!res.ok) {
      setDoneIds((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
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
    <div className={`space-y-4 ${compact ? "py-5" : "py-6"}`}>
      <RefreshOnFocus />
      <div className="flex items-center gap-2">
        {!compact && <h1 className="text-lg font-bold">Dashboard</h1>}
        <div className="ml-auto flex overflow-x-auto rounded-lg border border-edge bg-surface p-0.5 text-xs">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`rounded-md px-3 py-1.5 font-semibold transition-colors ${
                view === v.key ? "bg-card text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {v.label}
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
          fresh={fresh}
        />
      ) : (
        <>
          <OverdueCallout tasks={tasks} />
          <SuggestedZone suggestions={suggestions} />
          {view === "list" && (
            <ListTable tasks={tasks} crossing={crossing} onDone={markDone} fresh={fresh} />
          )}
          {view === "board" && (
            <BoardView tasks={tasks} crossing={crossing} onDone={markDone} fresh={fresh} />
          )}
          {view === "calendar" && <CalendarView tasks={tasks} events={events} />}
          {view === "timeline" && (
            <TimelineView tasks={tasks} events={events} crossing={crossing} onDone={markDone} />
          )}
        </>
      )}
    </div>
  );
}
