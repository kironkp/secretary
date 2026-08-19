// Post-conversation extraction pass (Flow 2, the safety net): a cheap text
// model re-reads the transcript and catches anything the live model didn't log
// via tools. Runs incrementally — only messages after conversations.extractedAt
// are scanned — and everything it writes is deduped and tagged source='inferred'.
import { z } from "zod";
import { and, asc, desc, eq, gt, gte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  checkins,
  clarifications,
  conversations,
  events,
  memories,
  tasks,
  usage,
} from "@/lib/db/schema";
import { crossReferenceMentions } from "./entities";
import { openai, TEXT_MODEL } from "@/lib/openai";
import {
  anthropic,
  brainSettings,
  claudeBrainEnabled,
  type BrainSettings,
} from "@/lib/anthropic";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { findDuplicate, findDuplicateEvent, titleSimilarity } from "./dedupe";

export const extractionSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string(),
      notes: z.string().nullable(),
      due_at: z.string().nullable().describe("ISO 8601 in the user's timezone, if a deadline was stated"),
      project: z
        .string()
        .nullable()
        .describe("EXACT name of the existing project this belongs to, or null"),
    })
  ),
  events: z.array(
    z.object({
      title: z.string(),
      starts_at: z.string().describe("ISO 8601"),
      ends_at: z.string().nullable(),
      location: z.string().nullable(),
      project: z
        .string()
        .nullable()
        .describe("EXACT name of the existing project this belongs to, or null"),
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
  // SPEC §11: every person/org/term mention, for entity cross-reference —
  // never dropped, never silently merged.
  mentions: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["person", "org", "term", "acronym"]),
      context: z.string().nullable().describe("The verbatim phrase it appeared in"),
      confidence: z
        .enum(["high", "low"])
        .describe("Confidence in the SPELLING — voice transcripts garble names"),
    })
  ),
  // SPEC §11: ambiguities the transcript itself can't resolve. NEVER guess —
  // queue them. kinds: referent ("this one is finished" about an unseen
  // screen), asr_span (garbled audio, keep the span verbatim).
  ambiguities: z.array(
    z.object({
      kind: z.enum(["referent", "asr_span"]),
      question: z.string().describe("The question to ask the user, ready to say aloud"),
      context: z.string().describe("Verbatim transcript span this is about"),
    })
  ),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

const EXTRACTION_PROMPT = `You are an extraction pass over a personal-secretary conversation transcript. Find ONLY items the user actually committed to or stated — never invent.

Return:
- tasks: to-dos/obligations the USER must do, mentioned but plausibly not yet logged.
- events: meetings/appointments/plans with a concrete date or time.
- status_updates: signals about EXISTING tasks — "yeah I sent it" (done), "I'll do it Friday" (postponed + new_due_at), "started on it" (started), "forget that" (dropped). Refer to the task by its title from the KNOWN OPEN TASKS list when possible.
- facts: durable personal facts (names, preferences, constraints) — not one-off logistics.
- mentions: EVERY person, organization, project term, and acronym mentioned, with the verbatim phrase and your confidence in the SPELLING (voice transcripts garble names — "calc card" for CalCard, "pay I test" for unknown terms → confidence low).
- ambiguities: things the transcript cannot resolve — do NOT guess. Unresolved referents ("this one is finished" while reading a screen you can't see → which one?); garbled ASR spans (keep the span verbatim, kind asr_span). If a name could be either a separate person or a self-correction ("signed by Marissa, Teresa Mahers, my boss"), that is a referent ambiguity — never silently pick one.

Anything already in KNOWN OPEN TASKS or KNOWN EVENTS must NOT reappear in tasks/events (report status changes about them via status_updates instead). Every task/event that belongs to an ongoing workstream carries that project's EXACT name from the PROJECTS list; null only for standalone life admin. Dates: resolve relative expressions against the conversation date given. If no timezone-certain time, use 17:00 local. Empty arrays are fine — most conversations produce nothing.`;

const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;

/**
 * Claude extraction (the "smartest model for parsing" path): same prompt, same
 * schema, structured output enforced by the API. Throws on refusal/mismatch so
 * the caller can fall back to OpenAI.
 */
async function claudeExtract(
  context: string,
  brain: BrainSettings
): Promise<{ result: ExtractionResult; inputTokens: number; outputTokens: number; model: string }> {
  const response = await anthropic().messages.parse({
    model: brain.model,
    max_tokens: 16000,
    system: EXTRACTION_PROMPT,
    messages: [{ role: "user", content: context }],
    output_config: {
      effort: brain.effort,
      format: zodOutputFormat(extractionSchema),
    },
  });
  if (response.stop_reason === "refusal") throw new Error("claude refusal");
  if (!response.parsed_output) throw new Error("claude structured output missing");
  return {
    result: extractionSchema.parse(response.parsed_output),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model: brain.model,
  };
}

/** Model call: transcript → structured candidates. Claude-first when enabled. */
export async function extractFromTranscript(opts: {
  transcript: string;
  timezone: string;
  conversationDate: Date;
  knownTasks: { title: string; dueAt: Date | null }[];
  knownEvents: { title: string; startsAt: Date }[];
  projectNames: string[];
  /** Per-user Claude settings; when set (and the flag is on) Claude parses. */
  brain?: BrainSettings;
}): Promise<{ result: ExtractionResult; inputTokens: number; outputTokens: number; model: string }> {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: opts.timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(d);

  const projectLines =
    opts.projectNames.length > 0
      ? ["", "PROJECTS (use these EXACT names):", ...opts.projectNames.map((n) => `- ${n}`)]
      : [];
  const context = [
    `Conversation date: ${fmt(opts.conversationDate)} (timezone ${opts.timezone})`,
    ...projectLines,
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

  if (opts.brain && claudeBrainEnabled()) {
    try {
      return await claudeExtract(context, opts.brain);
    } catch (e) {
      console.error(
        "claude extraction failed, falling back to openai:",
        e instanceof Error ? e.message : e
      );
      if (!process.env.OPENAI_API_KEY) throw e;
    }
  }

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
    model: TEXT_MODEL,
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

  // File into EXISTING projects only — an extraction guess never creates one.
  const { resolveProject } = await import("./tools");
  const projectIdFor = async (name: string | null) => {
    if (!name) return undefined;
    const { project } = await resolveProject(userId, name, { create: false });
    return project?.id;
  };

  for (const t of result.tasks) {
    const dueAt = parseIso(t.due_at);
    // dedupe against every recent task (done ones included — "book flights"
    // finished yesterday must not come back as a new inferred to-do)
    if (findDuplicate({ title: t.title, dueAt }, allRecent)) continue;
    await db.insert(tasks).values({
      userId,
      title: t.title,
      notes: t.notes ?? undefined,
      projectId: await projectIdFor(t.project),
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
      projectId: await projectIdFor(e.project),
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
      if (target.status !== "done") {
        const { spawnNextOccurrence } = await import("./recurrence");
        // spawn after the update below would be cleaner, but the helper only
        // needs the row's own fields — apply the status locally
        await spawnNextOccurrence({ ...target, status: "done" });
      }
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

  // SPEC §11: cross-reference every mention (never dropped, never silently
  // merged) and queue the transcript's own ambiguities — one-at-a-time
  // delivery happens at the briefing.
  await crossReferenceMentions(
    userId,
    (result.mentions ?? []).map((m) => ({
      name: m.name,
      kind: m.kind,
      context: m.context ?? undefined,
      confidence: m.confidence,
    }))
  );
  for (const amb of result.ambiguities ?? []) {
    const open = await db
      .select()
      .from(clarifications)
      .where(and(eq(clarifications.userId, userId), inArray(clarifications.status, ["open", "asked"])));
    if (open.some((c) => titleSimilarity(c.question, amb.question) >= 0.7)) continue;
    await db.insert(clarifications).values({
      userId,
      kind: amb.kind,
      question: amb.question,
      context: amb.context,
    });
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
    if (!process.env.OPENAI_API_KEY && !claudeBrainEnabled()) return;
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
    const { projects: projectsTable } = await import("@/lib/db/schema");
    const { ne: neOp } = await import("drizzle-orm");
    const projectRows = await db
      .select({ name: projectsTable.name })
      .from(projectsTable)
      .where(and(eq(projectsTable.userId, userId), neOp(projectsTable.status, "archived")));

    const markerTime = rows[rows.length - 1].createdAt;
    const { result, inputTokens, outputTokens, model } = await extractFromTranscript({
      transcript,
      timezone,
      projectNames: projectRows.map((p) => p.name),
      conversationDate: conv.startedAt,
      knownTasks,
      knownEvents,
      brain: claudeBrainEnabled() ? await brainSettings(userId) : undefined,
    });

    await applyExtraction(userId, conversationId, result);

    await db
      .update(conversations)
      .set({ extractedAt: markerTime })
      .where(eq(conversations.id, conversationId));
    await db.insert(usage).values({
      userId,
      kind: "extraction",
      model,
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
