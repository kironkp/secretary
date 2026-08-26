// Canvas painter (SPEC §7.6): brief + Signals → sanitized HTML fragment,
// STREAMED into the snapshot row so the canvas page shows paint progress —
// first chunks land in ~1–2s, well under the 3s first-paint budget, while the
// full render completes in the background.
//
// The canvas never mutates app state: the only table this file writes is
// canvas_snapshots. The model call is injectable for tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { canvasSnapshots, messages } from "@/lib/db/schema";
import { openai, PLANNER_MODEL } from "@/lib/openai";
import { anthropicFor, brainSettings, claudeBrainEnabled } from "@/lib/anthropic";
import type Anthropic from "@anthropic-ai/sdk";
import { computeSignals } from "@/lib/layout/signals";
import { sanitizeCanvasMarkup } from "./sanitize";

let promptCache: string | null = null;
export function painterPrompt(): string {
  promptCache ??= readFileSync(
    join(process.cwd(), "docs/adaptive-ui/canvas-painter-prompt.md"),
    "utf8"
  );
  return promptCache;
}

/** Streaming generator: yields accumulated raw markup as chunks arrive. */
export type PainterStream = (
  systemPrompt: string,
  input: string
) => AsyncIterable<string>;

export const livePainterStream: PainterStream = async function* (systemPrompt, input) {
  const stream = await openai.responses.create({
    model: PLANNER_MODEL,
    instructions: systemPrompt,
    input,
    stream: true,
  });
  let acc = "";
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      acc += event.delta;
      yield acc;
    }
  }
  yield acc;
};

/**
 * Claude painter (CLAUDE_BRAIN): user-chosen model, effort clamped to low —
 * the canvas is a streaming, latency-sensitive surface. Text deltas only;
 * thinking blocks never reach the markup.
 */
export function claudePainterStream(client: Anthropic, model: string): PainterStream {
  return async function* (systemPrompt, input) {
    const stream = client.messages.stream({
      model,
      max_tokens: 64000,
      system: systemPrompt,
      messages: [{ role: "user", content: input }],
      output_config: { effort: "low" },
    });
    let acc = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        acc += event.delta.text;
        yield acc;
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") throw new Error("claude refusal");
    yield acc;
  };
}

const FLUSH_EVERY_MS = 600;

/** Pure input assembly (unit-tested): the painter's whole world. */
export function buildPainterInput(
  brief: string,
  signalsJson: string,
  opts: { baseMarkup?: string; conversationExcerpt?: string } = {}
): string {
  return [
    opts.baseMarkup
      ? `CURRENT CANVAS (patch it per the brief, keep everything else):\n${opts.baseMarkup}\n`
      : "",
    `SIGNALS:\n${signalsJson}`,
    opts.conversationExcerpt
      ? `CONVERSATION (most recent excerpt — what the user just said; verbatim source of truth, same standing as SIGNALS):\n${opts.conversationExcerpt}`
      : "",
    `BRIEF:\n${brief}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const CONVERSATION_EXCERPT_MESSAGES = 30;

/** "Paint what I just said" needs the saying — the excerpt the painter reads. */
async function conversationExcerpt(
  userId: string,
  conversationId: string
): Promise<string | undefined> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId)))
    .orderBy(desc(messages.createdAt))
    .limit(CONVERSATION_EXCERPT_MESSAGES);
  if (!rows.length) return undefined;
  return rows
    .reverse()
    .filter((m) => m.role !== "tool")
    .map((m) => `${m.role === "user" ? "USER" : "SECRETARY"}: ${m.content}`)
    .join("\n");
}

/**
 * Paint (or repaint) the canvas. Creates the snapshot row immediately with
 * painting=true, streams sanitized chunks into it, and finalizes. Returns the
 * snapshot id. Every paint is a NEW snapshot — history is the feature.
 */
export async function paintCanvas(
  userId: string,
  brief: string,
  opts: { baseMarkup?: string; conversationId?: string; stream?: PainterStream } = {}
): Promise<{ snapshotId: string; markup: string }> {
  const signals = await computeSignals(userId);
  const input = buildPainterInput(brief, JSON.stringify(signals), {
    baseMarkup: opts.baseMarkup,
    conversationExcerpt: opts.conversationId
      ? await conversationExcerpt(userId, opts.conversationId)
      : undefined,
  });

  const [row] = await db
    .insert(canvasSnapshots)
    .values({ userId, brief, markup: "", painting: true })
    .returning();

  const claude = !opts.stream && claudeBrainEnabled() ? await anthropicFor(userId) : null;
  const useClaude = Boolean(claude);
  const chosen =
    opts.stream ??
    (claude ? claudePainterStream(claude, (await brainSettings(userId)).model) : livePainterStream);
  let finalRaw = "";
  const run = async (stream: PainterStream) => {
    let lastFlush = 0;
    for await (const raw of stream(painterPrompt(), input)) {
      finalRaw = raw;
      const now = Date.now();
      if (now - lastFlush >= FLUSH_EVERY_MS) {
        lastFlush = now;
        await db
          .update(canvasSnapshots)
          .set({ markup: sanitizeCanvasMarkup(raw) })
          .where(eq(canvasSnapshots.id, row.id));
      }
    }
  };
  try {
    try {
      await run(chosen);
    } catch (e) {
      // Claude path can never break the canvas: one retry on the OpenAI stream.
      if (!useClaude || !process.env.OPENAI_API_KEY) throw e;
      console.error(
        "claude painter failed, falling back to openai:",
        e instanceof Error ? e.message : e
      );
      finalRaw = "";
      await run(livePainterStream);
    }
  } finally {
    const markup = sanitizeCanvasMarkup(finalRaw);
    await db
      .update(canvasSnapshots)
      .set({ markup, painting: false })
      .where(eq(canvasSnapshots.id, row.id));
  }
  return { snapshotId: row.id, markup: sanitizeCanvasMarkup(finalRaw) };
}

export async function latestSnapshot(userId: string) {
  const [row] = await db
    .select()
    .from(canvasSnapshots)
    .where(eq(canvasSnapshots.userId, userId))
    .orderBy(desc(canvasSnapshots.createdAt))
    .limit(1);
  return row ?? null;
}

export async function listSnapshots(userId: string, limit = 20) {
  return db
    .select({
      id: canvasSnapshots.id,
      brief: canvasSnapshots.brief,
      painting: canvasSnapshots.painting,
      createdAt: canvasSnapshots.createdAt,
    })
    .from(canvasSnapshots)
    .where(eq(canvasSnapshots.userId, userId))
    .orderBy(desc(canvasSnapshots.createdAt))
    .limit(limit);
}

/** One-tap restore: the chosen snapshot becomes the newest (a copy). */
export async function restoreSnapshot(userId: string, snapshotId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(canvasSnapshots)
    .where(eq(canvasSnapshots.id, snapshotId))
    .limit(1);
  if (!row || row.userId !== userId) return false;
  await db.insert(canvasSnapshots).values({
    userId,
    brief: `restored: ${row.brief}`,
    markup: row.markup,
    painting: false,
  });
  return true;
}
