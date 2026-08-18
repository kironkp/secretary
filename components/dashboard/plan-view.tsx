"use client";

// LayoutPlan renderer (SPEC §1 fast loop, Phase 1): executes a validated plan
// against the fixed registry. Every section is hand-built furniture — the plan
// only chooses, orders, and parameterizes it. Why-chips surface the planner's
// stated reason on adapted sections; pins + one-tap revert are the user's veto.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pin, Sparkles, Undo2 } from "lucide-react";
import type { LayoutPlan, PlanSection } from "@/lib/layout/plan";
import { sectionKey } from "@/lib/layout/plan";
import type { DocRow, EventRow, TaskRow } from "./shared";
import { BoardView } from "./task-views";
import { Pill } from "./zones";
import {
  ComingUpStrip,
  DocumentsZone,
  FiveWeekTimeline,
  NextUpHero,
  OpenLoopsTable,
  ProcrastinationZone,
  ProjectGrid,
  StatTiles,
  SuggestedZone,
} from "./zones";

export type PlanProject = {
  id: string;
  name: string;
  color: string | null;
  parentId: string | null;
};

function WhyChip({ why }: { why?: string }) {
  if (!why) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-edge bg-surface px-2 py-0.5 text-[11px] text-muted">
      <Sparkles size={11} className="text-accent" aria-hidden />
      {why}
    </span>
  );
}

function DateChase({ tasks, itemIds }: { tasks: TaskRow[]; itemIds?: string[] }) {
  const undated = tasks.filter(
    (t) =>
      t.status !== "done" &&
      t.status !== "dropped" &&
      !t.dueAt &&
      (itemIds ? itemIds.includes(t.id) : true)
  );
  if (!undated.length) return null;
  return (
    <div className="rounded-2xl border border-edge bg-surface px-4 py-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Needs a date
      </p>
      <div className="flex flex-wrap gap-2">
        {undated.map((t) => (
          <span
            key={t.id}
            className="inline-flex items-center gap-2 rounded-full border border-edge bg-card px-3 py-1 text-xs"
          >
            {t.title}
            <Pill tone="warn">no date</Pill>
          </span>
        ))}
      </div>
    </div>
  );
}

function PeopleIndex({ projects, tasks }: { projects: PlanProject[]; tasks: TaskRow[] }) {
  // Until the entity store exists (SPEC §11), people are unknown — this
  // section renders nothing rather than inventing data.
  void projects;
  void tasks;
  return null;
}

function FocusBanner({ text, tone }: { text: string; tone: "info" | "serious" | "critical" }) {
  const tones = {
    info: "border-edge bg-surface text-ink",
    serious: "border-warn/40 bg-warn/10 text-ink",
    critical: "border-danger/40 bg-danger/10 text-ink",
  } as const;
  return (
    <p className={`rounded-2xl border px-4 py-2.5 text-sm font-medium ${tones[tone]}`}>{text}</p>
  );
}

function ProjectCardSection({
  section,
  projects,
  tasks,
  events,
  crossing,
  onDone,
  fresh,
}: {
  section: PlanSection;
  projects: PlanProject[];
  tasks: TaskRow[];
  events: EventRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
  fresh?: Set<string>;
}) {
  const projectId = String(section.props?.project_id ?? "");
  const variant = String(section.props?.variant ?? "full");
  const accent = section.props?.accent === true;
  const inlineLoops = section.props?.inline_loops === true;
  const project = projects.find((p) => p.id === projectId);
  const childIds = projects.filter((p) => p.parentId === projectId).map((p) => p.id);
  const mine = useMemo(
    () => tasks.filter((t) => t.projectId === projectId || childIds.includes(t.projectId ?? "")),
    [tasks, projectId, childIds]
  );
  const myEvents = useMemo(
    () => events.filter((e) => e.projectId === projectId),
    [events, projectId]
  );
  if (!project) return null;

  const open = mine.filter((t) => !["done", "dropped"].includes(t.status));

  if (variant === "compact") {
    return (
      <div className="flex items-center justify-between rounded-2xl border border-edge bg-surface px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {project.color && (
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: project.color }} />
          )}
          {project.name}
        </span>
        <span className="text-xs text-muted">{open.length} open</span>
      </div>
    );
  }

  const card = (
    <div
      className={
        accent
          ? "rounded-2xl ring-2 ring-accent/60 shadow-[0_0_0_4px_var(--color-accent-soft,transparent)]"
          : undefined
      }
    >
      <ProjectGrid tasks={mine} events={myEvents} crossing={crossing} onDone={onDone} />
      {variant === "nested" && childIds.length > 0 && (
        <div className="mt-2 grid gap-2 pl-4">
          {projects
            .filter((p) => p.parentId === projectId)
            .map((sub) => {
              const subOpen = tasks.filter(
                (t) => t.projectId === sub.id && !["done", "dropped"].includes(t.status)
              ).length;
              const subDone = tasks.filter(
                (t) => t.projectId === sub.id && t.status === "done"
              ).length;
              const pct = subOpen + subDone === 0 ? 0 : Math.round((subDone / (subOpen + subDone)) * 100);
              return (
                <div
                  key={sub.id}
                  className="flex items-center justify-between rounded-xl border border-edge bg-surface px-3 py-2 text-xs"
                >
                  <span className="font-semibold">{sub.name}</span>
                  <span className="text-muted">
                    {subOpen} open · {pct}% done
                  </span>
                </div>
              );
            })}
        </div>
      )}
      {inlineLoops && open.length > 0 && (
        <div className="mt-2">
          <OpenLoopsTable
            tasks={mine}
            events={myEvents}
            crossing={crossing}
            onDone={onDone}
            fresh={fresh}
          />
        </div>
      )}
    </div>
  );
  return card;
}

export function PlanView({
  plan,
  version,
  pinned: initialPinned,
  updatedAt,
  projects,
  tasks,
  suggestions,
  events,
  docs,
  crossing,
  onDone,
  fresh,
}: {
  plan: LayoutPlan;
  version: number;
  pinned: string[];
  updatedAt: string | null;
  projects: PlanProject[];
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

  const togglePin = async (key: string) => {
    const next = !pinned.has(key);
    setPinned((p) => {
      const s = new Set(p);
      if (next) s.add(key);
      else s.delete(key);
      return s;
    });
    await fetch("/api/layout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pin", component: key, pinned: next }),
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

  const render = (section: PlanSection) => {
    switch (section.component) {
      case "focus_banner":
        return (
          <FocusBanner
            text={String(section.props?.text ?? "")}
            tone={(section.props?.tone as "info" | "serious" | "critical") ?? "info"}
          />
        );
      case "hero_next_up":
        return <NextUpHero tasks={tasks} events={events} />;
      case "stat_row":
        return <StatTiles tasks={tasks} events={events} />;
      case "project_card":
        return (
          <ProjectCardSection
            section={section}
            projects={projects}
            tasks={tasks}
            events={events}
            crossing={crossing}
            onDone={onDone}
            fresh={fresh}
          />
        );
      case "timeline": {
        const expanded = section.props?.expanded === true;
        return (
          <div className={expanded ? "" : "max-h-96 overflow-hidden"}>
            <FiveWeekTimeline tasks={tasks} events={events} />
          </div>
        );
      }
      case "open_loops":
        return (
          <OpenLoopsTable
            tasks={tasks}
            events={events}
            crossing={crossing}
            onDone={onDone}
            fresh={fresh}
          />
        );
      case "date_chase":
        return (
          <DateChase
            tasks={tasks}
            itemIds={Array.isArray(section.props?.item_ids) ? (section.props.item_ids as string[]) : undefined}
          />
        );
      case "people_index":
        return <PeopleIndex projects={projects} tasks={tasks} />;
      case "documents":
        return <DocumentsZone docs={docs} fresh={fresh} />;
      case "coming_up":
        return <ComingUpStrip tasks={tasks} events={events} />;
      case "kanban":
        return <BoardView tasks={tasks} crossing={crossing} onDone={onDone} fresh={fresh} />;
      case "procrastination_zone":
        return <ProcrastinationZone tasks={tasks} />;
      case "suggested_zone":
        return <SuggestedZone suggestions={suggestions} />;
    }
  };

  const adapted = plan.plan_id !== "default";

  return (
    <div className="space-y-4">
      {adapted && (
        <div className="flex items-center justify-between text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <Sparkles size={12} className="text-accent" aria-hidden />
            {plan.reason_summary ?? "Arranged for you"}
            {updatedAt && <span>· v{version}</span>}
          </span>
          <button
            onClick={revert}
            disabled={reverting}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold text-muted transition-colors hover:text-ink"
          >
            <Undo2 size={12} aria-hidden /> Put it back
          </button>
        </div>
      )}
      {plan.sections.map((section, i) => {
        const key = sectionKey(section);
        const content = render(section);
        if (content === null) return null;
        return (
          <section key={`${key}-${i}`} className="group relative">
            {section.why && (
              <div className="mb-1.5">
                <WhyChip why={section.why} />
              </div>
            )}
            <button
              onClick={() => togglePin(key)}
              title={pinned.has(key) ? "Unpin — let the planner move this" : "Pin this section here"}
              className={`absolute -left-6 top-1 hidden group-hover:block ${
                pinned.has(key) ? "text-accent" : "text-muted hover:text-ink"
              }`}
            >
              <Pin size={13} aria-hidden />
            </button>
            {content}
          </section>
        );
      })}
    </div>
  );
}
