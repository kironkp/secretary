// User-scoped data access. Every function takes userId as its first argument
// and filters on it — routes and server components must never query the domain
// tables directly. tests/user-scoping.test.ts proves the isolation.
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  lt,
  ne,
  notInArray,
  or,
} from "drizzle-orm";
import { db } from "./index";
import {
  checkins,
  conversations,
  documents,
  documentVersions,
  events,
  memories,
  messages,
  projects,
  tasks,
} from "./schema";
import { dayRangeInTz } from "@/lib/time";

const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;

// Pending suggestions (source='suggested', status='inbox') wait in their own
// zone — they must not count as real tasks in strips or briefings.
const notPendingSuggestion = or(ne(tasks.source, "suggested"), ne(tasks.status, "inbox"));

export function getTasks(userId: string) {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, userId))
    .orderBy(asc(tasks.dueAt), asc(tasks.createdAt));
}

export function getProjects(userId: string) {
  return db.select().from(projects).where(eq(projects.userId, userId));
}

export function getEvents(userId: string) {
  return db.select().from(events).where(eq(events.userId, userId)).orderBy(asc(events.startsAt));
}

/** Events with their project name — events are peers of tasks in every view. */
export function getEventsWithProject(userId: string) {
  return db
    .select({ event: events, projectName: projects.name })
    .from(events)
    .leftJoin(projects, eq(events.projectId, projects.id))
    .where(eq(events.userId, userId))
    .orderBy(asc(events.startsAt));
}

export function getConversations(userId: string) {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(asc(conversations.startedAt));
}

export function getMessages(userId: string, conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId)))
    .orderBy(asc(messages.createdAt));
}

/** Data for the always-visible header strip: next event · #overdue · #due today. */
export async function getTodayStrip(userId: string, timezone: string) {
  const now = new Date();
  const { end } = dayRangeInTz(timezone, now);

  const [overdue] = await db
    .select({ n: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.status, [...OPEN_STATUSES]),
        notPendingSuggestion,
        isNotNull(tasks.dueAt),
        lt(tasks.dueAt, now)
      )
    );

  const [dueToday] = await db
    .select({ n: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.status, [...OPEN_STATUSES]),
        notPendingSuggestion,
        gte(tasks.dueAt, now),
        lt(tasks.dueAt, end)
      )
    );

  const [nextEvent] = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), gte(events.startsAt, now)))
    .orderBy(asc(events.startsAt))
    .limit(1);

  return {
    overdueCount: overdue?.n ?? 0,
    dueTodayCount: dueToday?.n ?? 0,
    nextEvent: nextEvent ?? null,
  };
}

/** Tasks joined with project + originating conversation, for dashboard views. */
export function getTasksWithContext(userId: string) {
  return db
    .select({
      task: tasks,
      projectName: projects.name,
      projectColor: projects.color,
      fromConversationAt: conversations.startedAt,
    })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .leftJoin(conversations, eq(tasks.createdFromConversationId, conversations.id))
    .where(eq(tasks.userId, userId))
    .orderBy(asc(tasks.dueAt), desc(tasks.createdAt));
}

/** Most recent conversation (with messages) to restore the chat thread. */
export async function getLatestConversation(userId: string) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.startedAt))
    .limit(1);
  if (!conv) return null;
  return { conversation: conv, messages: await getMessages(userId, conv.id) };
}

export async function getConversationWithMessages(userId: string, id: string) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .limit(1);
  if (!conv) return null;
  return { conversation: conv, messages: await getMessages(userId, id) };
}

export function getMemories(userId: string) {
  return db
    .select()
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(desc(memories.createdAt));
}

/** Check-ins joined with their task title, newest first — the accountability log. */
export function getCheckinsWithTask(userId: string, limit = 100) {
  return db
    .select({ checkin: checkins, taskTitle: tasks.title })
    .from(checkins)
    .innerJoin(tasks, eq(checkins.taskId, tasks.id))
    .where(eq(checkins.userId, userId))
    .orderBy(desc(checkins.at))
    .limit(limit);
}

/** Recent conversations each with their full transcript, newest first. */
export async function getTranscripts(userId: string, limit = 20) {
  const convs = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.startedAt))
    .limit(limit);
  if (convs.length === 0) return [];
  const msgs = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        inArray(
          messages.conversationId,
          convs.map((c) => c.id)
        )
      )
    )
    .orderBy(asc(messages.createdAt));
  return convs.map((c) => ({
    conversation: c,
    messages: msgs.filter((m) => m.conversationId === c.id),
  }));
}

/** Cross-entity search: tasks, events, memories, and past messages. */
export async function searchAll(userId: string, query: string) {
  const q = `%${query}%`;
  const [taskRows, eventRows, memoryRows, messageRows] = await Promise.all([
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.userId, userId), or(ilike(tasks.title, q), ilike(tasks.notes, q))))
      .orderBy(desc(tasks.updatedAt))
      .limit(20),
    db
      .select()
      .from(events)
      .where(and(eq(events.userId, userId), or(ilike(events.title, q), ilike(events.location, q))))
      .orderBy(desc(events.startsAt))
      .limit(20),
    db
      .select()
      .from(memories)
      .where(and(eq(memories.userId, userId), ilike(memories.fact, q)))
      .orderBy(desc(memories.createdAt))
      .limit(20),
    db
      .select()
      .from(messages)
      .where(and(eq(messages.userId, userId), ilike(messages.content, q)))
      .orderBy(desc(messages.createdAt))
      .limit(20),
  ]);
  return { tasks: taskRows, events: eventRows, memories: memoryRows, messages: messageRows };
}

/** Documents with their project name, newest-edited first. */
export function getDocumentsWithProject(userId: string) {
  return db
    .select({ doc: documents, projectName: projects.name })
    .from(documents)
    .leftJoin(projects, eq(documents.projectId, projects.id))
    .where(eq(documents.userId, userId))
    .orderBy(desc(documents.updatedAt));
}

/** One document + its version history (for the document page). */
export async function getDocumentDetail(userId: string, id: string) {
  const [row] = await db
    .select({ doc: documents, projectName: projects.name })
    .from(documents)
    .leftJoin(projects, eq(documents.projectId, projects.id))
    .where(and(eq(documents.id, id), eq(documents.userId, userId)))
    .limit(1);
  if (!row) return null;
  const versions = await db
    .select()
    .from(documentVersions)
    .where(and(eq(documentVersions.userId, userId), eq(documentVersions.documentId, id)))
    .orderBy(desc(documentVersions.savedAt));
  return { ...row, versions };
}

export function getOpenTaskCount(userId: string) {
  return db
    .select({ n: count() })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), notInArray(tasks.status, ["done", "dropped"])))
    .then((r) => r[0]?.n ?? 0);
}
