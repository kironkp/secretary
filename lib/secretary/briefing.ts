// Session-start briefing (Flow 3): assembled server-side before every voice
// token mint and text chat, injected into system instructions. This is what
// turns "hello" into "did you send the insurance form?".
import { and, count, desc, eq, gte, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { documents, events, expectations, memories, projects, tasks, user } from "@/lib/db/schema";
import { dayRangeInTz } from "@/lib/time";
import { getRecentConversationTails } from "@/lib/db/queries";
import { getPlanHead } from "@/lib/layout/plan-store";
import { nextClarification, openClarificationCount } from "./entities";
import { isQuietHours } from "./persona";
import { refreshProcrastinationScores } from "./procrastination";
import { getPendingSuggestions } from "./suggestions";

const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;
const MAX_NUDGES = 3;
const STALLED_DAYS = 3;
// PRIOR SESSIONS block (SPEC §11 cross-session recall): verbatim excerpts,
// never summaries — capped so the briefing doesn't balloon per request.
const PRIOR_SESSION_COUNT = 3;
const PRIOR_SESSION_TAIL = 10;
const PRIOR_SESSIONS_CHAR_CAP = 3000;
const PRIOR_LINE_CHAR_CAP = 200;

// Pending suggestions live as source='suggested' + status='inbox' until the
// user accepts them — they must not masquerade as real tasks anywhere.
const notPendingSuggestion = or(ne(tasks.source, "suggested"), ne(tasks.status, "inbox"));

type BriefingItem = { id: string; title: string; detail: string };

export type BriefingCard = {
  dateLabel: string;
  overdue: BriefingItem[];
  dueToday: BriefingItem[];
  dueTomorrow: BriefingItem[];
  events: BriefingItem[];
  stalled: BriefingItem[];
  procrastinated: BriefingItem[];
  suggestions: BriefingItem[];
  hasContent: boolean;
};

export type Briefing = { text: string; card: BriefingCard };

function fmt(d: Date, tz: string, withTime = true) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(d);
}

/**
 * Build the briefing. With consumeNudges=true (session starts), the overdue
 * items surfaced for nudging get lastNudgedAt stamped so the same item isn't
 * nagged twice in a day.
 */
export async function buildBriefing(
  userId: string,
  timezone: string,
  opts: { consumeNudges?: boolean; excludeConversationId?: string | null } = {}
): Promise<Briefing> {
  const now = new Date();
  const today = dayRangeInTz(timezone, now);
  const tomorrow = dayRangeInTz(timezone, new Date(now.getTime() + 86400000));

  // Keep procrastination scores fresh at session start (pure math, no model).
  await refreshProcrastinationScores(userId, now);

  const overdueRows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.status, [...OPEN_STATUSES]),
        notPendingSuggestion,
        isNotNull(tasks.dueAt),
        lt(tasks.dueAt, now)
      )
    )
    .orderBy(tasks.dueAt);

  const dueTodayRows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.status, [...OPEN_STATUSES]),
        notPendingSuggestion,
        gte(tasks.dueAt, now),
        lt(tasks.dueAt, today.end)
      )
    );

  const dueTomorrowRows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.status, [...OPEN_STATUSES]),
        notPendingSuggestion,
        gte(tasks.dueAt, tomorrow.start),
        lt(tasks.dueAt, tomorrow.end)
      )
    );

  const todayEvents = await db
    .select()
    .from(events)
    .where(
      and(eq(events.userId, userId), gte(events.startsAt, today.start), lt(events.startsAt, today.end))
    )
    .orderBy(events.startsAt);

  const stalledRows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.status, "in_progress"),
        lt(tasks.updatedAt, new Date(now.getTime() - STALLED_DAYS * 86400000))
      )
    )
    .limit(5);

  const procrastinatedRows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.status, [...OPEN_STATUSES]),
        notPendingSuggestion,
        gte(tasks.procrastinationScore, 3)
      )
    )
    .orderBy(desc(tasks.procrastinationScore))
    .limit(3);

  const suggestionRows = await getPendingSuggestions(userId);

  const memoryRows = await db
    .select()
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(desc(memories.createdAt))
    .limit(20);

  // Today's upcoming reminders (tasks + events) — briefings are the delivery
  // mechanism until push notifications exist.
  const reminderRows: { at: Date; title: string }[] = [];
  {
    const openWithReminders = await db
      .select({ title: tasks.title, reminders: tasks.reminders })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES])));
    const eventsWithReminders = await db
      .select({ title: events.title, reminders: events.reminders })
      .from(events)
      .where(and(eq(events.userId, userId), gte(events.startsAt, new Date(now.getTime() - 86400000))));
    for (const row of [...openWithReminders, ...eventsWithReminders]) {
      for (const iso of row.reminders ?? []) {
        const at = new Date(iso);
        if (at >= now && at < today.end) reminderRows.push({ at, title: row.title });
      }
    }
    reminderRows.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  // Snapshot of what already exists, so the model updates instead of
  // duplicating ("push the expense report" must never create a second one).
  const openTasks = await db
    .select({ task: tasks, projectName: projects.name })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES]), notPendingSuggestion)
    )
    .orderBy(tasks.dueAt)
    .limit(30);

  // The model must know what projects exist, or it files things into
  // near-duplicates ("Find It" next to "Find It app").
  const projectRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), ne(projects.status, "archived")));
  const openCounts = await db
    .select({ projectId: tasks.projectId, n: count() })
    .from(tasks)
    .where(
      and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES]), notPendingSuggestion)
    )
    .groupBy(tasks.projectId);
  const upcomingEvents = await db
    .select({ event: events, projectName: projects.name })
    .from(events)
    .leftJoin(projects, eq(events.projectId, projects.id))
    .where(
      and(
        eq(events.userId, userId),
        gte(events.startsAt, today.start),
        lt(events.startsAt, new Date(now.getTime() + 7 * 86400000))
      )
    )
    .orderBy(events.startsAt)
    .limit(20);

  // Documents: the model must know what exists to find "the duty statement",
  // and stale ones feed the quiet nudge.
  const docRows = await db
    .select({ doc: documents, projectName: projects.name })
    .from(documents)
    .leftJoin(projects, eq(documents.projectId, projects.id))
    .where(eq(documents.userId, userId))
    .orderBy(desc(documents.updatedAt))
    .limit(10);
  const STALE_DOC_DAYS = 4;
  const staleDocs = docRows.filter(
    ({ doc }) =>
      doc.sections.some((s) => s.content.trim()) &&
      now.getTime() - doc.updatedAt.getTime() > STALE_DOC_DAYS * 86400000
  );

  // events per project this week, for the PROJECTS section counts
  const eventCounts = await db
    .select({ projectId: events.projectId, n: count() })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        gte(events.startsAt, now),
        lt(events.startsAt, new Date(now.getTime() + 7 * 86400000))
      )
    )
    .groupBy(events.projectId);

  // Nudge budget: overdue items not already nudged today, max 3.
  const nudgeable = overdueRows.filter(
    (t) => !t.lastNudgedAt || t.lastNudgedAt < today.start
  );
  const toNudge = nudgeable.slice(0, MAX_NUDGES);
  if (opts.consumeNudges && toNudge.length > 0) {
    await db
      .update(tasks)
      .set({ lastNudgedAt: now })
      .where(
        and(
          eq(tasks.userId, userId),
          inArray(
            tasks.id,
            toNudge.map((t) => t.id)
          )
        )
      );
  }

  const daysLate = (t: { dueAt: Date | null }) =>
    Math.max(1, Math.floor((now.getTime() - (t.dueAt?.getTime() ?? 0)) / 86400000));

  const card: BriefingCard = {
    // Year included ON PURPOSE: models compute relative dates ("this Friday")
    // from this line, and a yearless date sent Claude to its training-prior
    // year (filed a task 360 days late). Never make the model guess the year.
    dateLabel: new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(now),
    overdue: overdueRows.map((t) => ({
      id: t.id,
      title: t.title,
      detail: `${daysLate(t)}d late${t.postponedCount ? ` · pushed ${t.postponedCount}×` : ""}`,
    })),
    dueToday: dueTodayRows.map((t) => ({
      id: t.id,
      title: t.title,
      detail: fmt(t.dueAt!, timezone),
    })),
    dueTomorrow: dueTomorrowRows.map((t) => ({
      id: t.id,
      title: t.title,
      detail: "tomorrow",
    })),
    events: todayEvents.map((e) => ({
      id: e.id,
      title: e.title,
      detail: fmt(e.startsAt, timezone),
    })),
    stalled: stalledRows.map((t) => ({
      id: t.id,
      title: t.title,
      detail: "in progress, no movement",
    })),
    procrastinated: procrastinatedRows.map((t) => ({
      id: t.id,
      title: t.title,
      detail: t.postponedCount ? `pushed ${t.postponedCount}×` : "stalling",
    })),
    suggestions: suggestionRows.map((t) => ({
      id: t.id,
      title: t.title,
      detail: t.notes?.replace(/^Suggested: /, "") ?? "",
    })),
    hasContent:
      overdueRows.length + dueTodayRows.length + todayEvents.length + stalledRows.length > 0,
  };

  const lines: string[] = [
    `CURRENT DATE & TIME (server truth — never guess dates): ${card.dateLabel} (${timezone})`,
    "",
    "=== TODAY'S BRIEFING ===",
  ];
  if (overdueRows.length) {
    lines.push("Overdue:");
    for (const t of overdueRows)
      lines.push(
        `- "${t.title}" — due ${fmt(t.dueAt!, timezone)} (${daysLate(t)}d late, postponed ${t.postponedCount}×)${
          // SPEC §11: nags cite recorded stakes — sternness stays honest.
          t.stakes ? ` [STAKES the user named — cite when nudging: ${t.stakes}]` : ""
        }${
          toNudge.some((n) => n.id === t.id) ? "" : " [already nudged today — do not nag again unless asked]"
        }`
      );
  }
  if (dueTodayRows.length)
    lines.push(
      "Due today: " + dueTodayRows.map((t) => `"${t.title}" (${fmt(t.dueAt!, timezone)})`).join(", ")
    );
  if (dueTomorrowRows.length)
    lines.push("Due tomorrow: " + dueTomorrowRows.map((t) => `"${t.title}"`).join(", "));
  if (todayEvents.length)
    lines.push(
      "Today's events: " +
        todayEvents.map((e) => `"${e.title}" at ${fmt(e.startsAt, timezone)}`).join(", ")
    );
  if (reminderRows.length)
    lines.push(
      "Reminders today (logged — mention the next one; they don't ring the device): " +
        reminderRows.map((r) => `${fmt(r.at, timezone)} — ${r.title}`).join(", ")
    );
  if (stalledRows.length)
    lines.push("Stalled (in progress, no activity ≥3d): " + stalledRows.map((t) => `"${t.title}"`).join(", "));
  if (procrastinatedRows.length)
    lines.push(
      "Most procrastinated: " +
        procrastinatedRows
          .map((t) => `"${t.title}" (score ${t.procrastinationScore}, pushed ${t.postponedCount}×)`)
          .join(", ")
    );
  if (suggestionRows.length)
    lines.push(
      "Pending suggestions (mention AT MOST ONE per conversation, casually, only if it fits — the user accepts or dismisses them on the dashboard): " +
        suggestionRows.map((t) => `"${t.title}"`).join(", ")
    );
  if (
    !overdueRows.length &&
    !dueTodayRows.length &&
    !todayEvents.length &&
    !stalledRows.length
  )
    lines.push("Nothing overdue, due, or scheduled today. A quiet day.");
  if (projectRows.length) {
    lines.push(
      "",
      "PROJECTS (file tasks into one of these EXACT names — only create a new project for a genuinely new area of life):"
    );
    for (const p of projectRows) {
      const n = openCounts.find((c) => c.projectId === p.id)?.n ?? 0;
      const ev = eventCounts.find((c) => c.projectId === p.id)?.n ?? 0;
      lines.push(
        `- "${p.name}" (${n} open task${n === 1 ? "" : "s"}${ev ? ` · ${ev} event${ev === 1 ? "" : "s"} this week` : ""})`
      );
    }
  }
  if (openTasks.length) {
    lines.push("", "ALL OPEN TASKS (update these — never create a duplicate):");
    for (const { task: t, projectName } of openTasks) {
      const stages = t.stages ?? [];
      const stageInfo = stages.length
        ? ` · stage ${stages.filter((s) => s.done).length}/${stages.length}${
            stages.find((s) => !s.done) ? ` (next: ${stages.find((s) => !s.done)!.name})` : ""
          }`
        : "";
      lines.push(
        `- [${t.id}] "${t.title}" · ${t.status}${t.dueAt ? ` · due ${fmt(t.dueAt, timezone)}` : ""}${t.postponedCount ? ` · pushed ${t.postponedCount}×` : ""}${projectName ? ` · project "${projectName}"` : ""}${stageInfo}${t.recurrence ? ` · repeats ${t.recurrence}` : ""}`
      );
    }
  }
  if (docRows.length) {
    lines.push("", "DOCUMENTS (living documents — read/edit by section with the document tools):");
    for (const { doc, projectName } of docRows)
      lines.push(
        `- [${doc.id}] "${doc.title}"${projectName ? ` · project "${projectName}"` : ""} · sections: ${doc.sections.map((s) => s.heading).join(", ") || "(empty)"} · last edited ${fmt(doc.updatedAt, timezone)}`
      );
  }
  if (staleDocs.length)
    lines.push(
      "Documents not moving (mention ONE conversationally if it fits — 'want to work on it?'): " +
        staleDocs.map(({ doc }) => `"${doc.title}" (last edited ${fmt(doc.updatedAt, timezone)})`).join(", ")
    );
  if (upcomingEvents.length) {
    lines.push("", "UPCOMING EVENTS (next 7 days — already logged, don't re-create):");
    for (const { event: e, projectName } of upcomingEvents)
      lines.push(
        `- [${e.id}] "${e.title}" · ${fmt(e.startsAt, timezone)}${projectName ? ` · project "${projectName}"` : ""}`
      );
  }
  if (memoryRows.length) {
    lines.push("", "Things you know about the user:");
    for (const m of memoryRows) lines.push(`- ${m.fact}`);
  }
  // Prior sessions (SPEC §11 cross-session recall): verbatim tail of the last
  // few conversations, voice and text alike — this is what makes "like I said
  // last time" land. Verbatim lines, never summaries; the deep past stays
  // on-demand via search_history.
  const priorTails = await getRecentConversationTails(userId, {
    excludeConversationId: opts.excludeConversationId,
    conversationLimit: PRIOR_SESSION_COUNT,
    messagesPerConversation: PRIOR_SESSION_TAIL,
  });
  if (priorTails.length) {
    lines.push(
      "",
      "=== PRIOR SESSIONS (verbatim excerpts, most recent first — what was said in recent conversations; for anything older or not shown, use search_history) ==="
    );
    let used = 0;
    for (const { conversation: conv, messages: tail } of priorTails) {
      const block = [
        `[${conv.mode} session · ${fmt(conv.startedAt, timezone)}${
          conv.endedAt ? ` – ${fmt(conv.endedAt, timezone)}` : ""
        }]`,
      ];
      for (const m of tail) {
        if (m.role === "tool") continue;
        const text =
          m.content.length > PRIOR_LINE_CHAR_CAP
            ? `${m.content.slice(0, PRIOR_LINE_CHAR_CAP)}…`
            : m.content;
        block.push(`${m.role === "user" ? "USER" : "SECRETARY"}: ${text}`);
      }
      const size = block.join("\n").length;
      if (used > 0 && used + size > PRIOR_SESSIONS_CHAR_CAP) break;
      lines.push(...block);
      used += size;
    }
  }
  // Expectations / nag engine (SPEC §11): session start is the trigger. Open
  // expectations past their update-by time become MISSED and fire here —
  // batched into ONE opening ping, quiet-hours-aware, escalating per policy,
  // citing task stakes when recorded. A cleared expectation never appears.
  const [personaRow] = await db
    .select({ persona: user.persona })
    .from(user)
    .where(eq(user.id, userId));
  const dueExpectations = await db
    .select()
    .from(expectations)
    .where(
      and(
        eq(expectations.userId, userId),
        eq(expectations.status, "open"),
        lt(expectations.expectedUpdateBy, now)
      )
    )
    .orderBy(expectations.expectedUpdateBy);
  if (dueExpectations.length) {
    await db
      .update(expectations)
      .set({ status: "missed" })
      .where(
        inArray(
          expectations.id,
          dueExpectations.map((e) => e.id)
        )
      );
    const quiet = isQuietHours(personaRow?.persona, now, timezone);
    if (quiet) {
      lines.push(
        "",
        "EXPECTATIONS MISSED (quiet hours — do NOT open with these; hold them until the user engages first):"
      );
    } else {
      lines.push(
        "",
        "EXPECTATIONS MISSED — you said you'd ask. Open the session with ONE combined question covering all of these (never a barrage):"
      );
    }
    const stakesById = new Map<string, string>();
    const linkedIds = dueExpectations.flatMap((e) => (e.taskId ? [e.taskId] : []));
    if (linkedIds.length) {
      const linked = await db.select().from(tasks).where(inArray(tasks.id, linkedIds));
      for (const t of linked) if (t.stakes) stakesById.set(t.id, t.stakes);
    }
    for (const e of dueExpectations) {
      const stakes = e.taskId ? stakesById.get(e.taskId) : null;
      lines.push(
        `- "${e.commitment}" (update was due ${fmt(e.expectedUpdateBy, timezone)}) · on_miss: ${e.onMiss}${
          stakes ? ` · STAKES: ${stakes}` : ""
        }`
      );
    }
    lines.push(
      "Escalation: mention = one soft line · nag = direct opener question · escalate = lead with it, cite the stakes, and get a NEW commitment (create_expectation again)."
    );
  }

  // Clarification queue (SPEC §11): ONE question per session, at a natural
  // pause — never mid-flow, never a barrage. Surfacing marks it asked.
  const clarification = await nextClarification(userId);
  if (clarification) {
    const remaining = await openClarificationCount(userId);
    lines.push(
      "",
      `CLARIFICATION QUEUE — exactly ONE this session, asked at a natural pause (never mid-flow, never as an interrogation)${
        remaining > 0 ? ` (${remaining} more queued for later sessions)` : ""
      }:`,
      `- ${clarification.question}${clarification.context ? ` (about: "${clarification.context}")` : ""}`,
      "When answered, call resolve_clarification."
    );
  }

  // The Shop (self-improvement loop): plans awaiting the user's sign-off, and
  // outcomes since roughly the last day — the "it shipped overnight" moment.
  const { capabilityRequests } = await import("@/lib/db/schema");
  const shopRows = await db
    .select()
    .from(capabilityRequests)
    .where(eq(capabilityRequests.userId, userId));
  const awaiting = shopRows.filter((r) => r.status === "planned");
  const recent = shopRows.filter(
    (r) =>
      (r.status === "shipped" || r.status === "failed") &&
      now.getTime() - r.updatedAt.getTime() < 36 * 60 * 60 * 1000
  );
  if (awaiting.length) {
    lines.push(
      "",
      "SHOP — plans awaiting the user's decision (approve/reject via review_capability; the plan text is in Settings):"
    );
    for (const r of awaiting) lines.push(`- "${r.need}"`);
    lines.push(
      "Mention ONE at a natural pause: the shop drafted a plan for it — want it built? Approved builds land automatically once tests pass."
    );
  }
  if (recent.length) {
    lines.push("", "SHOP — recent outcomes (mention briefly if relevant):");
    for (const r of recent) {
      lines.push(
        r.status === "shipped"
          ? `- SHIPPED: "${r.need}" — the ability now exists; use it.`
          : `- FAILED: "${r.need}" — the build didn't pass verification; the user can re-file or check Settings.`
      );
    }
  }

  // Morning layout note (SPEC §9 Phase 2): if the dashboard was rearranged,
  // the secretary knows why and can say so — or change it on request.
  const planHead = await getPlanHead(userId);
  const planReason = planHead?.reasonSummary;
  if (planReason) {
    lines.push(
      "",
      `DASHBOARD: currently arranged for the situation — "${planReason}". If the user asks about the layout or wants it changed, use get_current_plan / edit_layout_plan / set_layout_preference.`
    );
  }
  lines.push(
    "",
    `Nudge budget this session: at most ${MAX_NUDGES}, and only items not marked [already nudged today]. Lead with the single most important one.`
  );

  return { text: lines.join("\n"), card };
}
