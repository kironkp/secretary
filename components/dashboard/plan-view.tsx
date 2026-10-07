"use client";

// LayoutPlan renderer (SPEC §1 fast loop, Phase 1): executes a validated plan
// against the fixed registry. Every section is hand-built furniture — the plan
// only chooses, orders, and parameterizes it. Why-chips surface the planner's
// stated reason on adapted sections; pins + one-tap revert are the user's veto.
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Pin, Sparkles, Undo2 } from "lucide-react";
import type { LayoutPlan, PlanSection } from "@/lib/layout/plan";
import { sectionKey } from "@/lib/layout/plan";
import { openDetail, type DocRow, type EventRow, type TaskRow } from "./shared";
import { ProjectProgressStrip, pickTimelineProject } from "./timeline-board";
import { buildLanes, datePresets, DEFAULT_FILTERS, pickedDay } from "@/lib/timeline";
import { dueLabel } from "@/lib/due";
import { BoardView } from "./task-views";
import { Pill } from "./zones";
import {
  ComingUpStrip,
  DocumentsZone,
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
  /** "list": a list like Shopping, shown as one checklist card (SEC-A003). */
  kind?: "project" | "list";
  /** The timeline's deadline flag (SEC-A009): ISO, and whether it is committed. */
  deadline?: string | null;
  deadlineKind?: string | null;
  status?: string;
};

/** A list (Shopping) on the board: its open items, each tickable, with what it is for. */
function ListCard({
  project,
  items,
  crossing,
  onDone,
}: {
  project: PlanProject;
  items: TaskRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
}) {
  const open = items.filter((t) => !["done", "dropped"].includes(t.status));
  return (
    <div className="rounded-2xl border border-edge bg-surface px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold">{project.name} list</span>
        <span className="text-xs text-muted">{open.length ? `${open.length} to get` : "empty"}</span>
      </div>
      {open.length > 0 && (
        <ul className="grid gap-1">
          {open.map((t) => (
            <li key={t.id}>
              {/* The whole row ticks the item: a 44 px tall target, the 20 px box its look. */}
              <button
                type="button"
                aria-label={`Got ${t.title}`}
                onClick={() => onDone(t.id)}
                className="flex min-h-11 w-full items-center gap-2 text-left text-sm"
              >
                <span className="h-5 w-5 flex-none rounded-md border border-edge" aria-hidden />
                <span className={crossing.has(t.id) ? "text-faint line-through" : undefined}>{t.title}</span>
                {t.notes && <span className="text-xs text-faint">{t.notes}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WhyChip({ why }: { why?: string }) {
  if (!why) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-edge bg-surface px-2 py-0.5 text-[11px] text-muted">
      <Sparkles size={11} className="text-accent" aria-hidden />
      {why}
    </span>
  );
}

/**
 * Needs a date (SEC-A007, D5): a tap on a task opens Today / Tomorrow / Next
 * week / Pick… right there, and the choice saves at once, with no dialog.
 * It saves through the same move route as a Timeline drag (update_task in a
 * live turn: the tool layer's rules, never a raw write), and Undo restores.
 */
function DateChase({ tasks, itemIds, timezone }: { tasks: TaskRow[]; itemIds?: string[]; timezone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ title: string; label: string; undo: string | null } | null>(null);
  const undated = tasks.filter(
    (t) =>
      t.status !== "done" &&
      t.status !== "dropped" &&
      !t.dueAt &&
      (itemIds ? itemIds.includes(t.id) : true)
  );
  if (!undated.length && !saved) return null;

  const setDate = async (t: TaskRow, due: string) => {
    setSaving(true);
    setError(null);
    const res = await fetch("/api/timeline/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "task", id: t.id, due_at: due }),
    }).catch(() => null);
    const json = ((await res?.json().catch(() => ({}))) ?? {}) as { result?: { error?: string }; undo?: string };
    setSaving(false);
    if (!res?.ok) {
      setError(json.result?.error ?? "That date didn't save.");
      return;
    }
    setOpen(null);
    setSaved({ title: t.title, label: dueLabel(due, timezone), undo: json.undo ?? null });
    router.refresh();
  };
  const undo = async (token: string) => {
    setSaved(null);
    const res = await fetch("/api/timeline/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }).catch(() => null);
    if (!res?.ok) setError("Undo didn't save.");
    router.refresh();
  };
  const choice =
    "inline-flex min-h-11 items-center rounded-full border border-edge bg-card px-3.5 text-xs font-semibold hover:border-faint disabled:opacity-50";

  return (
    <div data-testid="date-chase" className="rounded-2xl border border-edge bg-surface px-4 py-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Needs a date</p>
      {saved && (
        <p role="status" className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <span>
            &ldquo;{saved.title}&rdquo; is due {saved.label}.
          </span>
          {saved.undo && (
            <button type="button" onClick={() => undo(saved.undo!)} className="min-h-11 px-1 text-xs font-bold text-accent">
              Undo
            </button>
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {undated.map((t) => (
          <div key={t.id} className={open === t.id ? "w-full" : undefined}>
            <button
              type="button"
              data-chase={t.id}
              aria-expanded={open === t.id}
              onClick={() => setOpen(open === t.id ? null : t.id)}
              className="inline-flex min-h-11 items-center gap-2 rounded-full border border-edge bg-card px-3 text-left text-xs hover:border-faint"
            >
              {t.title}
              <Pill tone="warn">no date</Pill>
            </button>
            {open === t.id && (
              <div role="group" aria-label={`A date for ${t.title}`} className="mt-2 flex flex-wrap items-center gap-2">
                {(
                  [
                    ["Today", "today"],
                    ["Tomorrow", "tomorrow"],
                    ["Next week", "nextWeek"],
                  ] as const
                ).map(([label, key]) => (
                  <button
                    key={key}
                    type="button"
                    disabled={saving}
                    // Worked out at the tap, not at render: the day it is now, in his zone.
                    onClick={() => setDate(t, datePresets(timezone, new Date())[key])}
                    className={choice}
                  >
                    {label}
                  </button>
                ))}
                <input
                  type="date"
                  aria-label="Pick a date"
                  disabled={saving}
                  onChange={(e) => {
                    const due = pickedDay(e.target.value, timezone);
                    if (due) void setDate(t, due);
                  }}
                  className={`${choice} font-normal`}
                />
                <button type="button" onClick={() => openDetail("task", t.id)} className="min-h-11 px-2 text-xs text-muted hover:text-ink">
                  Details
                </button>
              </div>
            )}
          </div>
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
      <ProjectGrid tasks={mine} events={myEvents} crossing={crossing} onDone={onDone} single />
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
  listTasks = [],
  suggestions,
  events,
  docs,
  crossing,
  onDone,
  fresh,
  dynamicHtml = {},
  timezone,
}: {
  plan: LayoutPlan;
  version: number;
  pinned: string[];
  updatedAt: string | null;
  projects: PlanProject[];
  tasks: TaskRow[];
  /** The items of the user's lists, shown only on their list cards. */
  listTasks?: TaskRow[];
  suggestions: TaskRow[];
  events: EventRow[];
  docs: DocRow[];
  crossing: Set<string>;
  onDone: (id: string) => void;
  fresh?: Set<string>;
  /** Approved dynamic components, pre-interpolated + sanitized on the server. */
  dynamicHtml?: Record<string, string>;
  /** The user's zone: the strip's and Needs a date's calendar days (lib/due.ts). */
  timezone: string;
}) {
  const router = useRouter();
  // The progress strip's lanes (lib/timeline.ts), lists left out like everywhere.
  const lanes = useMemo(() => {
    const work = projects.filter((p) => p.kind !== "list" && (p.status ?? "active") === "active");
    const ids = new Set(work.map((p) => p.id));
    return buildLanes(
      work.map((p) => ({ id: p.id, name: p.name, color: p.color, deadline: p.deadline ?? null, deadlineKind: p.deadlineKind ?? null })),
      tasks
        .filter((t) => t.projectId === null || ids.has(t.projectId))
        .map((t) => ({ id: t.id, title: t.title, status: t.status, dueAt: t.dueAt, startAt: t.startAt, projectId: t.projectId, reminders: t.reminders })),
      [],
      timezone,
      new Date(),
      { ...DEFAULT_FILTERS, events: false }
    );
  }, [projects, tasks, timezone]);
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
      case "project_card": {
        const list = projects.find((p) => p.id === section.props?.project_id && p.kind === "list");
        if (list) {
          return (
            <ListCard
              project={list}
              items={listTasks.filter((t) => t.projectId === list.id)}
              crossing={crossing}
              onDone={onDone}
            />
          );
        }
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
      }
      case "timeline":
        // Registry v3 (SEC-A007): the projects progress strip, where the
        // 5-week chart was. A tap opens the Timeline on that project.
        return (
          <ProjectProgressStrip
            lanes={lanes}
            active="all"
            compact={section.props?.expanded !== true}
            timezone={timezone}
            onPick={(id) => {
              pickTimelineProject(id);
              router.push("/dashboard?view=timeline");
            }}
          />
        );
      case "date_chase":
        return (
          <DateChase
            tasks={tasks}
            timezone={timezone}
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
      default: {
        // Approved dynamic component (SPEC v1.3): server-sanitized inert HTML —
        // interpolated from signals, no scripts/loads possible by construction.
        const html = dynamicHtml[section.component];
        if (!html) return null;
        return (
          <div
            className="rounded-2xl border border-edge bg-surface p-4"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }
    }
  };

  const adapted = plan.plan_id !== "default";

  return (
    <div className="space-y-4">
      {adapted && (
        <div className="flex items-center justify-between text-xs text-muted">
          <span className="inline-flex items-center gap-1.5">
            <Sparkles size={12} className="text-accent" aria-hidden />
            {/* A board the user arranged says so (SEC-A003b), not "for you". */}
            {/^(user|chat)-/.test(plan.plan_id) ? "Arranged by you" : (plan.reason_summary ?? "Arranged for you")}
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
      {groupCards(plan.sections, projects).map((group) =>
        group.kind === "cards" ? (
          // Consecutive project cards share one grid (SEC-A007): two across on
          // an iPad, three on a desktop. The shell owns the geometry; an
          // accented card or one with its open items inline takes a whole row.
          <div key={`cards-${group.at}`} data-testid="project-grid" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {group.sections.map(({ section, i }) => {
              const wide = section.props?.accent === true || section.props?.inline_loops === true;
              return (
                <div key={`${sectionKey(section)}-${i}`} className={wide ? "md:col-span-2 xl:col-span-3" : undefined}>
                  {sectionFor(section, i)}
                </div>
              );
            })}
          </div>
        ) : (
          <Fragment key={`${sectionKey(group.section)}-${group.i}`}>{sectionFor(group.section, group.i)}</Fragment>
        )
      )}
    </div>
  );

  function sectionFor(section: PlanSection, i: number): ReactNode {
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
  }
}

type Group =
  | { kind: "cards"; at: number; sections: { section: PlanSection; i: number }[] }
  | { kind: "one"; section: PlanSection; i: number };

/** Runs of project cards (not lists) become one grid; everything else stands alone. */
function groupCards(sections: PlanSection[], projects: PlanProject[]): Group[] {
  const lists = new Set(projects.filter((p) => p.kind === "list").map((p) => p.id));
  const groups: Group[] = [];
  sections.forEach((section, i) => {
    const card = section.component === "project_card" && !lists.has(String(section.props?.project_id ?? ""));
    const last = groups[groups.length - 1];
    if (card && last?.kind === "cards") last.sections.push({ section, i });
    else if (card) groups.push({ kind: "cards", at: i, sections: [{ section, i }] });
    else groups.push({ kind: "one", section, i });
  });
  return groups;
}
