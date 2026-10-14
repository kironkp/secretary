// Signals (SPEC §4): the planner's entire view of the user's situation,
// computed from existing data. Pure consumers (planFromRules, validator) take
// this object; only computeSignals touches the database.
import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { daysFromToday, isOpenWork } from "@/lib/due";
import { db } from "@/lib/db";
import { events, layoutSpecs, messages, projects, tasks, user } from "@/lib/db/schema";
import { notIntakeMail } from "@/lib/secretary/proposals";

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
  /**
   * Calendar days (the user's) to the project's earliest open dated task,
   * negative when it is late (SEC-A007). days_left skips the past, so a
   * project whose only open work is late had no urgency at all.
   */
  soonest_days?: number | null;
  /** Calendar days to the project's own stored deadline, committed or not. */
  deadline_days?: number | null;
  /**
   * His place for it in his project order (docs/projects/SPEC.md, v1.11), for
   * the composition. Not in the signals hash: a move is not a new situation.
   */
  position?: number | null;
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
    /**
     * The sections that are not cards which the system put on the board less
     * than a day ago: invariant 8 keeps them today. Not in the hash: a day
     * going by is not a new situation. Absent on a hand-built signals
     * object, where the layout clock stands in as it did before v1.02 r5.
     */
    sections_new_today?: string[];
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
  const twoDaysAgo = new Date(now.getTime() - 2 * 86400000);
  const ago14d = new Date(now.getTime() - 14 * 86400000);
  const in14d = new Date(now.getTime() + 14 * 86400000);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const [projectRows, taskRows, eventRows, userMessages24h, dailyCounts, [userRow], headRows] =
    await Promise.all([
      // The order they were made in, the id breaking a tie (rows made in one go share a stamp): the hash walks it.
      db.select().from(projects).where(eq(projects.userId, userId)).orderBy(projects.createdAt, projects.id),
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
        .where(eq(tasks.userId, userId))
        // An order of their own (v1.11): the lists made from them reach the planner's prompt and the cap of 50.
        .orderBy(tasks.createdAt, tasks.id),
      db
        .select({ id: events.id, projectId: events.projectId, startsAt: events.startsAt })
        .from(events)
        .where(and(eq(events.userId, userId), gte(events.startsAt, now)))
        // Two at one instant: the id decides which is the next commitment, which the hash carries (v1.11).
        .orderBy(events.startsAt, events.id),
      db
        .select({ content: messages.content, createdAt: messages.createdAt })
        .from(messages)
        .where(
          // The user's own words: not forwarded mail an intake thread stores as theirs (SEC-A005b).
          and(eq(messages.userId, userId), eq(messages.role, "user"), notIntakeMail(), gte(messages.createdAt, ago24h))
        )
        // In the order he said them (v1.11): the questions reach the planner's prompt, the last mention its read.
        .orderBy(messages.createdAt, messages.id),
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
            notIntakeMail(),
            gte(messages.createdAt, ago14d),
            lt(messages.createdAt, ago24h)
          )
        ),
      db.select({ calmMode: user.calmMode, timezone: user.timezone }).from(user).where(eq(user.id, userId)),
      db
        .select({
          spec: layoutSpecs.spec,
          pinned: layoutSpecs.pinned,
          kind: layoutSpecs.kind,
          createdAt: layoutSpecs.createdAt,
        })
        .from(layoutSpecs)
        // The newest ten rows, and every row of the last two days with the
        // one before the oldest of them (a row is judged against the row it
        // follows): the layout clock below is exact about "today" however
        // many rows a day wrote.
        .where(
          and(
            eq(layoutSpecs.userId, userId),
            eq(layoutSpecs.kind, "plan"),
            or(
              gte(layoutSpecs.version, sql`(select coalesce(max(version), 0) - 9 from layout_specs where user_id = ${userId} and kind = 'plan')`),
              // (No row in the last two days: nothing is added to the ten.)
              gte(
                layoutSpecs.version,
                sql`coalesce(
                  (select max(o.version) from layout_specs o where o.user_id = ${userId} and o.kind = 'plan'
                    and o.version < (select min(r.version) from layout_specs r where r.user_id = ${userId} and r.kind = 'plan' and r.created_at >= ${twoDaysAgo})),
                  (select min(r.version) from layout_specs r where r.user_id = ${userId} and r.kind = 'plan' and r.created_at >= ${twoDaysAgo}),
                  2147483647)`
              )
            )
          )
        )
        .orderBy(desc(layoutSpecs.version))
        .limit(CLOCK_ROWS),
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

  // Earliest open work per project, late included, in the user's calendar
  // days: the order every screen sorts projects by (lib/project-order.ts).
  const tz = userRow?.timezone ?? "UTC";
  const soonestDays = new Map<string, number>();
  for (const t of taskRows) {
    if (!t.projectId || !t.dueAt || !isOpenWork(t)) continue;
    const d = daysFromToday(t.dueAt, tz, now);
    const cur = soonestDays.get(t.projectId);
    if (cur === undefined || d < cur) soonestDays.set(t.projectId, d);
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

  // days_since_layout_change: days since the newest stored plan in which the
  // SYSTEM changed the layout (layoutChanged, below): the system measured
  // against the system, as the rationing is (SPEC §2, v1.02 r5).
  let daysSinceChange = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < headRows.length - 1; i++) {
    if (layoutChanged(headRows[i + 1], headRows[i])) {
      daysSinceChange = dayDiff(now, headRows[i].createdAt);
      break;
    }
  }
  // Only so many rows are read. If two days wrote more than that and none of
  // those read changed the layout, the last change is no newer than the
  // oldest of them: counted from that row, never as "never".
  if (daysSinceChange === Number.MAX_SAFE_INTEGER && headRows.length === CLOCK_ROWS) {
    daysSinceChange = dayDiff(now, headRows[headRows.length - 1].createdAt);
  }
  // What the system put on the board less than a day ago (a banner, a
  // section a planner added): on the newest row as the system's, and on
  // every row before it back to one written today that it first appears on.
  // Invariant 8 keeps these today: what he saw today does not silently go.
  const newToday: string[] = [];
  for (const component of systemsOn(headRows[0] ?? { spec: null })) {
    let first = 0;
    while (first + 1 < headRows.length && systemsOn(headRows[first + 1]).includes(component)) first++;
    const sinceBeforeTheRowsRead = first === headRows.length - 1 && headRows.length > 1;
    if (!sinceBeforeTheRowsRead && dayDiff(now, headRows[first].createdAt) < 1) newToday.push(component);
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
          kind: p.kind ?? "project",
          parent_id: null,
          deadline: deadline?.toISOString().slice(0, 10) ?? null,
          deadline_type: committed ? ("committed" as const) : inferred ? ("inferred" as const) : ("none" as const),
          days_left: deadline ? dayDiff(deadline, now) : null,
          open_count: openByProject.get(p.id) ?? 0,
          done_count: doneByProject.get(p.id) ?? 0,
          position: p.position ?? null,
          subprojects: subs.map((s) => ({
            id: s.id,
            name: s.name,
            open_count: openByProject.get(s.id) ?? 0,
            done_count: doneByProject.get(s.id) ?? 0,
          })),
          people: [], // until the entity store exists (SPEC §11) — see INTEGRATION
          soonest_days: soonestDays.get(p.id) ?? null,
          deadline_days: p.deadline ? daysFromToday(p.deadline, tz, now) : null,
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
      sections_new_today: newToday,
      pinned_sections: headRows[0]?.pinned ?? [],
      calm_mode: userRow?.calmMode ?? false,
    },
  };
}

/** How many stored rows the layout clock reads at most (the newest ten, and all of the last two days). */
const CLOCK_ROWS = 150;

/** A stored row as the layout clock reads it. */
type StoredBoard = { spec: unknown; pinned?: string[] | null };
type StoredSection = { component: string; props?: Record<string, unknown>; place?: unknown };

/** The sections of a stored board that are not cards, and which of them are his (placed) rather than the system's. */
function readBoard(board: StoredBoard) {
  const sections = ((board.spec as { sections?: StoredSection[] } | null)?.sections ?? []).filter((s) => s.component !== "project_card");
  const his = new Set([...sections.filter((s) => s.place !== undefined && s.place !== null).map((s) => s.component), ...(board.pinned ?? [])]);
  return { his, systems: sections.map((s) => s.component).filter((c) => !his.has(c)) };
}
/** The system's own sections on a stored board, the banner among them. */
const systemsOn = (board: StoredBoard): string[] => readBoard(board).systems;

/**
 * Whether the SYSTEM changed the ORDER of the layout between two stored
 * boards, the older and the newer (SPEC §2, v1.02 r5). The system is
 * measured against the system: only the sections that are the system's on
 * both boards are compared, by their order. Not the project cards, which
 * follow the data. Not the banner, which is always first when there is one.
 * Not what he placed (it carries its place, or is on the row's pins). And
 * not a section coming or going: that is not a change of order, whoever did
 * it (what the system added today is kept today by invariant 8, through
 * `sections_new_today`). Counted, the banner made a planner that writes one
 * every time it is asked a paid call a day for ever: its row reset the
 * clock, and the clock's flip a day later was a new situation.
 *
 * One function, because the store asks the same question before it writes a
 * row (hashOnceStored, lib/layout/plan-store.ts): will this row reset the
 * clock?
 */
export function layoutChanged(older: StoredBoard, newer: StoredBoard): boolean {
  // (The banner needs no taking out: it is first on any board that has it, so it cannot change the order of what both have.)
  const [a, b] = [readBoard(older), readBoard(newer)].map((r) => r.systems);
  const common = (list: string[], other: string[]) => list.filter((c) => other.includes(c)).join("|");
  return common(a, b) !== common(b, a);
}

/**
 * Cache/decision-log key (SPEC §6): signals minus timestamps + registry
 * version. Of the layout clock it carries only what the rules read, whether
 * a reorder is allowed yet (docs/spend/SPEC.md §4, v1.04): as a raw count of
 * days it made every day after a change of layout a new situation, and a
 * paid planner call.
 */
export function signalsHash(signals: Signals, registryVersion: number): string {
  const stable = JSON.stringify({
    v: registryVersion,
    p: signals.projects.map((p) => [p.id, p.deadline, p.days_left, p.open_count, p.done_count, p.subprojects.length]),
    e: Object.entries(signals.engagement).map(([id, e]) => [id, e.mentions_24h, e.baseline_mentions]),
    c: [signals.conversation.schedule_word_share, signals.conversation.questions_today.length],
    x: [signals.context.days_since_layout_change >= 1, signals.context.pinned_sections, signals.context.calm_mode],
    d: [signals.pending.items_missing_dates.length, signals.calendar.next_hard_commitment],
  });
  let h = 0;
  for (let i = 0; i < stable.length; i++) h = (Math.imul(h, 31) + stable.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
