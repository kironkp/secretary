// Layout generation + versioning. Regeneration is debounced (data-shape hash +
// minimum age) and runs in the background via after() — the dashboard always
// renders the stored head (or DEFAULT_SPEC) synchronously.
import { z } from "zod";
import { and, count, desc, eq, gte, inArray, isNotNull, lt, ne, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { events, layoutSpecs, projects, tasks, usage } from "@/lib/db/schema";
import { openai, TEXT_MODEL } from "@/lib/openai";
import {
  DEFAULT_SPEC,
  dataHash,
  layoutSpecSchema,
  type DataShape,
  type LayoutSpec,
  type StoredLayout,
} from "./spec";

const OPEN_STATUSES = ["inbox", "todo", "in_progress", "blocked"] as const;
const MIN_AGE_MS = 60 * 60 * 1000; // never rearrange more than once an hour

const GENERATOR_PROMPT = `You arrange a personal-assistant dashboard from a fixed component palette. Given the shape of the user's data, return the sections in the order they should appear (top = most important right now). Component meanings: focus_card = "Next up" hero (the single nearest commitment); timeline = 5-week deadline-pressure overview per project (handles undated work too); list = grouped "Open loops" table (the main work surface); kanban = status board; project_grid = per-project cards with progress + next actions. Rules:
- overdue_callout MUST be first whenever overdue > 0; omit it when overdue = 0.
- stat_tiles near the top, almost always.
- focus_card whenever anything dated is upcoming (events7d > 0 or dueToday > 0 or openTasks > 0).
- timeline whenever openTasks > 0 — deadline pressure is the point of the dashboard.
- project_grid when projects >= 1.
- Include exactly ONE of list | kanban as the main work surface: list by default; kanban only when openTasks >= 10.
- suggested_zone only when suggestions > 0; procrastination_zone only when procrastinated > 0.
- coming_up (a small strip of the next reminders) only when reminders24h > 0 — near the top when present.
- calendar_strip only when events7d > 0 and it isn't redundant with focus_card.
- 4–8 sections total. Titles: null unless a custom heading genuinely helps.`;

export async function getDataShape(userId: string): Promise<DataShape> {
  const now = new Date();
  const in7d = new Date(now.getTime() + 7 * 86400000);
  const ago7d = new Date(now.getTime() - 7 * 86400000);
  const endOfDay = new Date(now.getTime() + 86400000);
  const notPendingSuggestion = or(ne(tasks.source, "suggested"), ne(tasks.status, "inbox"));

  const [open] = await db
    .select({ n: count() })
    .from(tasks)
    .where(
      and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES]), notPendingSuggestion)
    );
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
        lt(tasks.dueAt, endOfDay)
      )
    );
  const [events7d] = await db
    .select({ n: count() })
    .from(events)
    .where(and(eq(events.userId, userId), gte(events.startsAt, now), lt(events.startsAt, in7d)));
  const [projectCount] = await db
    .select({ n: count() })
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.status, "active")));
  const [suggestions] = await db
    .select({ n: count() })
    .from(tasks)
    .where(
      and(eq(tasks.userId, userId), eq(tasks.source, "suggested"), eq(tasks.status, "inbox"))
    );
  const [procrastinated] = await db
    .select({ n: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        inArray(tasks.status, [...OPEN_STATUSES]),
        gte(tasks.procrastinationScore, 3)
      )
    );
  const [done7d] = await db
    .select({ n: count() })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.status, "done"), gte(tasks.completedAt, ago7d)));

  // reminders in the next 24h (jsonb arrays — filtered in JS, user-scale data)
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const taskReminders = await db
    .select({ reminders: tasks.reminders })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), inArray(tasks.status, [...OPEN_STATUSES])));
  const eventReminders = await db
    .select({ reminders: events.reminders })
    .from(events)
    .where(and(eq(events.userId, userId), gte(events.startsAt, now)));
  const reminders24h = [...taskReminders, ...eventReminders]
    .flatMap((r) => r.reminders ?? [])
    .filter((iso) => {
      const d = new Date(iso);
      return d >= now && d <= in24h;
    }).length;

  return {
    openTasks: open?.n ?? 0,
    overdue: overdue?.n ?? 0,
    dueToday: dueToday?.n ?? 0,
    events7d: events7d?.n ?? 0,
    projects: projectCount?.n ?? 0,
    suggestions: suggestions?.n ?? 0,
    procrastinated: procrastinated?.n ?? 0,
    done7d: done7d?.n ?? 0,
    reminders24h,
  };
}

export async function getLayoutHead(userId: string) {
  const [head] = await db
    .select()
    .from(layoutSpecs)
    .where(eq(layoutSpecs.userId, userId))
    .orderBy(desc(layoutSpecs.version))
    .limit(1);
  return head ?? null;
}

/** The spec to render right now — stored head, or the default before any generation. */
export async function getCurrentLayout(userId: string): Promise<{
  spec: LayoutSpec;
  version: number;
  pinned: string[];
  updatedAt: Date | null;
}> {
  const head = await getLayoutHead(userId);
  if (!head) return { spec: DEFAULT_SPEC, version: 0, pinned: [], updatedAt: null };
  const stored = head.spec as StoredLayout;
  return {
    spec: { sections: stored.sections },
    version: head.version,
    pinned: head.pinned,
    updatedAt: head.createdAt,
  };
}

/**
 * Regenerate if the data shape changed and the head isn't too fresh. Pinned
 * sections are re-imposed at their previous positions after generation, so the
 * AI can never move them. Never throws (background job).
 */
export async function maybeRegenerateLayout(userId: string): Promise<void> {
  try {
    if (!process.env.OPENAI_API_KEY) return;
    const head = await getLayoutHead(userId);
    const shape = await getDataShape(userId);
    const hash = dataHash(shape);

    if (!head) {
      // First sight of this user: store the DESIGNED default as the baseline
      // (version 0, no banner) instead of letting the AI immediately override
      // the reference layout. Regeneration then only fires when the data
      // shape actually changes from here.
      await db.insert(layoutSpecs).values({
        userId,
        version: 0,
        spec: { sections: DEFAULT_SPEC.sections, dataHash: hash } satisfies StoredLayout,
        pinned: [],
      });
      return;
    }

    const stored = head.spec as StoredLayout;
    if (stored.dataHash === hash) return; // nothing changed
    if (Date.now() - head.createdAt.getTime() < MIN_AGE_MS) return; // debounce

    const response = await openai.responses.create({
      model: TEXT_MODEL,
      instructions: GENERATOR_PROMPT,
      input: `Data shape: ${JSON.stringify(shape)}`,
      text: {
        format: {
          type: "json_schema",
          name: "layout",
          strict: true,
          schema: z.toJSONSchema(layoutSpecSchema) as Record<string, unknown>,
        },
      },
    });
    const generated = layoutSpecSchema.parse(JSON.parse(response.output_text || "{}"));

    // Re-impose pins: a pinned component keeps the index it had in the old spec.
    const pinned = head?.pinned ?? [];
    let sections = generated.sections;
    if (head && pinned.length) {
      const old = (head.spec as StoredLayout).sections;
      const unpinned = sections.filter((s) => !pinned.includes(s.component));
      const result: typeof sections = [];
      for (let i = 0; i < old.length; i++) {
        if (pinned.includes(old[i].component)) result[i] = old[i];
      }
      let u = 0;
      for (let i = 0; i < Math.max(old.length, unpinned.length + pinned.length); i++) {
        if (!result[i] && u < unpinned.length) result[i] = unpinned[u++];
      }
      sections = result.filter(Boolean);
    }

    // Identical arrangement → just refresh the hash in place, no new version.
    if (head) {
      const old = (head.spec as StoredLayout).sections;
      const same =
        old.length === sections.length &&
        old.every((s, i) => s.component === sections[i].component);
      if (same) {
        await db
          .update(layoutSpecs)
          .set({ spec: { sections, dataHash: hash } satisfies StoredLayout })
          .where(and(eq(layoutSpecs.userId, userId), eq(layoutSpecs.id, head.id)));
        return;
      }
    }

    await db.insert(layoutSpecs).values({
      userId,
      version: (head?.version ?? 0) + 1,
      spec: { sections, dataHash: hash } satisfies StoredLayout,
      pinned,
    });
    await db.insert(usage).values({
      userId,
      kind: "layout",
      model: TEXT_MODEL,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    });
  } catch (e) {
    console.error("layout generation failed:", e instanceof Error ? e.message : e);
  }
}
