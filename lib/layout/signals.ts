// Signals (SPEC §4): the planner's entire view of the user's situation,
// computed from existing data. Pure consumers (planFromRules, validator) take
// this object; only computeSignals touches the database.
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { events, layoutSpecs, messages, projects, tasks, user } from "@/lib/db/schema";

const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;

/** SPEC §4: SIGNALS.tasks cap — enough for any painted list, bounded prompt. */
const TASKS_SIGNAL_CAP = 50;

export type ProjectSignal = {
  id: string;
  name: string;
  kind: string;
  parent_id: string | null;
  deadline: string | null;
  deadline_type: "committed" | "inferred" | "none";
  days_left: number | null;
  open_count: number;
  done_count: number;
  subprojects: { id: string; name: string; open_count: number; done_count: number }[];
  people: string[];
};

/** SPEC §4: the id vocabulary for painted surfaces — every task id the Canvas
 *  may act on (data-check, §7.6) must appear here. Open tasks only. */
export type TaskSignal = {
  id: string;
  title: string;
  project_id: string | null;
  status: string;
  due_at: string | null;
};

export type Signals = {
  projects: ProjectSignal[];
  tasks: TaskSignal[];
  engagement: Record<
    string,
    { mentions_24h: number; baseline_mentions: number; last_touched: string }
  >;
  conversation: {
    today_topics: string[];
    schedule_word_share: number;
    questions_today: string[];
  };
  pending: { items_missing_dates: string[]; unanswered_asks: string[] };
  calendar: {
    next_hard_commitment: string | null;
    days_to_it: number | null;
    density_14d: number;
  };
  context: {
    date: string;
    weekday: string;
    time_of_day: "morning" | "afternoon" | "evening";
    days_since_layout_change: number;
    pinned_sections: string[];
    calm_mode: boolean;
  };
};

const SCHEDULE_WORDS =
  /\b(when|by|before|deadline|schedule|calendar|date|due|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

export function isScheduleShaped(text: string): boolean {
  return SCHEDULE_WORDS.test(text);
}

/** SPEC §4: strong engagement = >= 3× baseline AND >= 5 absolute. */
export function isStrongEngagement(e: { mentions_24h: number; baseline_mentions: number }) {
  return e.mentions_24h >= 3 * e.baseline_mentions && e.mentions_24h >= 5;
}

/** SPEC §4: strong schedule-talk = share >= 0.3 OR >= 3 schedule questions today. */
export function isStrongScheduleTalk(c: Signals["conversation"]) {
  return c.schedule_word_share >= 0.3 || c.questions_today.length >= 3;
}

const dayDiff = (later: Date, earlier: Date) =>
  Math.floor((later.getTime() - earlier.getTime()) / 86400000);

export async function computeSignals(userId: string, now = new Date()): Promise<Signals> {
  const ago24h = new Date(now.getTime() - 86400000);
  const ago14d = new Date(now.getTime() - 14 * 86400000);
  const in14d = new Date(now.getTime() + 14 * 86400000);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const [projectRows, taskRows, eventRows, userMessages24h, dailyCounts, [userRow], headRows] =
    await Promise.all([
      db.select().from(projects).where(eq(projects.userId, userId)).orderBy(projects.createdAt),
      db
        .select({
          id: tasks.id,
          projectId: tasks.projectId,
          title: tasks.title,
          status: tasks.status,
          dueAt: tasks.dueAt,
          source: tasks.source,
        })
        .from(tasks)
        .where(eq(tasks.userId, userId)),
      db
        .select({ id: events.id, projectId: events.projectId, startsAt: events.startsAt })
        .from(events)
        .where(and(eq(events.userId, userId), gte(events.startsAt, now))),
      db
        .select({ content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(
          and(eq(messages.userId, userId), eq(messages.role, "user"), gte(messages.createdAt, ago24h))
        ),
      // Daily user-message counts for the trailing 14 days (baseline denominator).
      db
        .select({
          day: sql<string>`date_trunc('day', ${messages.createdAt})::date::text`,
          content: messages.content,
        })
        .from(messages)
        .where(
          and(
            eq(messages.userId, userId),
            eq(messages.role, "user"),
            gte(messages.createdAt, ago14d),
            lt(messages.createdAt, ago24h)
          )
        ),
      db.select({ calmMode: user.calmMode }).from(user).where(eq(user.id, userId)),
      db
        .select({
          spec: layoutSpecs.spec,
          pinned: layoutSpecs.pinned,
          kind: layoutSpecs.kind,
          createdAt: layoutSpecs.createdAt,
        })
        .from(layoutSpecs)
        .where(and(eq(layoutSpecs.userId, userId), eq(layoutSpecs.kind, "plan")))
        .orderBy(desc(layoutSpecs.version))
        .limit(10),
    ]);

  const active = projectRows.filter((p) => p.status === "active");
  const openByProject = new Map<string, number>();
  const doneByProject = new Map<string, number>();
  const missingDates: string[] = [];
  for (const t of taskRows) {
    const open = (OPEN_STATUSES as readonly string[]).includes(t.status);
    if (t.projectId) {
      const m = open ? openByProject : t.status === "done" ? doneByProject : null;
      if (m) m.set(t.projectId, (m.get(t.projectId) ?? 0) + 1);
    }
    if (open && !t.dueAt && t.source !== "suggested") missingDates.push(t.id);
  }

  // Earliest dated open work per project → inferred deadline when no committed one.
  const inferredDeadline = new Map<string, Date>();
  const consider = (projectId: string | null, d: Date | null) => {
    if (!projectId || !d || d < now) return;
    const cur = inferredDeadline.get(projectId);
    if (!cur || d < cur) inferredDeadline.set(projectId, d);
  };
  for (const t of taskRows)
    if ((OPEN_STATUSES as readonly string[]).includes(t.status)) consider(t.projectId, t.dueAt);
  for (const e of eventRows) consider(e.projectId, e.startsAt);

  // Engagement: mentions = user messages whose text names the project.
  // (Interim heuristic until extraction writes message→project links; see
  // INTEGRATION "Signals gaps".) Baseline = trailing 14-day daily median, min 1.
  const engagement: Signals["engagement"] = {};
  for (const p of active) {
    const needle = p.name.toLowerCase();
    const mentions24h = userMessages24h.filter((m) =>
      m.content.toLowerCase().includes(needle)
    ).length;
    const perDay = new Map<string, number>();
    for (const row of dailyCounts) {
      if (row.content.toLowerCase().includes(needle))
        perDay.set(row.day, (perDay.get(row.day) ?? 0) + 1);
    }
    const counts = [...perDay.values()].sort((a, b) => a - b);
    const median = counts.length ? counts[Math.floor(counts.length / 2)] : 0;
    const lastMention = userMessages24h.filter((m) => m.content.toLowerCase().includes(needle)).at(-1);
    engagement[p.id] = {
      mentions_24h: mentions24h,
      baseline_mentions: Math.max(1, median),
      last_touched: (lastMention?.createdAt ?? now).toISOString(),
    };
  }

  const todayMessages = userMessages24h.filter((m) => m.createdAt >= startOfDay);
  const scheduleShare = todayMessages.length
    ? todayMessages.filter((m) => isScheduleShaped(m.content)).length / todayMessages.length
    : 0;
  const questionsToday = todayMessages
    .filter((m) => m.content.includes("?") && isScheduleShaped(m.content))
    .map((m) => m.content.slice(0, 200));
  const todayTopics = active
    .filter((p) => todayMessages.some((m) => m.content.toLowerCase().includes(p.name.toLowerCase())))
    .map((p) => p.name);

  const nextEvent = eventRows.toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
  const density14d = eventRows.filter((e) => e.startsAt < in14d).length / 14;

  // days_since_layout_change: days since the newest stored plan whose section
  // ORDER differs from its predecessor's (emphasis-only changes don't count).
  let daysSinceChange = Number.MAX_SAFE_INTEGER;
  const orders = headRows.map((r) => {
    const sections = (r.spec as { sections?: { component: string; props?: Record<string, unknown> }[] })
      ?.sections ?? [];
    return sections
      .map((s) => {
        const pid = s.props?.project_id;
        return typeof pid === "string" ? `${s.component}:${pid}` : s.component;
      })
      .join("|");
  });
  for (let i = 0; i < headRows.length - 1; i++) {
    if (orders[i] !== orders[i + 1]) {
      daysSinceChange = dayDiff(now, headRows[i].createdAt);
      break;
    }
  }

  const hour = now.getHours();
  return {
    projects: active
      .filter((p) => !p.parentId)
      .map((p) => {
        const committed = p.deadlineKind === "committed" && p.deadline ? p.deadline : null;
        const inferred = inferredDeadline.get(p.id) ?? null;
        const deadline = committed ?? inferred;
        const subs = projectRows.filter((s) => s.parentId === p.id && s.status === "active");
        return {
          id: p.id,
          name: p.name,
          kind: "project",
          parent_id: null,
          deadline: deadline?.toISOString().slice(0, 10) ?? null,
          deadline_type: committed ? ("committed" as const) : inferred ? ("inferred" as const) : ("none" as const),
          days_left: deadline ? dayDiff(deadline, now) : null,
          open_count: openByProject.get(p.id) ?? 0,
          done_count: doneByProject.get(p.id) ?? 0,
          subprojects: subs.map((s) => ({
            id: s.id,
            name: s.name,
            open_count: openByProject.get(s.id) ?? 0,
            done_count: doneByProject.get(s.id) ?? 0,
          })),
          people: [], // until the entity store exists (SPEC §11) — see INTEGRATION
        };
      }),
    tasks: taskRows
      .filter((t) => (OPEN_STATUSES as readonly string[]).includes(t.status))
      .toSorted(
        (a, b) =>
          (a.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
          (b.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
      )
      .slice(0, TASKS_SIGNAL_CAP)
      .map((t) => ({
        id: t.id,
        title: t.title,
        project_id: t.projectId,
        status: t.status,
        due_at: t.dueAt?.toISOString() ?? null,
      })),
    engagement,
    conversation: {
      today_topics: todayTopics,
      schedule_word_share: Number(scheduleShare.toFixed(2)),
      questions_today: questionsToday,
    },
    pending: { items_missing_dates: missingDates, unanswered_asks: [] },
    calendar: {
      next_hard_commitment: nextEvent?.id ?? null,
      days_to_it: nextEvent ? dayDiff(nextEvent.startsAt, now) : null,
      density_14d: Number(density14d.toFixed(2)),
    },
    context: {
      date: now.toISOString().slice(0, 10),
      weekday: now.toLocaleDateString("en-US", { weekday: "long" }),
      time_of_day: hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening",
      days_since_layout_change: Math.min(daysSinceChange, 3650),
      pinned_sections: headRows[0]?.pinned ?? [],
      calm_mode: userRow?.calmMode ?? false,
    },
  };
}

/** Cache/decision-log key (SPEC §6): signals minus timestamps + registry version. */
export function signalsHash(signals: Signals, registryVersion: number): string {
  const stable = JSON.stringify({
    v: registryVersion,
    p: signals.projects.map((p) => [p.id, p.deadline, p.days_left, p.open_count, p.done_count, p.subprojects.length]),
    e: Object.entries(signals.engagement).map(([id, e]) => [id, e.mentions_24h, e.baseline_mentions]),
    c: [signals.conversation.schedule_word_share, signals.conversation.questions_today.length],
    x: [signals.context.days_since_layout_change, signals.context.pinned_sections, signals.context.calm_mode],
    d: [signals.pending.items_missing_dates.length, signals.calendar.next_hard_commitment],
  });
  let h = 0;
  for (let i = 0; i < stable.length; i++) h = (Math.imul(h, 31) + stable.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
