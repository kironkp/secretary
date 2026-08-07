// Predictive/suggested tasks (P-2): a post-conversation job proposes tasks the
// user hasn't mentioned — recurring patterns, implied prerequisites, seasonal.
// They land as source='suggested', status='inbox' (a holding pen: excluded from
// normal views and briefing task lists until accepted). Accept → todo,
// dismiss → dropped, both via PATCH /api/tasks/[id].
import { z } from "zod";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { events, memories, tasks, usage } from "@/lib/db/schema";
import { openai, TEXT_MODEL } from "@/lib/openai";
import { findDuplicate } from "./dedupe";

const suggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      title: z.string(),
      reason: z.string().describe("One short sentence: why this is being suggested"),
      due_at: z.string().nullable().describe("ISO 8601 if there is a natural deadline"),
    })
  ),
});

const SUGGESTION_PROMPT = `You are the predictive layer of a personal secretary. Given the user's tasks, events, and known facts, propose 0–3 tasks they have NOT mentioned but plausibly need:
- recurring patterns (a task that appeared at the last few month-ends is probably due again)
- implied prerequisites (booked a flight → check passport validity, arrange airport transfer)
- seasonal/annual obligations (taxes, renewals, birthdays present in the facts)

Rules: only suggest things with a concrete basis in the data — never generic advice ("exercise more"). Nothing that overlaps an existing task. Quality over quantity; an empty list is the right answer most days.`;

const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Generate + store suggestions, at most once per 24h per user. Never throws. */
export async function generateSuggestions(userId: string, timezone: string): Promise<void> {
  try {
    if (!process.env.OPENAI_API_KEY) return;

    const [lastSuggested] = await db
      .select({ createdAt: tasks.createdAt })
      .from(tasks)
      .where(and(eq(tasks.userId, userId), eq(tasks.source, "suggested")))
      .orderBy(desc(tasks.createdAt))
      .limit(1);
    if (lastSuggested && Date.now() - lastSuggested.createdAt.getTime() < MIN_INTERVAL_MS) return;

    const now = new Date();
    const allTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.userId, userId))
      .orderBy(desc(tasks.createdAt))
      .limit(200);
    const upcoming = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, userId), gte(events.startsAt, now)))
      .orderBy(events.startsAt)
      .limit(30);
    const facts = await db.select().from(memories).where(eq(memories.userId, userId)).limit(50);

    // Not enough signal to predict from — don't waste a model call.
    if (allTasks.length < 3 && upcoming.length === 0) return;

    const fmt = (d: Date) =>
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium" }).format(d);

    const context = [
      `Today: ${fmt(now)} (${timezone})`,
      "",
      "TASKS (newest first, with status):",
      ...allTasks.map(
        (t) =>
          `- ${t.title} · ${t.status}${t.dueAt ? ` · due ${fmt(t.dueAt)}` : ""}${t.completedAt ? ` · done ${fmt(t.completedAt)}` : ""}`
      ),
      "",
      "UPCOMING EVENTS:",
      ...upcoming.map((e) => `- ${e.title} · ${fmt(e.startsAt)}`),
      "",
      "KNOWN FACTS:",
      ...facts.map((f) => `- ${f.fact}`),
    ].join("\n");

    const response = await openai.responses.create({
      model: TEXT_MODEL,
      instructions: SUGGESTION_PROMPT,
      input: context,
      text: {
        format: {
          type: "json_schema",
          name: "suggestions",
          strict: true,
          schema: z.toJSONSchema(suggestionSchema) as Record<string, unknown>,
        },
      },
    });
    const { suggestions } = suggestionSchema.parse(JSON.parse(response.output_text || "{}"));

    for (const s of suggestions.slice(0, 3)) {
      if (findDuplicate({ title: s.title }, allTasks)) continue;
      const dueAt = s.due_at ? new Date(s.due_at) : null;
      await db.insert(tasks).values({
        userId,
        title: s.title,
        notes: `Suggested: ${s.reason}`,
        dueAt: dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : undefined,
        status: "inbox",
        source: "suggested",
      });
    }

    await db.insert(usage).values({
      userId,
      kind: "extraction",
      model: TEXT_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });
  } catch (e) {
    console.error("suggestion pass failed:", e instanceof Error ? e.message : e);
  }
}

/** Pending suggestions (the holding pen) for the dashboard zone + briefing. */
export function getPendingSuggestions(userId: string) {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.source, "suggested"), eq(tasks.status, "inbox")))
    .orderBy(desc(tasks.createdAt))
    .limit(10);
}
