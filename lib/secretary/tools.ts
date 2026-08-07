// Tool executor — the secretary's hands. Every function is user-scoped; the
// voice path reaches it via POST /api/secretary/tools, the text path calls
// executeTool directly inside /api/chat.
import { and, desc, eq, gte, ilike, inArray, isNotNull, lt, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  checkins,
  events,
  memories,
  messages,
  projects,
  tasks,
} from "@/lib/db/schema";
import { dayRangeInTz } from "@/lib/time";
import { toolSchemas, type ToolName } from "./tool-schemas";

export type ToolContext = {
  userId: string;
  timezone: string;
  conversationId?: string;
  anchorMessageId?: string;
};

export type ToolOutcome = {
  result: unknown;
  toast?: { icon: string; text: string };
};

const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;

function fmtDate(d: Date | null, tz: string, withTime = true) {
  if (!d) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(d);
}

function parseWhen(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable date: ${iso}`);
  return d;
}

async function findTask(userId: string, ref: string) {
  const byId = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, ref)))
    .limit(1);
  if (byId[0]) return byId[0];
  const open = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        ilike(tasks.title, `%${ref}%`),
        inArray(tasks.status, [...OPEN_STATUSES])
      )
    )
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  if (open[0]) return open[0];
  const any = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), ilike(tasks.title, `%${ref}%`)))
    .orderBy(desc(tasks.createdAt))
    .limit(1);
  return any[0] ?? null;
}

async function resolveProject(userId: string, name: string | undefined) {
  if (!name) return null;
  const existing = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), ilike(projects.name, name)))
    .limit(1);
  if (existing[0]) return existing[0];
  const [created] = await db
    .insert(projects)
    .values({ userId, name })
    .returning();
  return created;
}

type Args = Record<string, unknown>;

const handlers: Record<ToolName, (ctx: ToolContext, args: Args) => Promise<ToolOutcome>> = {
  async create_task(ctx, args) {
    const a = toolSchemas.create_task.parse(args);
    const project = await resolveProject(ctx.userId, a.project);
    const dueAt = parseWhen(a.due_at);
    const [task] = await db
      .insert(tasks)
      .values({
        userId: ctx.userId,
        title: a.title,
        notes: a.notes,
        projectId: project?.id,
        dueAt,
        priority: a.priority ?? 0,
        status: "todo",
        source: ctx.conversationId ? "spoken" : "typed",
        createdFromConversationId: ctx.conversationId,
        createdFromMessageId: ctx.anchorMessageId,
      })
      .returning();
    const due = fmtDate(task.dueAt, ctx.timezone, false);
    return {
      result: { task_id: task.id, title: task.title, due_at: task.dueAt, project: project?.name ?? null },
      toast: { icon: "✓", text: `Added: ${task.title}${due ? ` — due ${due}` : ""}` },
    };
  },

  async update_task(ctx, args) {
    const a = toolSchemas.update_task.parse(args);
    const task = await findTask(ctx.userId, a.task);
    if (!task) return { result: { error: `No task matching "${a.task}"` } };

    const updates: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
    let postponed = false;

    if (a.due_at) {
      const newDue = parseWhen(a.due_at)!;
      if (task.dueAt && newDue.getTime() > task.dueAt.getTime()) {
        postponed = true;
        updates.postponedCount = task.postponedCount + 1;
      }
      updates.dueAt = newDue;
    }
    if (a.status) {
      updates.status = a.status;
      if (a.status === "in_progress" && !task.startedAt) updates.startedAt = new Date();
      if (a.status === "done") updates.completedAt = new Date();
    }
    if (a.title) updates.title = a.title;
    if (a.notes) updates.notes = a.notes;
    if (a.priority !== undefined) updates.priority = a.priority;

    const [updated] = await db
      .update(tasks)
      .set(updates)
      .where(and(eq(tasks.userId, ctx.userId), eq(tasks.id, task.id)))
      .returning();

    if (postponed || a.status) {
      await db.insert(checkins).values({
        userId: ctx.userId,
        taskId: task.id,
        type: "user_update",
        note: postponed
          ? `Postponed to ${fmtDate(updated.dueAt, ctx.timezone)}${a.postpone_reason ? ` — ${a.postpone_reason}` : ""} (${updated.postponedCount}× total)`
          : `Status → ${updated.status}`,
      });
    }

    const due = fmtDate(updated.dueAt, ctx.timezone, false);
    return {
      result: {
        task_id: updated.id,
        title: updated.title,
        status: updated.status,
        due_at: updated.dueAt,
        postponed_count: updated.postponedCount,
      },
      toast: postponed
        ? { icon: "→", text: `Pushed: ${updated.title} — now ${due}` }
        : { icon: "✎", text: `Updated: ${updated.title}` },
    };
  },

  async complete_task(ctx, args) {
    const a = toolSchemas.complete_task.parse(args);
    const task = await findTask(ctx.userId, a.task);
    if (!task) return { result: { error: `No task matching "${a.task}"` } };
    const [updated] = await db
      .update(tasks)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tasks.userId, ctx.userId), eq(tasks.id, task.id)))
      .returning();
    await db.insert(checkins).values({
      userId: ctx.userId,
      taskId: task.id,
      type: "user_update",
      note: "Marked done",
    });
    return {
      result: { task_id: updated.id, title: updated.title, status: "done" },
      toast: { icon: "✓", text: `Done: ${updated.title}` },
    };
  },

  async create_project(ctx, args) {
    const a = toolSchemas.create_project.parse(args);
    const [project] = await db
      .insert(projects)
      .values({ userId: ctx.userId, name: a.name, color: a.color })
      .returning();
    return {
      result: { project_id: project.id, name: project.name },
      toast: { icon: "▣", text: `New project: ${project.name}` },
    };
  },

  async create_event(ctx, args) {
    const a = toolSchemas.create_event.parse(args);
    const [event] = await db
      .insert(events)
      .values({
        userId: ctx.userId,
        title: a.title,
        startsAt: parseWhen(a.starts_at)!,
        endsAt: parseWhen(a.ends_at),
        location: a.location,
        source: ctx.conversationId ? "spoken" : "typed",
        conversationId: ctx.conversationId,
        messageId: ctx.anchorMessageId,
      })
      .returning();
    return {
      result: { event_id: event.id, title: event.title, starts_at: event.startsAt },
      toast: {
        icon: "📅",
        text: `${event.title} — ${fmtDate(event.startsAt, ctx.timezone)}`,
      },
    };
  },

  async get_agenda(ctx, args) {
    const a = toolSchemas.get_agenda.parse(args);
    const now = new Date();
    let base = now;
    if (a.date === "tomorrow") base = new Date(now.getTime() + 86400000);
    else if (a.date && a.date !== "today") {
      base = new Date(`${a.date}T12:00:00`);
      if (Number.isNaN(base.getTime())) throw new Error(`Bad date: ${a.date}`);
    }
    const { start, end } = dayRangeInTz(ctx.timezone, base);
    const dayTasks = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, ctx.userId),
          inArray(tasks.status, [...OPEN_STATUSES]),
          gte(tasks.dueAt, start),
          lt(tasks.dueAt, end)
        )
      );
    const dayEvents = await db
      .select()
      .from(events)
      .where(
        and(eq(events.userId, ctx.userId), gte(events.startsAt, start), lt(events.startsAt, end))
      );
    return {
      result: {
        tasks_due: dayTasks.map((t) => ({ id: t.id, title: t.title, due_at: fmtDate(t.dueAt, ctx.timezone) })),
        events: dayEvents.map((e) => ({
          id: e.id,
          title: e.title,
          at: fmtDate(e.startsAt, ctx.timezone),
          location: e.location,
        })),
      },
    };
  },

  async get_overdue(ctx) {
    const now = new Date();
    const rows = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.userId, ctx.userId),
          inArray(tasks.status, [...OPEN_STATUSES]),
          isNotNull(tasks.dueAt),
          lt(tasks.dueAt, now)
        )
      )
      .orderBy(tasks.dueAt);
    return {
      result: rows.map((t) => ({
        id: t.id,
        title: t.title,
        due_at: fmtDate(t.dueAt, ctx.timezone),
        days_overdue: Math.floor((now.getTime() - t.dueAt!.getTime()) / 86400000),
        postponed_count: t.postponedCount,
      })),
    };
  },

  async get_tasks(ctx, args) {
    const a = toolSchemas.get_tasks.parse(args);
    const conds = [eq(tasks.userId, ctx.userId)];
    if (a.status) conds.push(eq(tasks.status, a.status));
    if (a.project) {
      const project = await db
        .select()
        .from(projects)
        .where(and(eq(projects.userId, ctx.userId), ilike(projects.name, `%${a.project}%`)))
        .limit(1);
      if (!project[0]) return { result: { error: `No project matching "${a.project}"` } };
      conds.push(eq(tasks.projectId, project[0].id));
    }
    const rows = await db
      .select()
      .from(tasks)
      .where(and(...conds))
      .orderBy(desc(tasks.updatedAt))
      .limit(50);
    return {
      result: rows.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        due_at: fmtDate(t.dueAt, ctx.timezone),
        postponed_count: t.postponedCount,
      })),
    };
  },

  async remember_fact(ctx, args) {
    const a = toolSchemas.remember_fact.parse(args);
    const [memory] = await db
      .insert(memories)
      .values({ userId: ctx.userId, fact: a.fact, tags: a.tags ?? [] })
      .returning();
    return {
      result: { memory_id: memory.id, fact: memory.fact },
      toast: { icon: "◆", text: `Noted: ${memory.fact.slice(0, 60)}` },
    };
  },

  async recall_facts(ctx) {
    const rows = await db
      .select()
      .from(memories)
      .where(eq(memories.userId, ctx.userId))
      .orderBy(desc(memories.createdAt))
      .limit(50);
    return { result: rows.map((m) => ({ fact: m.fact, tags: m.tags })) };
  },

  async get_current_datetime(ctx) {
    const now = new Date();
    return {
      result: {
        iso: now.toISOString(),
        local: new Intl.DateTimeFormat("en-US", {
          timeZone: ctx.timezone,
          dateStyle: "full",
          timeStyle: "short",
        }).format(now),
        timezone: ctx.timezone,
      },
    };
  },

  async search_history(ctx, args) {
    const a = toolSchemas.search_history.parse(args);
    const rows = await db
      .select({
        content: messages.content,
        role: messages.role,
        conversationId: messages.conversationId,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.userId, ctx.userId),
          or(ilike(messages.content, `%${a.query}%`))
        )
      )
      .orderBy(desc(messages.createdAt))
      .limit(10);
    return {
      result: rows.map((m) => ({
        when: fmtDate(m.createdAt, ctx.timezone),
        role: m.role,
        snippet: m.content.slice(0, 200),
        conversation_id: m.conversationId,
      })),
    };
  },
};

export async function executeTool(
  ctx: ToolContext,
  name: string,
  args: unknown
): Promise<ToolOutcome> {
  const handler = handlers[name as ToolName];
  if (!handler) return { result: { error: `Unknown tool: ${name}` } };
  try {
    return await handler(ctx, (args ?? {}) as Args);
  } catch (e) {
    return { result: { error: e instanceof Error ? e.message : "Tool failed" } };
  }
}
