// Predictive/suggested tasks (P-2): a post-conversation job proposes tasks the
// user hasn't mentioned — recurring patterns, implied prerequisites, seasonal.
// They land as source='suggested', status='inbox' (a holding pen: excluded from
// normal views and briefing task lists until accepted). Accept → todo,
// dismiss → dropped, both via PATCH /api/tasks/[id].
import { z } from "zod";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { events, memories, tasks } from "@/lib/db/schema";
import { openai, TEXT_MODEL } from "@/lib/openai";
import { recordUsage } from "@/lib/usage";
import { findDuplicate } from "./dedupe";

const suggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      title: z.string(),
      reason: z.string().describe("One short sentence: why this is being suggested"),
      due_at: z.string().nullable().describe("ISO 8601 if there is a natural deadline"),
      project: z
        .string()
        .nullable()
        .describe("EXACT name of the existing project this belongs to, or null"),
    })
  ),
});

const SUGGESTION_PROMPT = `You are the predictive layer of a personal secretary. Given the user's tasks, events, and known facts, propose 0–3 tasks they have NOT mentioned but plausibly need:
- recurring patterns (a task that appeared at the last few month-ends is probably due again)
- implied prerequisites (booked a flight → check passport validity, arrange airport transfer)
- seasonal/annual obligations (taxes, renewals, birthdays present in the facts)

Rules: only suggest things with a concrete basis in the data — never generic advice ("exercise more"). Nothing that overlaps an existing task. Every suggestion that belongs to an ongoing workstream MUST carry that project's EXACT name from the task list (a prerequisite for a patent meeting belongs to the patent project); use null only for genuinely standalone life admin. Quality over quantity; an empty list is the right answer most days.`;

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
    const { projects } = await import("@/lib/db/schema");
    const { ne } = await import("drizzle-orm");
    const projectRows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, userId), ne(projects.status, "archived")));
    const projectName = new Map(projectRows.map((p) => [p.id, p.name]));

    // Not enough signal to predict from — don't waste a model call.
    if (allTasks.length < 3 && upcoming.length === 0) return;

    const fmt = (d: Date) =>
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium" }).format(d);

    const context = [
      `Today: ${fmt(now)} (${timezone})`,
      "",
      // the model can only file suggestions correctly if it can SEE which
      // project each existing task belongs to (learned from the DTC-budget
      // suggestion landing Unfiled)
      "PROJECTS (exact names):",
      ...projectRows.map((p) => `- "${p.name}"`),
      "",
      "TASKS (newest first, with status and project):",
      ...allTasks.map(
        (t) =>
          `- ${t.title} · ${t.status}${t.dueAt ? ` · due ${fmt(t.dueAt)}` : ""}${t.completedAt ? ` · done ${fmt(t.completedAt)}` : ""}${t.projectId && projectName.get(t.projectId) ? ` · project "${projectName.get(t.projectId)}"` : ""}`
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
    await insertSuggestions(userId, suggestions.slice(0, 3), allTasks);

    // "other", not "extraction": this is a separate prediction pass, and
    // filing it under extraction made two different costs indistinguishable in
    // the spend report.
    await recordUsage({
      userId,
      kind: "other",
      model: TEXT_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });
  } catch (e) {
    console.error("suggestion pass failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Insert suggestion rows, filed into their (existing) projects via the same
 * fuzzy resolution tasks use — accepted suggestions must never land Unfiled
 * when they clearly belong to a workstream. Exported for tests.
 */
export async function insertSuggestions(
  userId: string,
  list: { title: string; reason: string; due_at: string | null; project: string | null }[],
  existingTasks: { title: string; dueAt: Date | null }[]
): Promise<number> {
  const { resolveProject } = await import("./tools");
  let inserted = 0;
  for (const s of list) {
    if (findDuplicate({ title: s.title }, existingTasks)) continue;
    const dueAt = s.due_at ? new Date(s.due_at) : null;
    // never CREATE a project from a guess — file only into existing ones
    const { project } = s.project
      ? await resolveProject(userId, s.project, { create: false })
      : { project: null };
    await db.insert(tasks).values({
      userId,
      title: s.title,
      notes: `Suggested: ${s.reason}`,
      projectId: project?.id,
      dueAt: dueAt && !Number.isNaN(dueAt.getTime()) ? dueAt : undefined,
      status: "inbox",
      source: "suggested",
    });
    inserted++;
  }
  return inserted;
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
