// Tool executor — the secretary's hands. Every function is user-scoped; the
// voice path reaches it via POST /api/secretary/tools, the text path calls
// executeTool directly inside /api/chat.
import { and, count, desc, eq, gte, ilike, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  checkins,
  documents,
  documentVersions,
  events,
  memories,
  messages,
  projects,
  tasks,
  type DocSection,
} from "@/lib/db/schema";
import { dayRangeInTz } from "@/lib/time";
import { findDuplicate, findDuplicateEvent } from "./dedupe";
import { spawnNextOccurrence } from "./recurrence";
import { toolSchemas, type ToolName } from "./tool-schemas";

/** Live create-guard threshold: only near-identical titles count as dupes —
 *  the realtime model sometimes re-issues a create after a barge-in, and that
 *  must be idempotent, but "Email Ash" vs "Call Ash" must both go through. */
const CREATE_GUARD_SIMILARITY = 0.85;

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

/** Validate + normalize reminder timestamps. Undefined = leave unchanged. */
function parseReminders(list: string[] | undefined): string[] | undefined {
  if (list === undefined) return undefined;
  return list.map((iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw new Error(`Unparseable reminder time: ${iso}`);
    return d.toISOString();
  });
}

function fmtReminders(list: string[], tz: string): string {
  return list.map((iso) => fmtDate(new Date(iso), tz)).join(", ");
}

async function findEvent(userId: string, ref: string) {
  const byId = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, ref)))
    .limit(1);
  if (byId[0]) return byId[0];
  const upcoming = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        ilike(events.title, `%${ref}%`),
        gte(events.startsAt, new Date(Date.now() - 86400000))
      )
    )
    .orderBy(events.startsAt)
    .limit(1);
  if (upcoming[0]) return upcoming[0];
  const any = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), ilike(events.title, `%${ref}%`)))
    .orderBy(desc(events.startsAt))
    .limit(1);
  return any[0] ?? null;
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

function normalizeProjectName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ProjectResolution = {
  project: typeof projects.$inferSelect | null;
  /** How the name landed: exact/normalized/fuzzy match, freshly created, or null. */
  matched: "exact" | "normalized" | "fuzzy" | "created" | null;
};

/**
 * "Find It" must land in "Find It app", never spawn a duplicate. Exact
 * (case-insensitive) → normalized (punctuation/whitespace-blind) → containment
 * either way — and only when nothing is close does `create` make a new one.
 */
export async function resolveProject(
  userId: string,
  name: string | undefined,
  opts: { create?: boolean } = {}
): Promise<ProjectResolution> {
  if (!name) return { project: null, matched: null };
  // The model sometimes passes the "no project" sentinel into CREATE paths —
  // that must mean unfiled, never a project literally named "none".
  // (Found by the simulation harness: a project called "none" was created.)
  if (/^(none|null|no project|n\/a|unfiled)$/i.test(name.trim())) {
    return { project: null, matched: null };
  }
  const create = opts.create ?? true;

  const all = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, userId), ne(projects.status, "archived")));

  const exact = all.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (exact) return { project: exact, matched: "exact" };

  const norm = normalizeProjectName(name);
  if (norm.length >= 3) {
    const normalized = all.find((p) => normalizeProjectName(p.name) === norm);
    if (normalized) return { project: normalized, matched: "normalized" };

    const candidates = all.filter((p) => {
      const pn = normalizeProjectName(p.name);
      return pn.length >= 3 && (pn.includes(norm) || norm.includes(pn));
    });
    if (candidates.length) {
      // several containment hits → the one closest in length wins
      candidates.sort(
        (a, b) =>
          Math.abs(normalizeProjectName(a.name).length - norm.length) -
          Math.abs(normalizeProjectName(b.name).length - norm.length)
      );
      return { project: candidates[0], matched: "fuzzy" };
    }
  }

  if (!create) return { project: null, matched: null };
  const [created] = await db.insert(projects).values({ userId, name }).returning();
  return { project: created, matched: "created" };
}

// --- documents: voice-first helpers -----------------------------------------

/** Above this total size, read_document returns headings only — a long doc
 *  must never flood the realtime session. */
const DOC_FULL_READ_CHARS = 1500;
/** Hard cap on any single section returned to the model. */
const SECTION_READ_CHARS = 4000;
const DOC_VERSIONS_KEPT = 20;

async function findDocument(userId: string, ref: string) {
  const byId = await db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.id, ref)))
    .limit(1);
  if (byId[0]) return byId[0];
  const byTitle = await db
    .select()
    .from(documents)
    .where(and(eq(documents.userId, userId), ilike(documents.title, `%${ref}%`)))
    .orderBy(desc(documents.updatedAt))
    .limit(1);
  return byTitle[0] ?? null;
}

/** Section by fuzzy heading match or 1-based number ("2", "section 2"). */
function findSection(sections: DocSection[], ref: string): number {
  const numMatch = ref.match(/^\s*(?:section\s*)?(\d{1,2})\s*$/i);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    return idx >= 0 && idx < sections.length ? idx : -1;
  }
  const needle = ref.toLowerCase().trim();
  let idx = sections.findIndex((s) => s.heading.toLowerCase() === needle);
  if (idx === -1)
    idx = sections.findIndex(
      (s) =>
        s.heading.toLowerCase().includes(needle) || needle.includes(s.heading.toLowerCase())
    );
  return idx;
}

/** Snapshot the document's current state before a mutation (revert safety). */
async function snapshotDocument(doc: typeof documents.$inferSelect, note: string) {
  await db.insert(documentVersions).values({
    userId: doc.userId,
    documentId: doc.id,
    title: doc.title,
    sections: doc.sections,
    note,
  });
  const versions = await db
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, doc.id))
    .orderBy(desc(documentVersions.savedAt));
  if (versions.length > DOC_VERSIONS_KEPT) {
    await db.delete(documentVersions).where(
      inArray(
        documentVersions.id,
        versions.slice(DOC_VERSIONS_KEPT).map((v) => v.id)
      )
    );
  }
}

function docSummary(doc: typeof documents.$inferSelect) {
  return {
    document_id: doc.id,
    title: doc.title,
    sections: doc.sections.map((s, i) => ({
      number: i + 1,
      heading: s.heading,
      words: s.content.split(/\s+/).filter(Boolean).length,
    })),
  };
}

type Args = Record<string, unknown>;

const handlers: Record<ToolName, (ctx: ToolContext, args: Args) => Promise<ToolOutcome>> = {
  async create_task(ctx, args) {
    const a = toolSchemas.create_task.parse(args);
    const dueAtGuard = parseWhen(a.due_at) ?? null;
    // Idempotency guard: a re-issued create (double tool call, reconnect)
    // must return the existing task, never insert a twin.
    const openNow = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, ctx.userId), inArray(tasks.status, [...OPEN_STATUSES])));
    const twin = findDuplicate(
      { title: a.title, dueAt: dueAtGuard },
      openNow,
      CREATE_GUARD_SIMILARITY
    );
    if (twin) {
      return {
        result: {
          task_id: twin.id,
          title: twin.title,
          already_existed: true,
          note: "An open task with this title already exists — nothing was created. Use update_task to change it.",
        },
      };
    }
    const { project, matched } = await resolveProject(ctx.userId, a.project);
    const dueAt = parseWhen(a.due_at);
    const reminders = parseReminders(a.reminders) ?? [];
    const [task] = await db
      .insert(tasks)
      .values({
        userId: ctx.userId,
        title: a.title,
        notes: a.notes,
        projectId: project?.id,
        dueAt,
        priority: a.priority ?? 0,
        reminders,
        stages: (a.stages ?? []).map((name) => ({ name, done: false })),
        recurrence: a.recurrence,
        status: "todo",
        source: ctx.conversationId ? "spoken" : "typed",
        createdFromConversationId: ctx.conversationId,
        createdFromMessageId: ctx.anchorMessageId,
      })
      .returning();
    const due = fmtDate(task.dueAt, ctx.timezone, false);
    return {
      result: {
        task_id: task.id,
        title: task.title,
        due_at: task.dueAt,
        project: project?.name ?? null,
        project_match: matched,
        ...(task.stages.length ? { stages: task.stages.map((s) => s.name) } : {}),
        ...(task.recurrence ? { recurrence: task.recurrence } : {}),
        ...(reminders.length ? { reminders, delivery: "logged-only" } : {}),
      },
      toast: { icon: "✓", text: `Added: ${task.title}${due ? ` — due ${due}` : ""}` },
    };
  },

  async update_task(ctx, args) {
    const a = toolSchemas.update_task.parse(args);
    const task = await findTask(ctx.userId, a.task);
    if (!task) return { result: { error: `No task matching "${a.task}"` } };

    const updates: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
    let postponed = false;
    let movedTo: string | null | undefined;
    let projectMatch: ProjectResolution["matched"] = null;

    if (a.project !== undefined) {
      if (a.project.trim().toLowerCase() === "none") {
        updates.projectId = null;
        movedTo = null;
      } else {
        const res = await resolveProject(ctx.userId, a.project);
        updates.projectId = res.project!.id;
        movedTo = res.project!.name;
        projectMatch = res.matched;
      }
    }

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
    const newReminders = parseReminders(a.reminders);
    if (newReminders !== undefined) updates.reminders = newReminders;
    if (a.recurrence !== undefined) {
      updates.recurrence = a.recurrence === "none" ? null : a.recurrence;
    }
    if (a.stages !== undefined) {
      // replace the stage list, preserving done-ness of stages that survive
      updates.stages = a.stages.map((name) => ({
        name,
        done: task.stages.some((s) => s.name.toLowerCase() === name.toLowerCase() && s.done),
      }));
    }
    let stageAdvanced: string | null = null;
    if (a.stage_done) {
      const list = (updates.stages ?? task.stages).map((s) => ({ ...s }));
      const needle = a.stage_done.toLowerCase();
      const hit =
        list.find((s) => s.name.toLowerCase() === needle) ??
        list.find(
          (s) => s.name.toLowerCase().includes(needle) || needle.includes(s.name.toLowerCase())
        );
      if (!hit) {
        return {
          result: {
            error: `No stage matching "${a.stage_done}" on "${task.title}" — stages: ${
              list.map((s) => s.name).join(", ") || "(none defined)"
            }`,
          },
        };
      }
      hit.done = true;
      updates.stages = list;
      stageAdvanced = hit.name;
    }

    const [updated] = await db
      .update(tasks)
      .set(updates)
      .where(and(eq(tasks.userId, ctx.userId), eq(tasks.id, task.id)))
      .returning();

    // completing a recurring task spawns its next occurrence
    let spawnedNext: string | null = null;
    if (a.status === "done" && task.status !== "done") {
      const next = await spawnNextOccurrence(updated);
      if (next) spawnedNext = fmtDate(next.dueAt, ctx.timezone, false) ?? "soon";
    }

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
        ...(movedTo !== undefined ? { project: movedTo, project_match: projectMatch } : {}),
        ...(updated.stages.length
          ? {
              stages: updated.stages,
              stages_done: `${updated.stages.filter((s) => s.done).length}/${updated.stages.length}`,
            }
          : {}),
        ...(a.recurrence !== undefined ? { recurrence: updated.recurrence } : {}),
        ...(spawnedNext ? { next_occurrence_due: spawnedNext } : {}),
        ...(newReminders !== undefined
          ? { reminders: updated.reminders, delivery: "logged-only" }
          : {}),
      },
      toast: stageAdvanced
        ? {
            icon: "✓",
            text: `Stage done: ${stageAdvanced} (${updated.stages.filter((s) => s.done).length}/${updated.stages.length}) — ${updated.title}`,
          }
        : spawnedNext
          ? { icon: "✓", text: `Done: ${updated.title} — next one due ${spawnedNext}` }
          : movedTo !== undefined
            ? { icon: "→", text: `Moved: ${updated.title} → ${movedTo ?? "no project"}` }
            : postponed
              ? { icon: "→", text: `Pushed: ${updated.title} — now ${due}` }
              : newReminders !== undefined
                ? { icon: "✓", text: `Reminders set: ${updated.title}` }
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
    const next = task.status !== "done" ? await spawnNextOccurrence(updated) : null;
    const nextDue = next ? fmtDate(next.dueAt, ctx.timezone, false) : null;
    return {
      result: {
        task_id: updated.id,
        title: updated.title,
        status: "done",
        ...(nextDue ? { next_occurrence_due: nextDue } : {}),
      },
      toast: {
        icon: "✓",
        text: nextDue ? `Done: ${updated.title} — next one due ${nextDue}` : `Done: ${updated.title}`,
      },
    };
  },

  async create_project(ctx, args) {
    const a = toolSchemas.create_project.parse(args);
    // even an explicit "create" must not spawn near-duplicates
    const existing = await resolveProject(ctx.userId, a.name, { create: false });
    if (existing.project) {
      return {
        result: {
          project_id: existing.project.id,
          name: existing.project.name,
          already_existed: true,
        },
      };
    }
    const [project] = await db
      .insert(projects)
      .values({ userId: ctx.userId, name: a.name, color: a.color })
      .returning();
    return {
      result: { project_id: project.id, name: project.name },
      toast: { icon: "▣", text: `New project: ${project.name}` },
    };
  },

  async list_projects(ctx) {
    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, ctx.userId), ne(projects.status, "archived")));
    const taskRows = await db
      .select({ projectId: tasks.projectId, status: tasks.status })
      .from(tasks)
      .where(eq(tasks.userId, ctx.userId));
    return {
      result: rows.map((p) => ({
        name: p.name,
        open: taskRows.filter(
          (t) => t.projectId === p.id && (OPEN_STATUSES as readonly string[]).includes(t.status)
        ).length,
        done: taskRows.filter((t) => t.projectId === p.id && t.status === "done").length,
      })),
    };
  },

  async update_project(ctx, args) {
    const a = toolSchemas.update_project.parse(args);
    const src = await resolveProject(ctx.userId, a.project, { create: false });
    if (!src.project) return { result: { error: `No project matching "${a.project}"` } };

    if (a.merge_into) {
      const target = await resolveProject(ctx.userId, a.merge_into, { create: false });
      if (!target.project) return { result: { error: `No project matching "${a.merge_into}"` } };
      if (target.project.id === src.project.id) {
        return { result: { error: "Source and target are the same project" } };
      }
      const moved = await db
        .update(tasks)
        .set({ projectId: target.project.id, updatedAt: new Date() })
        .where(and(eq(tasks.userId, ctx.userId), eq(tasks.projectId, src.project.id)))
        .returning({ id: tasks.id });
      await db
        .delete(projects)
        .where(and(eq(projects.userId, ctx.userId), eq(projects.id, src.project.id)));
      return {
        result: {
          merged: src.project.name,
          into: target.project.name,
          moved_tasks: moved.length,
        },
        toast: { icon: "▣", text: `Merged: ${src.project.name} → ${target.project.name}` },
      };
    }

    if (a.delete) {
      const [attached] = await db
        .select({ n: count() })
        .from(tasks)
        .where(and(eq(tasks.userId, ctx.userId), eq(tasks.projectId, src.project.id)));
      if ((attached?.n ?? 0) > 0) {
        return {
          result: {
            error: `"${src.project.name}" still has ${attached!.n} task(s) — use merge_into to move them first`,
          },
        };
      }
      await db
        .delete(projects)
        .where(and(eq(projects.userId, ctx.userId), eq(projects.id, src.project.id)));
      return {
        result: { deleted: src.project.name },
        toast: { icon: "✕", text: `Deleted project: ${src.project.name}` },
      };
    }

    const updates: Partial<typeof projects.$inferInsert> = {};
    if (a.name) updates.name = a.name;
    if (a.color) updates.color = a.color;
    if (Object.keys(updates).length === 0) {
      return { result: { error: "Nothing to change — give name, color, merge_into, or delete" } };
    }
    const [updated] = await db
      .update(projects)
      .set(updates)
      .where(and(eq(projects.userId, ctx.userId), eq(projects.id, src.project.id)))
      .returning();
    return {
      result: { project_id: updated.id, name: updated.name, color: updated.color },
      toast: a.name
        ? { icon: "✎", text: `Project: ${src.project.name} → ${updated.name}` }
        : { icon: "✎", text: `Updated project: ${updated.name}` },
    };
  },

  async create_event(ctx, args) {
    const a = toolSchemas.create_event.parse(args);
    const startsAtGuard = parseWhen(a.starts_at)!;
    // Same idempotency guard as create_task.
    const upcomingNow = await db
      .select()
      .from(events)
      .where(
        and(eq(events.userId, ctx.userId), gte(events.startsAt, new Date(Date.now() - 86400000)))
      );
    const twin = findDuplicateEvent(
      { title: a.title, startsAt: startsAtGuard },
      upcomingNow,
      CREATE_GUARD_SIMILARITY
    );
    if (twin) {
      return {
        result: {
          event_id: twin.id,
          title: twin.title,
          starts_at: twin.startsAt,
          already_existed: true,
          note: "This event already exists — nothing was created. Use update_event to change it.",
        },
      };
    }
    const reminders = parseReminders(a.reminders) ?? [];
    const { project, matched } = await resolveProject(ctx.userId, a.project);
    const [event] = await db
      .insert(events)
      .values({
        userId: ctx.userId,
        title: a.title,
        projectId: project?.id,
        startsAt: parseWhen(a.starts_at)!,
        endsAt: parseWhen(a.ends_at),
        location: a.location,
        notes: a.notes,
        reminders,
        source: ctx.conversationId ? "spoken" : "typed",
        conversationId: ctx.conversationId,
        messageId: ctx.anchorMessageId,
      })
      .returning();
    return {
      result: {
        event_id: event.id,
        title: event.title,
        starts_at: event.startsAt,
        project: project?.name ?? null,
        project_match: matched,
        ...(reminders.length ? { reminders, delivery: "logged-only" } : {}),
      },
      toast: {
        icon: "📅",
        text: `${event.title} — ${fmtDate(event.startsAt, ctx.timezone)}`,
      },
    };
  },

  async update_event(ctx, args) {
    const a = toolSchemas.update_event.parse(args);
    const event = await findEvent(ctx.userId, a.event);
    if (!event) return { result: { error: `No event matching "${a.event}"` } };

    const updates: Partial<typeof events.$inferInsert> = {};
    if (a.title) updates.title = a.title;
    if (a.starts_at) updates.startsAt = parseWhen(a.starts_at)!;
    if (a.ends_at) updates.endsAt = parseWhen(a.ends_at);
    if (a.location !== undefined) updates.location = a.location;
    if (a.notes !== undefined) updates.notes = a.notes;
    let movedTo: string | null | undefined;
    let projectMatch: ProjectResolution["matched"] = null;
    if (a.project !== undefined) {
      if (a.project.trim().toLowerCase() === "none") {
        updates.projectId = null;
        movedTo = null;
      } else {
        const res = await resolveProject(ctx.userId, a.project);
        updates.projectId = res.project!.id;
        movedTo = res.project!.name;
        projectMatch = res.matched;
      }
    }
    const newReminders = parseReminders(a.reminders);
    if (newReminders !== undefined) updates.reminders = newReminders;
    if (Object.keys(updates).length === 0) {
      return { result: { error: "Nothing to change — give a field to update" } };
    }

    const [updated] = await db
      .update(events)
      .set(updates)
      .where(and(eq(events.userId, ctx.userId), eq(events.id, event.id)))
      .returning();

    return {
      result: {
        event_id: updated.id,
        title: updated.title,
        starts_at: updated.startsAt,
        notes: updated.notes,
        ...(movedTo !== undefined ? { project: movedTo, project_match: projectMatch } : {}),
        ...(newReminders !== undefined
          ? { reminders: updated.reminders, delivery: "logged-only" }
          : {}),
      },
      toast: {
        icon: "📅",
        text:
          newReminders !== undefined && newReminders.length
            ? `${updated.title} — reminders ${fmtReminders(updated.reminders, ctx.timezone)}`
            : `Updated: ${updated.title}`,
      },
    };
  },

  async delete_event(ctx, args) {
    const a = toolSchemas.delete_event.parse(args);
    const event = await findEvent(ctx.userId, a.event);
    if (!event) return { result: { error: `No event matching "${a.event}"` } };
    await db.delete(events).where(and(eq(events.userId, ctx.userId), eq(events.id, event.id)));
    return {
      result: { deleted: event.title },
      toast: { icon: "✕", text: `Removed event: ${event.title}` },
    };
  },

  async create_document(ctx, args) {
    const a = toolSchemas.create_document.parse(args);
    const { project, matched } = await resolveProject(ctx.userId, a.project);
    const [doc] = await db
      .insert(documents)
      .values({
        userId: ctx.userId,
        title: a.title,
        projectId: project?.id,
        sections: (a.sections ?? []).map((s) => ({ heading: s.heading, content: s.content })),
        source: ctx.conversationId ? "spoken" : "typed",
        conversationId: ctx.conversationId,
      })
      .returning();
    return {
      result: { ...docSummary(doc), project: project?.name ?? null, project_match: matched },
      toast: { icon: "✎", text: `New document: ${doc.title}` },
    };
  },

  async list_documents(ctx) {
    const rows = await db
      .select({ doc: documents, projectName: projects.name })
      .from(documents)
      .leftJoin(projects, eq(documents.projectId, projects.id))
      .where(eq(documents.userId, ctx.userId))
      .orderBy(desc(documents.updatedAt));
    return {
      result: rows.map(({ doc, projectName }) => ({
        document_id: doc.id,
        title: doc.title,
        project: projectName,
        headings: doc.sections.map((s) => s.heading),
        last_edited: fmtDate(doc.updatedAt, ctx.timezone),
      })),
    };
  },

  async read_document(ctx, args) {
    const a = toolSchemas.read_document.parse(args);
    const doc = await findDocument(ctx.userId, a.document);
    if (!doc) return { result: { error: `No document matching "${a.document}"` } };

    if (a.section) {
      const idx = findSection(doc.sections, a.section);
      if (idx === -1) {
        return {
          result: {
            error: `No section matching "${a.section}" — sections: ${doc.sections.map((s) => s.heading).join(", ")}`,
          },
        };
      }
      const s = doc.sections[idx];
      const truncated = s.content.length > SECTION_READ_CHARS;
      return {
        result: {
          document_id: doc.id,
          title: doc.title,
          section: { number: idx + 1, heading: s.heading, content: s.content.slice(0, SECTION_READ_CHARS) },
          ...(truncated ? { note: "truncated — very long section" } : {}),
        },
      };
    }

    const totalChars = doc.sections.reduce((n, s) => n + s.content.length, 0);
    if (totalChars > DOC_FULL_READ_CHARS) {
      return {
        result: {
          ...docSummary(doc),
          note: "Long document — headings only. Read one section at a time (read_document with section).",
        },
      };
    }
    return {
      result: {
        document_id: doc.id,
        title: doc.title,
        sections: doc.sections.map((s, i) => ({ number: i + 1, heading: s.heading, content: s.content })),
      },
    };
  },

  async edit_document_section(ctx, args) {
    const a = toolSchemas.edit_document_section.parse(args);
    if (a.content === undefined && a.append === undefined && a.heading === undefined) {
      return { result: { error: "Give content (replace), append, or heading (rename)" } };
    }
    const doc = await findDocument(ctx.userId, a.document);
    if (!doc) return { result: { error: `No document matching "${a.document}"` } };
    const idx = findSection(doc.sections, a.section);
    if (idx === -1) {
      return {
        result: {
          error: `No section matching "${a.section}" — sections: ${doc.sections.map((s) => s.heading).join(", ")}`,
        },
      };
    }
    const old = doc.sections[idx];
    await snapshotDocument(doc, `before edit of "${old.heading}"`);
    const sections = doc.sections.map((s) => ({ ...s }));
    if (a.heading) sections[idx].heading = a.heading;
    if (a.content !== undefined) sections[idx].content = a.content;
    else if (a.append !== undefined)
      sections[idx].content = `${sections[idx].content}${sections[idx].content ? "\n" : ""}${a.append}`;
    const [updated] = await db
      .update(documents)
      .set({ sections, updatedAt: new Date() })
      .where(and(eq(documents.userId, ctx.userId), eq(documents.id, doc.id)))
      .returning();
    const s = updated.sections[idx];
    return {
      result: {
        document_id: updated.id,
        section: { number: idx + 1, heading: s.heading },
        chars_before: old.content.length,
        chars_after: s.content.length,
        revertible: true,
      },
      toast: { icon: "✎", text: `${updated.title}: "${s.heading}" updated` },
    };
  },

  async add_document_section(ctx, args) {
    const a = toolSchemas.add_document_section.parse(args);
    const doc = await findDocument(ctx.userId, a.document);
    if (!doc) return { result: { error: `No document matching "${a.document}"` } };
    await snapshotDocument(doc, `before adding "${a.heading}"`);
    const sections = doc.sections.map((s) => ({ ...s }));
    let at = sections.length;
    if (a.after) {
      const idx = findSection(sections, a.after);
      if (idx !== -1) at = idx + 1;
    }
    sections.splice(at, 0, { heading: a.heading, content: a.content ?? "" });
    const [updated] = await db
      .update(documents)
      .set({ sections, updatedAt: new Date() })
      .where(and(eq(documents.userId, ctx.userId), eq(documents.id, doc.id)))
      .returning();
    return {
      result: { ...docSummary(updated), added: a.heading, revertible: true },
      toast: { icon: "✎", text: `${updated.title}: added "${a.heading}"` },
    };
  },

  async remove_document_section(ctx, args) {
    const a = toolSchemas.remove_document_section.parse(args);
    const doc = await findDocument(ctx.userId, a.document);
    if (!doc) return { result: { error: `No document matching "${a.document}"` } };
    const idx = findSection(doc.sections, a.section);
    if (idx === -1) {
      return {
        result: {
          error: `No section matching "${a.section}" — sections: ${doc.sections.map((s) => s.heading).join(", ")}`,
        },
      };
    }
    const removed = doc.sections[idx];
    await snapshotDocument(doc, `before removing "${removed.heading}"`);
    const sections = doc.sections.filter((_, i) => i !== idx);
    const [updated] = await db
      .update(documents)
      .set({ sections, updatedAt: new Date() })
      .where(and(eq(documents.userId, ctx.userId), eq(documents.id, doc.id)))
      .returning();
    return {
      result: { ...docSummary(updated), removed: removed.heading, revertible: true },
      toast: { icon: "✕", text: `${updated.title}: removed "${removed.heading}"` },
    };
  },

  async revert_document(ctx, args) {
    const a = toolSchemas.revert_document.parse(args);
    const doc = await findDocument(ctx.userId, a.document);
    if (!doc) return { result: { error: `No document matching "${a.document}"` } };
    const [latest] = await db
      .select()
      .from(documentVersions)
      .where(
        and(eq(documentVersions.userId, ctx.userId), eq(documentVersions.documentId, doc.id))
      )
      .orderBy(desc(documentVersions.savedAt))
      .limit(1);
    if (!latest) return { result: { error: `"${doc.title}" has no earlier version to revert to` } };
    // snapshot the current state too, so a revert is itself revertible
    await snapshotDocument(doc, "before revert");
    const [updated] = await db
      .update(documents)
      .set({ title: latest.title, sections: latest.sections, updatedAt: new Date() })
      .where(and(eq(documents.userId, ctx.userId), eq(documents.id, doc.id)))
      .returning();
    await db
      .delete(documentVersions)
      .where(and(eq(documentVersions.userId, ctx.userId), eq(documentVersions.id, latest.id)));
    return {
      result: { ...docSummary(updated), restored: latest.note ?? "previous version" },
      toast: { icon: "→", text: `${updated.title}: reverted (${latest.note ?? "previous version"})` },
    };
  },

  async update_document(ctx, args) {
    const a = toolSchemas.update_document.parse(args);
    const doc = await findDocument(ctx.userId, a.document);
    if (!doc) return { result: { error: `No document matching "${a.document}"` } };
    const updates: Partial<typeof documents.$inferInsert> = { updatedAt: new Date() };
    let movedTo: string | null | undefined;
    if (a.title) updates.title = a.title;
    if (a.project !== undefined) {
      if (a.project.trim().toLowerCase() === "none") {
        updates.projectId = null;
        movedTo = null;
      } else {
        const res = await resolveProject(ctx.userId, a.project);
        updates.projectId = res.project!.id;
        movedTo = res.project!.name;
      }
    }
    const [updated] = await db
      .update(documents)
      .set(updates)
      .where(and(eq(documents.userId, ctx.userId), eq(documents.id, doc.id)))
      .returning();
    return {
      result: {
        document_id: updated.id,
        title: updated.title,
        ...(movedTo !== undefined ? { project: movedTo } : {}),
      },
      toast: { icon: "✎", text: `Document updated: ${updated.title}` },
    };
  },

  async delete_document(ctx, args) {
    const a = toolSchemas.delete_document.parse(args);
    const doc = await findDocument(ctx.userId, a.document);
    if (!doc) return { result: { error: `No document matching "${a.document}"` } };
    await db
      .delete(documents)
      .where(and(eq(documents.userId, ctx.userId), eq(documents.id, doc.id)));
    return {
      result: { deleted: doc.title },
      toast: { icon: "✕", text: `Deleted document: ${doc.title}` },
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
