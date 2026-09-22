// Entity cross-reference (SPEC §11): every person/org/term mention resolves
// against the store BEFORE write. Exact/alias match → touch. Near-miss →
// entity_conflict clarification (NEVER silent merge or drop — the Marissa
// fixture). Unknown → created; low-confidence spellings arrive unconfirmed
// with a new_name clarification, and must not be used in documents until
// confirmed. Pure DB mechanics — the model only supplies mentions.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, entities } from "@/lib/db/schema";
import { ASR_KINDS } from "@/lib/understanding/questions";

export type Mention = {
  name: string;
  kind: "person" | "org" | "term" | "acronym";
  /** verbatim snippet the mention came from */
  context?: string;
  /** the extractor's confidence in the SPELLING (ASR names are often garbled) */
  confidence?: "high" | "low";
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Levenshtein with early exit — names are short. */
function editDistance(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array<number>(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return dp[m][n];
}

function isNearMiss(mention: string, existing: string): boolean {
  const a = norm(mention),
    b = norm(existing);
  if (a === b) return false;
  // whole-name closeness ("walter myara" ~ "walter maiara")
  if (editDistance(a, b) <= 2) return true;
  // shared first token with differing surname ("teresa mahers" ~ "teresa maers")
  const [af, ...ar] = a.split(" ");
  const [bf, ...br] = b.split(" ");
  if (af === bf && ar.length && br.length && editDistance(ar.join(" "), br.join(" ")) <= 2)
    return true;
  return false;
}

export type CrossRefOutcome =
  | { action: "touched"; entityId: string }
  | { action: "created"; entityId: string; clarificationId?: string }
  | { action: "conflict"; entityId: string; clarificationId: string };

/**
 * Resolve one mention against the store. Returns what happened — nothing is
 * ever dropped: worst case is a created entity or a queued clarification.
 */
export async function crossReferenceMention(
  userId: string,
  mention: Mention
): Promise<CrossRefOutcome> {
  const rows = await db.select().from(entities).where(eq(entities.userId, userId));
  const target = norm(mention.name);

  const exact = rows.find(
    (r) => norm(r.name) === target || r.aliases.some((al) => norm(al) === target)
  );
  if (exact) {
    await db
      .update(entities)
      .set({ lastMentionedAt: new Date() })
      .where(eq(entities.id, exact.id));
    return { action: "touched", entityId: exact.id };
  }

  const near = rows.find(
    (r) => isNearMiss(mention.name, r.name) || r.aliases.some((al) => isNearMiss(mention.name, al))
  );
  if (near) {
    // NEVER silently merge or create a twin — ask.
    const [c] = await db
      .insert(clarifications)
      .values({
        userId,
        kind: "entity_conflict",
        subject: mention.name.trim(),
        question: `I heard "${mention.name}" — is that ${near.name}, or someone new?`,
        context: mention.context ?? null,
        entityId: near.id,
      })
      .returning();
    return { action: "conflict", entityId: near.id, clarificationId: c.id };
  }

  const lowConfidence = mention.confidence === "low";
  const [created] = await db
    .insert(entities)
    .values({
      userId,
      name: mention.name.trim(),
      kind: mention.kind,
      confirmed: !lowConfidence,
      notes: mention.context ?? null,
    })
    .returning();
  if (lowConfidence) {
    const [c] = await db
      .insert(clarifications)
      .values({
        userId,
        kind: "new_name",
        subject: mention.name.trim(),
        question: `New name heard as "${mention.name}" — did I get the spelling right?`,
        context: mention.context ?? null,
        entityId: created.id,
      })
      .returning();
    return { action: "created", entityId: created.id, clarificationId: c.id };
  }
  return { action: "created", entityId: created.id };
}

export async function crossReferenceMentions(
  userId: string,
  mentions: Mention[]
): Promise<CrossRefOutcome[]> {
  const outcomes: CrossRefOutcome[] = [];
  for (const m of mentions) outcomes.push(await crossReferenceMention(userId, m));
  return outcomes;
}

/**
 * The ONE clarification to surface next (oldest open), marked as asked.
 * Only the four voice-flow kinds: the understanding loop's questions
 * (docs/understanding/SPEC.md §5, §6) share this table but have their own
 * block in the briefing, their own answer ids and their own tool
 * (answer_question), so a need_to_know row must never come through here to
 * be "resolved" as if it were a misheard name.
 */
export async function nextClarification(userId: string) {
  const [row] = await db
    .select()
    .from(clarifications)
    .where(
      and(
        eq(clarifications.userId, userId),
        eq(clarifications.status, "open"),
        inArray(clarifications.kind, [...ASR_KINDS])
      )
    )
    .orderBy(clarifications.createdAt)
    .limit(1);
  if (!row) return null;
  await db
    .update(clarifications)
    .set({ status: "asked", askedAt: new Date() })
    .where(eq(clarifications.id, row.id));
  return row;
}

/** Open rows of the four voice-flow kinds; the same filter as nextClarification. */
export async function openClarificationCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: clarifications.id })
    .from(clarifications)
    .where(
      and(
        eq(clarifications.userId, userId),
        eq(clarifications.status, "open"),
        inArray(clarifications.kind, [...ASR_KINDS])
      )
    );
  return rows.length;
}
