// Tool executor — the secretary's hands. Every function is user-scoped; the
// voice path reaches it via POST /api/secretary/tools, the text path calls
// executeTool directly inside /api/chat.
import { and, count, desc, eq, gte, ilike, inArray, isNotNull, lt, ne, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { matchProjectName } from "@/lib/project-names";
import {
  checkins,
  clarifications,
  documents,
  documentVersions,
  entities,
  events,
  expectations,
  memories,
  messages,
  pipelineTemplates,
  projects,
  tasks,
  usage,
  user as userTable,
  type DocSection,
} from "@/lib/db/schema";
import { standingCheckins } from "@/lib/db/schema";
import { DAY_NAMES, daysInWords, findCheckin, localDay, markAsked } from "./checkins";
import { canvasSnapshots, layoutPreferences } from "@/lib/db/schema";
import { latestSnapshot, paintCanvas, readComposition } from "@/lib/canvas/painter";
import {
  applyCanvasOps,
  compositionToMarkup,
  describeComposition,
  redoCanvas,
  undoCanvas,
  type CanvasOp,
} from "@/lib/canvas/composition";
import { resolveReference } from "@/lib/canvas/focus";
import {
  addWish,
  approveProposal,
  enqueueBuild,
  listDynamicComponents,
  rejectProposal,
} from "@/lib/layout/slow-loop";
import { dayRangeInTz } from "@/lib/time";
import { defaultPlan, sectionKey, type LayoutPlan, type PlanSection } from "@/lib/layout/plan";
import { getPlanHead, getPreferences, savePlanAsHead } from "@/lib/layout/plan-store";
import { REGISTRY_COMPONENTS, REGISTRY_VERSION } from "@/lib/layout/registry";
import { computeSignals } from "@/lib/layout/signals";
import { applyBans, validatePlan } from "@/lib/layout/validator";
import { setAsideInWords } from "@/components/today/copy";
import { QUESTION_KINDS } from "@/lib/understanding/types";
import { findDuplicate, findDuplicateEvent } from "./dedupe";
import { clearExpectationsFor } from "./expectations";
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
  /**
   * The kind of call a voice tool runs in, when it is not an ordinary one:
   * "interview" is the orb on the Interview tab (lib/secretary/interview-voice.ts),
   * where answer_question also returns the next question to ask.
   */
  surface?: "interview";
};

/** UI-only side channel (SPEC §7.6 auto-open): the shell acts on it; it never
 *  reaches the model — only `result` is serialized into the tool result. */
export type ToolUIAction = { type: "show_canvas" };

export type ToolOutcome = {
  result: unknown;
  toast?: { icon: string; text: string };
  uiAction?: ToolUIAction;
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

  // The matching itself is shared with the understanding validator
  // (lib/project-names.ts), so a set_project name it accepts lands here.
  const hit = matchProjectName(name, all.map((p) => p.name));
  if (hit) return { project: all[hit.index], matched: hit.matched };

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
      // A re-issued create that names a project must not silently drop it:
      // fill a BLANK project on the existing task. Fill-only — a project
      // already set is never overwritten by a guard match.
      let filedUnder: string | null = null;
      if (a.project && !twin.projectId) {
        const { project } = await resolveProject(ctx.userId, a.project);
        if (project) {
          await db
            .update(tasks)
            .set({ projectId: project.id, updatedAt: new Date() })
            .where(and(eq(tasks.userId, ctx.userId), eq(tasks.id, twin.id)));
          filedUnder = project.name;
        }
      }
      return {
        result: {
          task_id: twin.id,
          title: twin.title,
          already_existed: true,
          ...(filedUnder ? { project: filedUnder } : {}),
          note: filedUnder
            ? `An open task with this title already existed — nothing was created; it's now filed under "${filedUnder}". Use update_task for other changes.`
            : "An open task with this title already exists — nothing was created. Use update_task to change it.",
        },
        ...(filedUnder
          ? { toast: { icon: "→", text: `Moved: ${twin.title} → ${filedUnder}` } }
          : {}),
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
        stakes: a.stakes,
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
      // resolveProject maps the "no project" sentinels (none/null/unfiled/…)
      // to null — that means unfile here, never a null-deref crash.
      const res = await resolveProject(ctx.userId, a.project);
      updates.projectId = res.project?.id ?? null;
      movedTo = res.project?.name ?? null;
      projectMatch = res.matched;
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
    if (a.stakes !== undefined) updates.stakes = a.stakes === "" ? null : a.stakes;
    // SPEC §11: a blocked task carries WHY. An explicit value wins; otherwise
    // any status that isn't "blocked" clears the blocker — an item that moved
    // is no longer stuck on what it was stuck on, and a stale reason spoken
    // aloud is worse than none.
    if (a.blocked_reason !== undefined) {
      updates.blockedReason = a.blocked_reason === "" ? null : a.blocked_reason;
    } else if (a.status && a.status !== "blocked") {
      updates.blockedReason = null;
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

    // A user report on this task clears its open expectations SILENTLY
    // (SPEC §11) — status changes, postpones, and stage advances all count.
    if (postponed || a.status || stageAdvanced) {
      await clearExpectationsFor(ctx.userId, task.id);
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
        ...(updated.blockedReason ? { blocked_reason: updated.blockedReason } : {}),
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
          : a.status === "dropped"
            ? { icon: "✕", text: `Dropped: ${updated.title}` }
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
      // done is a signal like any other: whatever it was stuck on, it isn't now
      .set({ status: "done", completedAt: new Date(), blockedReason: null, updatedAt: new Date() })
      .where(and(eq(tasks.userId, ctx.userId), eq(tasks.id, task.id)))
      .returning();
    await db.insert(checkins).values({
      userId: ctx.userId,
      taskId: task.id,
      type: "user_update",
      note: "Marked done",
    });
    await clearExpectationsFor(ctx.userId, task.id);
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
      // same sentinel handling as update_task: null resolution = unfile
      const res = await resolveProject(ctx.userId, a.project);
      updates.projectId = res.project?.id ?? null;
      movedTo = res.project?.name ?? null;
      projectMatch = res.matched;
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
      // same sentinel handling as update_task: null resolution = unfile
      const res = await resolveProject(ctx.userId, a.project);
      updates.projectId = res.project?.id ?? null;
      movedTo = res.project?.name ?? null;
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

  async set_checkin(ctx, args) {
    const a = toolSchemas.set_checkin.parse(args);
    const days = [...new Set(a.days.map((d) => DAY_NAMES.indexOf(d)))].sort();
    const same = await findCheckin(ctx.userId, a.question);
    if (same && same.question.toLowerCase() === a.question.trim().toLowerCase()) {
      await db.update(standingCheckins).set({ days }).where(eq(standingCheckins.id, same.id));
    } else {
      await db.insert(standingCheckins).values({ userId: ctx.userId, question: a.question.trim(), days });
    }
    return {
      result: {
        saved: true,
        question: a.question.trim(),
        asked_on: daysInWords(days),
        note: "A check-in, not a task: nothing was added to any list and nothing will buzz the phone. It comes up in conversation on those days.",
      },
      toast: { icon: "◆", text: `Check-in: ${daysInWords(days)}` },
    };
  },

  async remove_checkin(ctx, args) {
    const a = toolSchemas.remove_checkin.parse(args);
    const row = await findCheckin(ctx.userId, a.checkin);
    if (!row) return { result: { error: `No check-in matching "${a.checkin}"` } };
    await db.delete(standingCheckins).where(and(eq(standingCheckins.userId, ctx.userId), eq(standingCheckins.id, row.id)));
    return { result: { removed: true, question: row.question } };
  },

  async checkin_asked(ctx, args) {
    const a = toolSchemas.checkin_asked.parse(args);
    const row = await findCheckin(ctx.userId, a.checkin);
    if (!row) return { result: { error: `No check-in matching "${a.checkin}"` } };
    await markAsked(ctx.userId, row.id, localDay(ctx.timezone).date);
    return { result: { ok: true } };
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

  // The Siri-asks-ChatGPT move: the realtime mouth (or chat) phones the
  // Claude brain for questions that need genuine analysis. Effort capped at
  // medium — a caller is waiting on the line.
  async consult_brain(ctx, args) {
    const a = toolSchemas.consult_brain.parse(args);
    const { anthropicFor, brainSettings, claudeBrainEnabled } = await import("@/lib/anthropic");
    const client = claudeBrainEnabled() ? await anthropicFor(ctx.userId) : null;
    if (!client) {
      return {
        result: {
          unavailable: true,
          note: "The deep-reasoning brain isn't connected — the user can connect their Claude account in Settings.",
        },
      };
    }
    const { model } = await brainSettings(ctx.userId);
    const { buildBriefing } = await import("./briefing");
    const briefing = await buildBriefing(ctx.userId, ctx.timezone);
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      output_config: { effort: "medium" },
      system:
        "You are the deep-reasoning brain behind a voice secretary. The secretary relays your answer ALOUD on a phone call: answer the question directly and completely in plain prose — no markdown, no headers — in under 150 words. Lead with the answer, then the one or two reasons that matter.",
      messages: [
        {
          role: "user",
          content: [
            `USER'S CURRENT SITUATION (briefing):\n${briefing.text}`,
            a.context ? `CONVERSATION CONTEXT:\n${a.context}` : "",
            `QUESTION:\n${a.question}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      return { result: { unavailable: true, note: "The brain declined that one." } };
    }
    const answer = response.content
      .filter((b): b is Extract<(typeof response.content)[number], { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .slice(0, 1600);
    await db.insert(usage).values({
      userId: ctx.userId,
      kind: "consult",
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    });
    return { result: { answer }, toast: { icon: "◆", text: "Consulted the brain" } };
  },

  // The upward cycle: a missing ability becomes a shop request. Plan-mode
  // Claude Code drafts, the user approves, a verified build lands. This tool
  // is why "I can't do that" is never the end of the sentence.
  async request_capability(ctx, args) {
    const a = toolSchemas.request_capability.parse(args);
    const { fileRequest } = await import("@/lib/shop/shop");
    const res = await fileRequest(ctx.userId, a.need, a.context, ctx.conversationId);
    // A shipped twin means the ability is ALREADY IN THE APP. Saying "I'll send
    // that to the shop" here is how the same feature got built more than once
    // while the user watched — so the tool result has to correct the model
    // rather than quietly confirm.
    if (res.alreadyExists) {
      return {
        result: {
          request_id: res.id,
          status: "shipped",
          already_exists: true,
          note: "This ALREADY EXISTS — it was built and shipped. Do NOT say you can't do it and do NOT file it again. Tell the user it's already there, say plainly how to use it, and if it isn't working for them treat that as a BUG worth describing, not a missing feature.",
        },
        toast: { icon: "✓", text: "Already built — nothing to file" },
      };
    }
    return {
      result: {
        request_id: res.id,
        status: res.status,
        already_filed: res.deduped,
        note: res.deduped
          ? `Already in the shop (${res.status}) — same ask, already tracked. Don't file it twice.`
          : res.queued
            ? "Filed — the shop is mid-job; this one is next in line."
            : "Filed — the shop is drafting a plan now. The user approves it in a later session or in Settings.",
      },
      toast: { icon: "▣", text: res.deduped ? "Already in the shop" : `Sent to the shop: ${a.need.slice(0, 60)}` },
    };
  },

  async review_capability(ctx, args) {
    const a = toolSchemas.review_capability.parse(args);
    const { approveRequest, findRequest, rejectRequest, reviseRequest } = await import(
      "@/lib/shop/shop"
    );
    const req = await findRequest(ctx.userId, a.request);
    if (!req) return { result: { error: `No shop request matching "${a.request}"` } };
    if (a.decision === "reject") {
      await rejectRequest(ctx.userId, req.id);
      return {
        result: { rejected: true, need: req.need },
        toast: { icon: "✓", text: "Shop request closed" },
      };
    }
    if (a.decision === "revise") {
      if (!a.feedback?.trim()) {
        return { result: { error: "revise needs feedback — what should change in the plan?" } };
      }
      const res = await reviseRequest(ctx.userId, req.id, a.feedback.trim());
      if (!res.ok) return { result: { error: res.error } };
      return {
        result: {
          revising: true,
          need: req.need,
          note: "The shop is redrafting the plan with that feedback — the user gets a push when the new plan is ready.",
        },
        toast: { icon: "✎", text: `Revising plan: ${req.need.slice(0, 50)}` },
      };
    }
    const res = await approveRequest(ctx.userId, req.id);
    if (!res.ok) return { result: { error: res.error } };
    return {
      result: {
        approved: true,
        need: req.need,
        note: res.queued
          ? "Approved and queued — the build starts the moment the current shop job finishes, and lands once tests pass."
          : "Build started — it lands automatically once the test suite passes (typically 15-40 minutes).",
      },
      toast: { icon: "▣", text: `Building: ${req.need.slice(0, 60)}` },
    };
  },

  async search_history(ctx, args) {
    const a = toolSchemas.search_history.parse(args);
    const after = a.after ? new Date(a.after) : null;
    const before = a.before ? new Date(a.before) : null;
    const conds = [eq(messages.userId, ctx.userId), ilike(messages.content, `%${a.query}%`)];
    if (after && !isNaN(after.getTime())) conds.push(gte(messages.createdAt, after));
    if (before && !isNaN(before.getTime())) conds.push(lt(messages.createdAt, before));
    const rows = await db
      .select({
        content: messages.content,
        role: messages.role,
        mode: messages.mode,
        conversationId: messages.conversationId,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.createdAt))
      .limit(10);
    return {
      result: rows.map((m) => ({
        when: fmtDate(m.createdAt, ctx.timezone),
        mode: m.mode,
        role: m.role,
        snippet: m.content.slice(0, 200),
        conversation_id: m.conversationId,
      })),
    };
  },

  // --- Thin voice tools (SPEC §11 fast/slow split): delegate to the fat
  // handlers so voice and text write the SAME store the same way. ---

  async log_status(ctx, args) {
    const a = toolSchemas.log_status.parse(args);
    if (a.signal === "done") return handlers.complete_task(ctx, { task: a.task });
    const outcome = await handlers.update_task(ctx, {
      task: a.task,
      ...(a.signal === "started" ? { status: "in_progress" } : {}),
      ...(a.signal === "blocked" ? { status: "blocked" } : {}),
      ...(a.signal === "dropped" ? { status: "dropped" } : {}),
      ...(a.signal === "postponed" && a.new_due_at ? { due_at: a.new_due_at } : {}),
      ...(a.note ? { notes: a.note } : {}),
      // SPEC §11: on a block the note IS the reason — it lands in its own
      // field so later sessions can say what the thing is waiting on instead
      // of reciting the status word. (notes is free-form and the next
      // amend_task overwrites it; this survives.)
      ...(a.signal === "blocked" && a.note ? { blocked_reason: a.note } : {}),
    });
    // A blocker with no reason is a status word waiting to be recited. Steer
    // the mouth to ask NOW — same idiom as queue_clarification's note, but the
    // opposite instruction, and licensed only because the question is about
    // the item just spoken.
    const result = outcome.result as { error?: string } | null;
    if (a.signal === "blocked" && !a.note && result && !result.error) {
      return {
        ...outcome,
        result: {
          ...result,
          note: "Blocked with no reason recorded. Ask right now, in one line — 'what's it waiting on?' — then log_status blocked again with their answer as the note. Do NOT queue this one; it's about what was just said. If they're mid-thought or asked you to hold, let it wait.",
        },
      };
    }
    return outcome;
  },

  async create_commitment(ctx, args) {
    const a = toolSchemas.create_commitment.parse(args);
    return handlers.create_task(ctx, {
      title: a.title,
      due_at: a.due_at,
      project: a.project,
      stakes: a.stakes,
    });
  },

  async amend_task(ctx, args) {
    const a = toolSchemas.amend_task.parse(args);
    return handlers.update_task(ctx, {
      task: a.task,
      ...(a.project !== undefined ? { project: a.project } : {}),
      ...(a.title ? { title: a.title } : {}),
      ...(a.note ? { notes: a.note } : {}),
    });
  },

  async schedule_checkin(ctx, args) {
    const a = toolSchemas.schedule_checkin.parse(args);
    return handlers.create_expectation(ctx, {
      commitment: a.commitment,
      expected_update_by: a.expected_update_by,
      task: a.task,
      on_miss: "nag",
    });
  },

  // --- Agent layer (SPEC §11): persona + pipeline templates ---

  async update_persona(ctx, args) {
    const a = toolSchemas.update_persona.parse(args);
    const [row] = await db
      .select({ persona: userTable.persona })
      .from(userTable)
      .where(eq(userTable.id, ctx.userId));
    const current = row?.persona ?? {};
    const next = {
      ...current,
      ...(a.name && { name: a.name.trim() }),
      ...(a.sass && { sass: a.sass as 1 | 2 | 3 | 4 | 5 }),
      ...(a.strictness && { strictness: a.strictness }),
      ...(a.tone && { tone: a.tone }),
      ...(a.praise && { praise: a.praise }),
      ...(a.followup_aggressiveness && { followup_aggressiveness: a.followup_aggressiveness }),
      ...(a.quiet_hours_start && a.quiet_hours_end
        ? { quiet_hours: { start: a.quiet_hours_start, end: a.quiet_hours_end } }
        : {}),
    };
    await db.update(userTable).set({ persona: next }).where(eq(userTable.id, ctx.userId));
    return {
      result: {
        stored: true,
        persona: next,
        note: "Applied from now on, in every conversation and to the nag engine — the user never needs to re-state this.",
      },
      toast: { icon: "✓", text: "Persona updated" },
    };
  },

  async queue_clarification(ctx, args) {
    const a = toolSchemas.queue_clarification.parse(args);
    const [row] = await db
      .insert(clarifications)
      .values({ userId: ctx.userId, kind: a.kind, question: a.question, context: a.context })
      .returning();
    return {
      result: {
        queued: true,
        clarification_id: row.id,
        note: "Held for a natural pause — do not ask now unless one just arrived.",
      },
    };
  },

  async resolve_clarification(ctx, args) {
    const a = toolSchemas.resolve_clarification.parse(args);
    // The voice-flow kinds only, in SQL and not just in the prompt: a
    // question of the three understanding kinds closes through
    // answer_question (its writes, the supersede, the record's asked entry),
    // and a text match here must never resolve one past all of that.
    const rows = await db
      .select()
      .from(clarifications)
      .where(
        and(
          eq(clarifications.userId, ctx.userId),
          inArray(clarifications.status, ["open", "asked"]),
          notInArray(clarifications.kind, [...QUESTION_KINDS])
        )
      );
    const needle = a.question.toLowerCase();
    const target =
      rows.find((c) => c.question.toLowerCase().includes(needle)) ??
      rows.find((c) => needle.includes(c.question.toLowerCase().slice(0, 40)));
    if (!target) return { result: { error: `No open clarification matching "${a.question}"` } };

    if (target.entityId) {
      if (a.action === "same_entity" && target.subject) {
        const [ent] = await db.select().from(entities).where(eq(entities.id, target.entityId));
        if (ent) {
          await db
            .update(entities)
            .set({
              aliases: [...new Set([...ent.aliases, target.subject])],
              confirmed: true,
              lastMentionedAt: new Date(),
            })
            .where(eq(entities.id, ent.id));
        }
      } else if (a.action === "different_person" && target.subject) {
        await db.insert(entities).values({
          userId: ctx.userId,
          name: a.corrected_name ?? target.subject,
          kind: "person",
          confirmed: true,
          notes: a.answer,
        });
      } else if (a.action === "spelling_confirmed") {
        await db.update(entities).set({ confirmed: true }).where(eq(entities.id, target.entityId));
      } else if (a.action === "spelling_corrected" && a.corrected_name) {
        await db
          .update(entities)
          .set({ name: a.corrected_name, confirmed: true })
          .where(eq(entities.id, target.entityId));
      }
    }
    await db
      .update(clarifications)
      .set({ status: "resolved", resolution: `${a.action}: ${a.answer}`, resolvedAt: new Date() })
      .where(and(eq(clarifications.userId, ctx.userId), eq(clarifications.id, target.id)));
    return { result: { resolved: true, action: a.action } };
  },

  // docs/understanding/SPEC.md §6: the spoken answer to an OPEN QUESTIONS
  // row. The writes are the stored answer's, applied by answerQuestion through
  // these same handlers, so a voice answer and a tap are one operation. The
  // import is lazy because lib/understanding/answer.ts imports executeTool
  // from this module: a static import would be a cycle at load time.
  async answer_question(ctx, args) {
    const a = toolSchemas.answer_question.parse(args);
    const { answerQuestion, answerInOwnWords, rerunAfterAnswer } = await import(
      "@/lib/understanding/answer"
    );
    const { InterpretError } = await import("@/lib/understanding/interpret");
    // An interview call (the orb on the Interview tab) moves straight on:
    // the result carries the next question, chosen against the queue order
    // as it stood before this answer, so the model asks it without another
    // round trip. Read lazily for the same cycle reason as above.
    const interview =
      ctx.surface === "interview" ? await import("@/lib/secretary/interview-voice") : null;
    const before = interview
      ? (await (await import("@/lib/understanding/questions")).listQuestions(ctx.userId)).map((q) => q.id)
      : [];
    const withNext = async (result: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (!interview) return result;
      const { next, remaining } = await interview.nextInterviewQuestion(ctx.userId, a.question_id, before);
      return {
        ...result,
        next_question: next ? interview.questionLine(next) : null,
        questions_left: remaining,
      };
    };
    let outcome: Awaited<ReturnType<typeof answerQuestion>>;
    if (a.answer_id) {
      // Words given alongside a listed answer ride as its note when there
      // is none: the user said something extra, not something else.
      outcome = await answerQuestion(
        ctx.userId,
        ctx.timezone,
        a.question_id,
        a.answer_id,
        a.note ?? a.own_words,
        "voice"
      );
    } else if (a.own_words?.trim()) {
      // The user's own words: one model call reads them against the
      // question (SPEC §6, lib/understanding/interpret.ts). A read that
      // fails writes nothing; the caller can offer the listed answers.
      try {
        outcome = await answerInOwnWords(ctx.userId, ctx.timezone, a.question_id, a.own_words, "voice");
      } catch (e) {
        if (!(e instanceof InterpretError)) throw e;
        // The error's message is the user's line: plain, or the provider's
        // when reading is paused, so the secretary can say why.
        return {
          result: { error: `${e.message} Offer the listed answers, or try again.` },
        };
      }
    } else {
      return {
        result: {
          error: "Give answer_id (one of the ids printed after \"answers:\") or own_words (what the user said instead)",
        },
      };
    }
    if (outcome.status === "not-found") {
      return { result: { error: `No question with id ${a.question_id} in the briefing's OPEN QUESTIONS` } };
    }
    if (outcome.status === "not-open") {
      // Answered on the screen a moment ago, most likely: move on all the same.
      return { result: await withNext({ error: "That question was already answered" }) };
    }
    if (outcome.status === "bad-answer") {
      return {
        result: {
          error: a.answer_id
            ? `No answer with id ${a.answer_id} on that question; use one of the ids printed after "answers:"`
            : "Nothing to read in own_words",
        },
      };
    }
    // SPEC §6 step 4: the project re-runs at once so the next screen reflects
    // the answer, but the call never waits on a model. rerunAfterAnswer
    // swallows its own errors; the catch is for the import path.
    if (outcome.projectId) {
      void rerunAfterAnswer(ctx.userId, outcome.projectId, ctx.timezone).catch((e: unknown) =>
        console.error(
          "understanding: re-run after a spoken answer failed:",
          e instanceof Error ? e.message : e
        )
      );
    }
    // The pending questions this answer set aside because it changed a row
    // they rested on (lib/understanding/supersede.ts). Said only when there
    // were any, so the receipt stays honest, and in the words the screen's
    // receipt uses (components/today/copy.ts): one answer, one sentence.
    const setAside = setAsideInWords(outcome.superseded.length);
    return {
      result: await withNext({
        status: outcome.status,
        applied: outcome.applied,
        failed: outcome.failed,
        superseded: outcome.superseded,
        ...(setAside ? { setAside } : {}),
        // The one sentence the reading came back with, for the model to
        // relay in its own register; absent for a listed answer.
        ...(outcome.reply ? { reply: outcome.reply } : {}),
      }),
      toast: {
        icon: "check",
        text: setAside ? `Answered, ${outcome.superseded.length} set aside` : "Answered",
      },
    };
  },

  async create_expectation(ctx, args) {
    const a = toolSchemas.create_expectation.parse(args);
    const when = parseWhen(a.expected_update_by);
    if (!when) return { result: { error: `Bad expected_update_by "${a.expected_update_by}"` } };
    const task = a.task ? await findTask(ctx.userId, a.task) : null;
    const [row] = await db
      .insert(expectations)
      .values({
        userId: ctx.userId,
        taskId: task?.id ?? null,
        commitment: a.commitment,
        expectedUpdateBy: when,
        onMiss: a.on_miss ?? "nag",
      })
      .returning();
    return {
      result: {
        expectation_id: row.id,
        note: "Held. A user report clears it silently; a miss opens the next session.",
      },
    };
  },

  async save_pipeline_template(ctx, args) {
    const a = toolSchemas.save_pipeline_template.parse(args);
    for (const [i, step] of a.steps.entries()) {
      if (step.blocked_by != null && step.blocked_by >= i) {
        return { result: { error: `Step ${i} ("${step.name}") can only be blocked by an EARLIER step` } };
      }
    }
    const existing = await db
      .select()
      .from(pipelineTemplates)
      .where(and(eq(pipelineTemplates.userId, ctx.userId), ilike(pipelineTemplates.name, a.name)));
    if (existing.length) {
      await db
        .update(pipelineTemplates)
        .set({ steps: a.steps, recurrence: a.recurrence ?? null })
        .where(eq(pipelineTemplates.id, existing[0].id));
    } else {
      await db.insert(pipelineTemplates).values({
        userId: ctx.userId,
        name: a.name,
        steps: a.steps,
        recurrence: a.recurrence ?? null,
      });
    }
    return {
      result: { saved: true, name: a.name, steps: a.steps.length },
      toast: { icon: "✓", text: `Pipeline "${a.name}" saved` },
    };
  },

  async apply_pipeline(ctx, args) {
    const a = toolSchemas.apply_pipeline.parse(args);
    const task = await findTask(ctx.userId, a.task);
    if (!task) return { result: { error: `No task matching "${a.task}"` } };
    const templates = await db
      .select()
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.userId, ctx.userId));
    const needle = a.template.toLowerCase();
    const template =
      templates.find((t) => t.name.toLowerCase() === needle) ??
      templates.find(
        (t) => t.name.toLowerCase().includes(needle) || needle.includes(t.name.toLowerCase())
      );
    if (!template) return { result: { error: `No pipeline template matching "${a.template}"` } };
    const anchor = a.anchor_date ? new Date(a.anchor_date) : new Date();
    if (Number.isNaN(anchor.getTime()))
      return { result: { error: `Bad anchor_date "${a.anchor_date}"` } };
    const stages = template.steps.map((s) => ({
      name: s.name,
      done: false,
      due_at:
        s.offset_days != null
          ? new Date(anchor.getTime() + s.offset_days * 86400000).toISOString().slice(0, 10)
          : null,
      blocked_by: s.blocked_by ?? null,
    }));
    await db
      .update(tasks)
      .set({
        stages,
        ...(template.recurrence ? { recurrence: template.recurrence } : {}),
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, task.id));
    return {
      result: {
        applied: true,
        task_id: task.id,
        stages,
        note: "Stage state is now the source of truth for 'where am I' on this task.",
      },
      toast: { icon: "✓", text: `Pipeline applied to "${task.title}"` },
    };
  },

  // --- Layout tools (SPEC §7.5 tier 1). All edits pass the SAME validator as
  // planner output; user-initiated changes apply immediately (invariant 3). ---

  async get_current_plan(ctx) {
    const [head, prefs, signals, dynamic] = await Promise.all([
      getPlanHead(ctx.userId),
      getPreferences(ctx.userId),
      computeSignals(ctx.userId),
      listDynamicComponents(ctx.userId),
    ]);
    const plan = head ? (head.spec as LayoutPlan) : defaultPlan(signals);
    return {
      result: {
        registry_version: dynamic.length
          ? Math.max(...dynamic.map((d) => d.registryVersion))
          : REGISTRY_VERSION,
        components: [...REGISTRY_COMPONENTS, ...dynamic.map((d) => d.name)],
        sections: plan.sections.map((s, i) => ({ position: i, key: sectionKey(s), ...s })),
        reason_summary: plan.reason_summary ?? null,
        pinned: head?.pinned ?? [],
        preferences: prefs,
      },
    };
  },

  async edit_layout_plan(ctx, args) {
    const a = toolSchemas.edit_layout_plan.parse(args);
    const [head, prefs, signals] = await Promise.all([
      getPlanHead(ctx.userId),
      getPreferences(ctx.userId),
      computeSignals(ctx.userId),
    ]);
    const current = head ? (head.spec as LayoutPlan) : defaultPlan(signals);
    const sections: PlanSection[] = structuredClone(current.sections);

    for (const op of a.operations) {
      if (op.op === "add") {
        const section = { component: op.component, props: op.props } as PlanSection;
        sections.splice(op.at ?? sections.length, 0, section);
        continue;
      }
      const idx = sections.findIndex((s) => sectionKey(s) === op.section);
      if (idx === -1) return { result: { error: `No section "${op.section}" in the current plan` } };
      if (op.op === "remove") sections.splice(idx, 1);
      else if (op.op === "move") {
        const [s] = sections.splice(idx, 1);
        sections.splice(Math.min(op.to, sections.length), 0, s);
      } else if (op.op === "set_props") {
        sections[idx] = { ...sections[idx], props: { ...sections[idx].props, ...op.props } };
      }
    }

    const candidate: LayoutPlan = {
      plan_id: `chat-${Date.now().toString(36)}`,
      reason_summary: current.reason_summary ?? null,
      sections,
    };
    // User-initiated: pins and movement rationing don't constrain the user's
    // own request (invariant 3), but structural rules and preferences still do.
    const dynamic = await listDynamicComponents(ctx.userId);
    const v = validatePlan(candidate, {
      signals,
      previousPlan: current,
      preferences: prefs,
      pinnedSections: [],
      defaultPlan: defaultPlan(signals),
      userInitiated: true,
      dynamicComponents: dynamic.map((d) => d.name),
    });
    if (!v.ok) {
      return {
        result: {
          error: `That change breaks a layout rule: ${v.reasons.join("; ")}. Nothing was changed.`,
        },
      };
    }
    const version = await savePlanAsHead(ctx.userId, v.plan);
    return {
      result: { applied: true, version, sections: v.plan.sections.map((s) => sectionKey(s)) },
      toast: { icon: "layout", text: "Dashboard rearranged" },
    };
  },

  // --- Canvas tools (SPEC §7.6). The canvas never mutates app state; these
  // only write canvas_snapshots. Painting streams into the row, so the tool
  // returns immediately and the Canvas page shows the paint landing live. ---

  async paint_canvas(ctx, args) {
    const a = toolSchemas.paint_canvas.parse(args);
    // Fire-and-stream: don't hold the chat turn hostage to the full render.
    const done = paintCanvas(ctx.userId, a.brief, {
      conversationId: ctx.conversationId,
    }).catch((e) => console.error("paint_canvas failed", e));
    // Give the stream a beat so the snapshot row exists before we answer.
    await Promise.race([done, new Promise((r) => setTimeout(r, 1200))]);
    return {
      result: {
        painting: true,
        note: "Canvas is painting now and is being brought into view on the user's screen automatically — it streams in live (say 'on your screen' in voice).",
      },
      toast: { icon: "🎨", text: "Painting the canvas…" },
      uiAction: { type: "show_canvas" },
    };
  },

  /** Geometry only: the shell rearranges its own furniture. No model call, no
   *  repaint, no new snapshot — rearranging the room is not a new picture. */
  async arrange_canvas(ctx, args) {
    const a = toolSchemas.arrange_canvas.parse(args);
    const latest = await latestSnapshot(ctx.userId);
    const composition = readComposition(latest);
    if (!latest || !composition) {
      return { result: { error: "Nothing on the canvas yet — paint something first." } };
    }
    // Undo/redo are whole-canvas and take no reference — handle them first.
    const rewind = a.operations.find((o) => o.op === "undo" || o.op === "redo");
    if (rewind) {
      const { composition: next, changed, label } =
        rewind.op === "undo" ? undoCanvas(composition) : redoCanvas(composition);
      if (!changed) return { result: { error: label } };
      await db
        .update(canvasSnapshots)
        .set({ composition: next, markup: compositionToMarkup(next) })
        .where(and(eq(canvasSnapshots.id, latest.id), eq(canvasSnapshots.userId, ctx.userId)));
      return {
        result: { [rewind.op]: label },
        uiAction: { type: "show_canvas" },
        toast: { icon: "↺", text: label === "undone" ? "Undone" : "Redone" },
      };
    }

    // Resolve the user's OWN WORDS against shared voice+touch state. Ambiguity
    // is reported with the candidates rather than guessed — especially for
    // remove, where a wrong guess destroys something.
    const seen = describeComposition(composition);
    const focus = composition.focus ?? {};
    const resolved: CanvasOp[] = [];
    for (const op of a.operations) {
      if (op.op === "set_theme") {
        // Flat wire shape → the strict union the composition validates.
        const theme = {
          ...(op.scale !== undefined ? { scale: op.scale } : {}),
          ...(op.density ? { density: op.density } : {}),
          ...(op.font ? { font: op.font } : {}),
          ...(op.accent ? { accent: op.accent } : {}),
          ...(op.radius ? { radius: op.radius } : {}),
        };
        if (Object.keys(theme).length) resolved.push({ op: "set_theme", theme });
        continue;
      }
      if (op.op === "undo" || op.op === "redo") continue; // handled above
      if (!op.id) {
        return { result: { error: `${op.op} needs to say which block — nothing was named.` } };
      }
      const ref = resolveReference(op.id, seen, focus);
      if (!ref.ok) {
        return {
          result: {
            needs_clarification: ref.reason,
            candidates: seen
              .filter((b) => !ref.candidates.length || ref.candidates.includes(b.id))
              .map((b) => `${b.id}: ${b.summary}`),
            say: "Ask which one they mean — name the options in your own words. Do not guess.",
          },
        };
      }
      for (const id of ref.ids) {
        if (op.op === "move") resolved.push({ op: "move", id, to: op.to ?? 0 });
        else if (op.op === "resize") resolved.push({ op: "resize", id, span: op.span ?? "full" });
        else resolved.push({ op: op.op, id });
      }
    }

    const { composition: next, applied, rejected } = applyCanvasOps(composition, resolved);
    if (!applied.length) {
      return {
        result: {
          error: rejected[0]?.reason ?? "Nothing to change.",
          on_canvas: seen.map((b) => `${b.id}: ${b.summary}`),
        },
      };
    }
    await db
      .update(canvasSnapshots)
      .set({ composition: next, markup: compositionToMarkup(next) })
      .where(and(eq(canvasSnapshots.id, latest.id), eq(canvasSnapshots.userId, ctx.userId)));
    return {
      result: { arranged: applied, rejected: rejected.length ? rejected : undefined },
      uiAction: { type: "show_canvas" },
      toast: { icon: "⇄", text: "Canvas rearranged" },
    };
  },
  async edit_canvas(ctx, args) {
    const a = toolSchemas.edit_canvas.parse(args);
    const current = await latestSnapshot(ctx.userId);
    if (!current || !current.markup) {
      return { result: { error: "No canvas yet — use paint_canvas first." } };
    }
    // A paint in flight is seeded with the PREVIOUS canvas, so editing it now
    // would base the change on markup that is about to be replaced — the edit
    // would silently vanish when the paint lands.
    if (current.painting) {
      return {
        result: {
          error:
            "The canvas is still painting. Tell the user it's landing now and ask them to say the change again in a moment, so it applies to the finished canvas.",
        },
      };
    }
    const done = paintCanvas(ctx.userId, a.patch, {
      baseMarkup: current.markup,
      conversationId: ctx.conversationId,
    }).catch((e) => console.error("edit_canvas failed", e));
    await Promise.race([done, new Promise((r) => setTimeout(r, 1200))]);
    return {
      result: {
        painting: true,
        note: "Patch is landing now — the canvas is being brought into view on the user's screen.",
      },
      toast: { icon: "🎨", text: "Updating the canvas…" },
      uiAction: { type: "show_canvas" },
    };
  },

  // Auto-open (SPEC §7.6): pure chrome — writes nothing, paints nothing. The
  // shell reacts to the uiAction; the model only learns the canvas is visible.
  async show_canvas() {
    return {
      result: {
        shown: true,
        note: "The Canvas is coming into view on the user's screen now.",
      },
      uiAction: { type: "show_canvas" as const },
    };
  },

  // --- Slow loop, tier 2 (SPEC §7.5): registry-outside asks become proposals ---

  async request_new_component(ctx, args) {
    const a = toolSchemas.request_new_component.parse(args);
    if (!REGISTRY_COMPONENTS.includes(a.closest_component as never)) {
      return { result: { error: `closest_component must be a registry component` } };
    }
    const signals = await computeSignals(ctx.userId);
    const wish = await addWish(ctx.userId, {
      need: a.sketch ? `${a.need} — ${a.sketch}` : a.need,
      closestComponent: a.closest_component,
      signals: `requested in chat; ${signals.projects.length} active projects`,
      priority: true,
    });
    if (wish.tombstoned) {
      return {
        result: {
          declined: true,
          note: "The user previously rejected this view — don't rebuild it unless they clearly want it back.",
        },
      };
    }
    await enqueueBuild(ctx.userId, wish.id);
    return {
      result: {
        building: true,
        wish_id: wish.id,
        note: "Build started (a few minutes). Now ALSO call paint_canvas with this ask so the user sees something immediately, and tell them the nearest dashboard view stands in meanwhile.",
      },
      toast: { icon: "🛠", text: "Building that view — a few minutes" },
    };
  },

  async review_proposed_component(ctx, args) {
    const a = toolSchemas.review_proposed_component.parse(args);
    if (a.decision === "approve") {
      const res = await approveProposal(ctx.userId, a.name);
      if (!res.ok) return { result: { error: res.error } };
      return {
        result: {
          approved: true,
          registry_version: res.registryVersion,
          note: "Registered — the planner can use it from the next plan on. No restart needed.",
        },
        toast: { icon: "✓", text: `New view "${a.name}" is live` },
      };
    }
    await rejectProposal(ctx.userId, a.name);
    return {
      result: { rejected: true, note: "Tombstoned — this need won't be re-proposed." },
      toast: { icon: "🗑", text: `Proposal "${a.name}" rejected` },
    };
  },

  async set_layout_preference(ctx, args) {
    const a = toolSchemas.set_layout_preference.parse(args);
    const value: Record<string, string> =
      a.kind === "ban_component"
        ? { component: a.component ?? "" }
        : a.kind === "pin_section"
          ? { section: a.section ?? "" }
          : a.kind === "default_variant_for"
            ? { project: a.project ?? "", variant: a.variant ?? "full" }
            : { policy: a.policy ?? "auto" };
    if (Object.values(value).some((v) => !v)) {
      return { result: { error: `Missing fields for ${a.kind}` } };
    }
    if (a.kind === "ban_component" && !REGISTRY_COMPONENTS.includes(value.component as never)) {
      return { result: { error: `Unknown component "${value.component}"` } };
    }

    const existing = await db
      .select()
      .from(layoutPreferences)
      .where(and(eq(layoutPreferences.userId, ctx.userId), eq(layoutPreferences.kind, a.kind)));
    const match = existing.find(
      (row) => JSON.stringify(row.value) === JSON.stringify(value)
    );

    if (a.remove) {
      if (!match) return { result: { error: "No such preference stored" } };
      await db.delete(layoutPreferences).where(eq(layoutPreferences.id, match.id));
      return {
        result: { removed: true, kind: a.kind, value },
        toast: { icon: "layout", text: "Preference removed" },
      };
    }

    if (!match) {
      await db.insert(layoutPreferences).values({ userId: ctx.userId, kind: a.kind, value });
    }

    // F7: the live plan re-renders without a banned component immediately.
    const head = await getPlanHead(ctx.userId);
    if (head) {
      const current = head.spec as LayoutPlan;
      const prefs = await getPreferences(ctx.userId);
      const cleaned = applyBans(current, prefs);
      if (JSON.stringify(cleaned.sections) !== JSON.stringify(current.sections)) {
        await savePlanAsHead(ctx.userId, cleaned);
      }
    }
    return {
      result: { stored: true, kind: a.kind, value, note: "Enforced on every future plan; removable in Settings." },
      toast: { icon: "layout", text: "Layout preference saved" },
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
