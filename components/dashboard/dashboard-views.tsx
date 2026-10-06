"use client";

// Dashboard orchestrator: Overview / Board / List / Calendar / Timeline /
// Canvas, one shared cross-off handler. Canvas is a view here since SEC-A006
// (Kiron: "make it make sense"): one tap from the Dashboard tab, the Canvas
// itself unchanged. The view is kept in the URL (?view=), so /canvas and a
// link can open one directly. Server props stay authoritative (router.refresh()
// re-sends them); optimistic done-marks are overlaid, never copied — so live
// updates from the secretary flow straight through, with an entrance
// animation on tasks that appear mid-session.
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CanvasView } from "@/components/canvas/canvas-view";
import type { LayoutSpec } from "@/lib/layout/spec";
import type { LayoutPlan } from "@/lib/layout/plan";
import { PlanView, type PlanProject } from "./plan-view";
import { RefreshOnFocus } from "@/components/shell/refresh-on-focus";
import { isMomentumTap } from "./shared";
import type { DocRow, EventRow, TaskRow } from "./shared";
import { AdaptiveView } from "./adaptive-view";
import { CalendarView } from "./calendar-view";
import { TimelineView } from "./timeline-view";
import { BoardView, ListTable } from "./task-views";
import { PastDueChip, SuggestedZone } from "./zones";

export type { EventRow, TaskRow } from "./shared";

const VIEWS = [
  { key: "adaptive", label: "Overview" },
  { key: "board", label: "Board" },
  { key: "list", label: "List" },
  { key: "calendar", label: "Calendar" },
  { key: "timeline", label: "Timeline" },
  { key: "canvas", label: "Canvas" },
] as const;
type View = (typeof VIEWS)[number]["key"];
const isView = (v: string | null): v is View => VIEWS.some((x) => x.key === v);

export function DashboardViews({
  tasks: serverTasks,
  suggestions,
  events,
  docs,
  layout,
  layoutVersion,
  layoutPinned,
  layoutUpdatedAt,
  plan = null,
  planVersion = 0,
  planPinned = [],
  planProjects = [],
  planDynamicHtml = {},
  compact = false,
  timezone,
}: {
  tasks: TaskRow[];
  suggestions: TaskRow[];
  events: EventRow[];
  docs: DocRow[];
  layout: LayoutSpec;
  layoutVersion: number;
  layoutPinned: string[];
  layoutUpdatedAt: string | null;
  plan?: LayoutPlan | null;
  planVersion?: number;
  planPinned?: string[];
  planProjects?: PlanProject[];
  planDynamicHtml?: Record<string, string>;
  compact?: boolean;
  /** The user's IANA zone: the Calendar and Timeline lay days out in it (lib/due.ts). */
  timezone: string;
}) {
  const router = useRouter();
  const asked = useSearchParams().get("view");
  const [view, setViewState] = useState<View>(isView(asked) ? asked : "adaptive");
  const setView = (v: View) => {
    setViewState(v);
    // The page's own URL only; the chat split pane keeps the chat's.
    if (compact) return;
    const url = new URL(window.location.href);
    if (v === "adaptive") url.searchParams.delete("view");
    else url.searchParams.set("view", v);
    window.history.replaceState(null, "", url);
  };
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [crossing, setCrossing] = useState<Set<string>>(new Set());

  // Optimistic done-marks overlaid on the authoritative server rows.
  const allTasks = useMemo(
    () =>
      serverTasks.map((t) =>
        doneIds.has(t.id) && t.status !== "done" ? { ...t, status: "done" as const } : t
      ),
    [serverTasks, doneIds]
  );
  // A list's items (Shopping) live on the list's own card, not in every view
  // of the work (SEC-A003): they are not tasks to schedule, count or chase.
  const [tasks, listTasks] = useMemo(() => {
    const lists = new Set(planProjects.filter((p) => p.kind === "list").map((p) => p.id));
    return [
      allTasks.filter((t) => !lists.has(t.projectId ?? "")),
      allTasks.filter((t) => lists.has(t.projectId ?? "")),
    ];
  }, [allTasks, planProjects]);

  // Entrance animation: ids (tasks AND events) that appeared after this
  // component mounted — i.e. the secretary logged them live. `seen` absorbs
  // them shortly after so the class drops once the animation has played.
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const fresh = useMemo(() => {
    if (!seen) return new Set<string>();
    return new Set(
      [...serverTasks, ...events, ...docs].filter((x) => !seen.has(x.id)).map((x) => x.id)
    );
  }, [serverTasks, events, docs, seen]);
  useEffect(() => {
    const ids = [
      ...serverTasks.map((x) => x.id),
      ...events.map((x) => x.id),
      ...docs.map((x) => x.id),
    ];
    const t = setTimeout(
      () => setSeen((prev) => new Set([...(prev ?? []), ...ids])),
      seen === null ? 0 : 1500
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverTasks, events, docs]);

  const markDone = async (id: string) => {
    if (isMomentumTap()) return; // scroll-stop tap must never complete a task
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {!compact && <h1 className="text-lg font-bold">Dashboard</h1>}
        {/* Every view stays on screen at any width (SEC-A006): three to a
            row on a phone, one row from sm up. Each a 44 px target. */}
        <div
          role="tablist"
          aria-label="Dashboard views"
          className="grid grid-cols-3 rounded-lg border border-edge bg-surface p-0.5 text-xs sm:ml-auto sm:flex"
        >
          {VIEWS.map((v) => (
            <button
              key={v.key}
              role="tab"
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
              className={`min-h-11 rounded-md px-3 font-semibold transition-colors ${
                view === v.key ? "bg-card text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {view === "adaptive" ? (
        plan ? (
          <PlanView
            plan={plan}
            version={planVersion}
            pinned={planPinned}
            updatedAt={layoutUpdatedAt}
            projects={planProjects}
            dynamicHtml={planDynamicHtml}
            tasks={tasks}
            listTasks={listTasks}
            suggestions={suggestions}
            events={events}
            docs={docs}
            crossing={crossing}
            onDone={markDone}
            fresh={fresh}
          />
        ) : (
          <AdaptiveView
            layout={layout}
            version={layoutVersion}
            pinned={layoutPinned}
            updatedAt={layoutUpdatedAt}
            tasks={tasks}
            suggestions={suggestions}
            events={events}
            docs={docs}
            crossing={crossing}
            onDone={markDone}
            fresh={fresh}
          />
        )
      ) : view === "canvas" ? (
        <CanvasView />
      ) : (
        <>
          <PastDueChip tasks={tasks} />
          <SuggestedZone suggestions={suggestions} />
          {view === "list" && (
            <ListTable tasks={tasks} crossing={crossing} onDone={markDone} fresh={fresh} />
          )}
          {view === "board" && (
            <BoardView tasks={tasks} crossing={crossing} onDone={markDone} fresh={fresh} />
          )}
          {view === "calendar" && <CalendarView tasks={tasks} events={events} timezone={timezone} />}
          {view === "timeline" && (
            <TimelineView tasks={tasks} events={events} crossing={crossing} onDone={markDone} timezone={timezone} />
          )}
        </>
      )}
    </div>
  );
}
