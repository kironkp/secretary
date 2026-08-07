// Post-conversation extraction pass (Flow 2, the safety net): a cheap text
// model re-reads the transcript and catches anything the live model didn't log
// via tools. Runs incrementally — only messages after conversations.extractedAt
// are scanned — and everything it writes is deduped and tagged source='inferred'.
import { z } from "zod";
import { and, asc, desc, eq, gt, gte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  checkins,
  conversations,
  events,
  memories,
  tasks,
  usage,
} from "@/lib/db/schema";
import { openai, TEXT_MODEL } from "@/lib/openai";
import { findDuplicate, findDuplicateEvent, titleSimilarity } from "./dedupe";

export const extractionSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
      notes: z.string().nullable(),
      due_at: z.string().nullable().describe("ISO 8601 in the user's timezone, if a deadline was stated"),
    })
  ),
  events: z.array(
    z.object({
      title: z.string(),
      starts_at: z.string().describe("ISO 8601"),
      ends_at: z.string().nullable(),
      location: z.string().nullable(),
    })
  ),
  status_updates: z.array(
    z.object({
      task: z.string().describe("Title (or close fragment) of the existing task"),
      signal: z.enum(["done", "postponed", "started", "dropped"]),
      new_due_at: z.string().nullable().describe("If postponed, the new date, ISO 8601"),
      reason: z.string().nullable(),
    })
  ),
  facts: z.array(z.string().describe("A durable fact about the user worth remembering")),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

const EXTRACTION_PROMPT = `You are an extraction pass over a personal-secretary conversation transcript. Find ONLY items the user actually committed to or stated — never invent.

Return:
- tasks: to-dos/obligations the USER must do, mentioned but plausibly not yet logged.
- events: meetings/appointments/plans with a concrete date or time.
- status_updates: signals about EXISTING tasks — "yeah I sent it" (done), "I'll do it Friday" (postponed + new_due_at), "started on it" (started), "forget that" (dropped). Refer to the task by its title from the KNOWN OPEN TASKS list when possible.
- facts: durable personal facts (names, preferences, constraints) — not one-off logistics.

Anything already in KNOWN OPEN TASKS or KNOWN EVENTS must NOT reappear in tasks/events (report status changes about them via status_updates instead). Dates: resolve relative expressions against the conversation date given. If no timezone-certain time, use 17:00 local. Empty arrays are fine — most conversations produce nothing.`;

const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;

/** Model call: transcript → structured candidates. */
export async function extractFromTranscript(opts: {
  transcript: string;
  timezone: string;
  conversationDate: Date;
  knownTasks: { title: string; dueAt: Date | null }[];
  knownEvents: { title: string; startsAt: Date }[];
}): Promise<{ result: ExtractionResult; inputTokens: number; outputTokens: number }> {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: opts.timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(d);

  const context = [
    `Conversation date: ${fmt(opts.conversationDate)} (timezone ${opts.timezone})`,
    "",
    "KNOWN OPEN TASKS:",
    ...opts.knownTasks.map((t) => `- ${t.title}${t.dueAt ? ` (due ${fmt(t.dueAt)})` : ""}`),
    "",
    "KNOWN EVENTS:",
    ...opts.knownEvents.map((e) => `- ${e.title} (${fmt(e.startsAt)})`),
    "",
    "TRANSCRIPT:",
    opts.transcript,
  ].join("\n");

  const response = await openai.responses.create({
    model: TEXT_MODEL,
    instructions: EXTRACTION_PROMPT,
    input: context,
    text: {
      format: {
        type: "json_schema",
        name: "extraction",
        strict: true,
        schema: z.toJSONSchema(extractionSchema) as Record<string, unknown>,
      },
    },
  });

  return {
    result: extractionSchema.parse(JSON.parse(response.output_text || "{}")),
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };
}

function parseIso(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Apply a (already validated) extraction result to the database: dedupe every
 * candidate against what exists, upsert the rest as source='inferred', and
 * turn status signals into task updates + checkin rows. Pure DB — no model —
 * so tests can drive it with hand-built results.
 */
export async function applyExtraction(
  userId: string,
  conversationId: string,
  result: ExtractionResult
): Promise<{ createdTasks: number; createdEvents: number; updatedTasks: number; savedFacts: number }> {
  const existingOpen = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES])));
  const allRecent = await db
    .select()
    .from(tasks)
    .where(eq(tasks.userId, userId))
    .orderBy(desc(tasks.createdAt))
    .limit(200);
  const now = new Date();
  const upcomingEvents = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), gte(events.startsAt, new Date(now.getTime() - 86400000))));
  const knownFacts = await db.select().from(memories).where(eq(memories.userId, userId));

  let createdTasks = 0;
  let createdEvents = 0;
  let updatedTasks = 0;
  let savedFacts = 0;

  for (const t of result.tasks) {
    const dueAt = parseIso(t.due_at);
    // dedupe against every recent task (done ones included — "book flights"
    // finished yesterday must not come back as a new inferred to-do)
    if (findDuplicate({ title: t.title, dueAt }, allRecent)) continue;
    await db.insert(tasks).values({
      userId,
      title: t.title,
      notes: t.notes ?? undefined,
      dueAt: dueAt ?? undefined,
      status: "todo",
      source: "inferred",
      createdFromConversationId: conversationId,
    });
    createdTasks++;
  }

  for (const e of result.events) {
    const startsAt = parseIso(e.starts_at);
    if (!startsAt) continue;
    if (findDuplicateEvent({ title: e.title, startsAt }, upcomingEvents)) continue;
    await db.insert(events).values({
      userId,
      title: e.title,
      startsAt,
      endsAt: parseIso(e.ends_at) ?? undefined,
      location: e.location ?? undefined,
      source: "inferred",
      conversationId,
    });
    createdEvents++;
  }

  for (const s of result.status_updates) {
    const target = findDuplicate({ title: s.task }, existingOpen);
    if (!target) continue;
    const updates: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
    let note = "";
    if (s.signal === "done") {
      updates.status = "done";
      updates.completedAt = new Date();
      note = "Marked done (detected in conversation)";
    } else if (s.signal === "dropped") {
      updates.status = "dropped";
      note = "Dropped (detected in conversation)";
    } else if (s.signal === "started") {
      updates.status = "in_progress";
      if (!target.startedAt) updates.startedAt = new Date();
      note = "Started (detected in conversation)";
    } else {
      const newDue = parseIso(s.new_due_at);
      if (newDue) updates.dueAt = newDue;
      updates.postponedCount = target.postponedCount + 1;
      note = `Postponed${s.reason ? ` — ${s.reason}` : ""} (${target.postponedCount + 1}× total, detected in conversation)`;
    }
    await db
      .update(tasks)
      .set(updates)
      .where(and(eq(tasks.userId, userId), eq(tasks.id, target.id)));
    await db.insert(checkins).values({
      userId,
      taskId: target.id,
      type: "auto_detected",
      note,
    });
    updatedTasks++;
  }

  for (const fact of result.facts) {
    const dup = knownFacts.some((m) => titleSimilarity(m.fact, fact) >= 0.6);
    if (dup) continue;
    await db.insert(memories).values({ userId, fact, tags: ["inferred"] });
    savedFacts++;
  }

  return { createdTasks, createdEvents, updatedTasks, savedFacts };
}

/**
 * Full pass for one conversation: read un-extracted messages, run the model,
 * apply, advance the high-water mark. Safe to call often; no-ops when there is
 * nothing new. Never throws — extraction is a background safety net.
 */
export async function runExtraction(
  userId: string,
  conversationId: string,
  timezone: string
): Promise<void> {
  try {
    if (!process.env.OPENAI_API_KEY) return;
    const [conv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .limit(1);
    if (!conv) return;

    const { messages: messagesTable } = await import("@/lib/db/schema");
    const conds = [
      eq(messagesTable.conversationId, conversationId),
      eq(messagesTable.userId, userId),
    ];
    if (conv.extractedAt) conds.push(gt(messagesTable.createdAt, conv.extractedAt));
    const rows = await db
      .select()
      .from(messagesTable)
      .where(and(...conds))
      .orderBy(asc(messagesTable.createdAt));
    // Nothing new, or no user speech to extract from.
    if (!rows.some((m) => m.role === "user")) return;

    const transcript = rows
      .filter((m) => m.role !== "tool")
      .map((m) => `${m.role === "user" ? "User" : "Secretary"}: ${m.content}`)
      .join("\n");

    const knownTasks = await db
      .select({ title: tasks.title, dueAt: tasks.dueAt })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES])));
    const knownEvents = await db
      .select({ title: events.title, startsAt: events.startsAt })
      .from(events)
      .where(and(eq(events.userId, userId), gte(events.startsAt, new Date(Date.now() - 86400000))));

    const markerTime = rows[rows.length - 1].createdAt;
    const { result, inputTokens, outputTokens } = await extractFromTranscript({
      transcript,
      timezone,
      conversationDate: conv.startedAt,
      knownTasks,
      knownEvents,
    });

    await applyExtraction(userId, conversationId, result);

    await db
      .update(conversations)
      .set({ extractedAt: markerTime })
      .where(eq(conversations.id, conversationId));
    await db.insert(usage).values({
      userId,
      kind: "extraction",
      model: TEXT_MODEL,
      inputTokens,
      outputTokens,
    });

    // Piggyback the predictive pass (P-2) — it self-limits to once per day.
    const { generateSuggestions } = await import("./suggestions");
    await generateSuggestions(userId, timezone);
  } catch (e) {
    console.error("extraction pass failed:", e instanceof Error ? e.message : e);
  }
}
