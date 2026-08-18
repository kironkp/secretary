// Plan orchestration + persistence (SPEC §1 fast loop, Phase 1 flavor):
// signals → resolvePlan (rules; calm mode short-circuits) → validate → render.
// Every distinct plan is a new layout_specs row (kind "plan"), which is the
// plan history that one-tap revert walks; reverts are logged via `outcome`.
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs } from "@/lib/db/schema";
import { REGISTRY_VERSION } from "./registry";
import { defaultPlan, sectionKey, type LayoutPlan } from "./plan";
import { resolvePlan } from "./plan-from-rules";
import { computeSignals, signalsHash, type Signals } from "./signals";
import { applyBans, validatePlan, type LayoutPreference } from "./validator";

export type PlanBundle = {
  plan: LayoutPlan;
  signals: Signals;
  version: number;
  pinned: string[];
  updatedAt: Date | null;
  /** true when this render's plan differs from the stored head (needs persisting) */
  changed: boolean;
};

export async function getPlanHead(userId: string) {
  const [head] = await db
    .select()
    .from(layoutSpecs)
    .where(and(eq(layoutSpecs.userId, userId), eq(layoutSpecs.kind, "plan")))
    .orderBy(desc(layoutSpecs.version))
    .limit(1);
  return head ?? null;
}

export async function getPreferences(userId: string): Promise<LayoutPreference[]> {
  const rows = await db
    .select({ kind: layoutPreferences.kind, value: layoutPreferences.value })
    .from(layoutPreferences)
    .where(eq(layoutPreferences.userId, userId));
  return rows;
}

/** Compute the plan to render right now. Pure pipeline over fetched state. */
export async function computeCurrentPlan(userId: string): Promise<PlanBundle> {
  const [signals, head, preferences] = await Promise.all([
    computeSignals(userId),
    getPlanHead(userId),
    getPreferences(userId),
  ]);
  const previousPlan = head ? (head.spec as LayoutPlan) : null;

  // Calm mode: DEFAULT_PLAN unconditionally (resolvePlan never calls the
  // planner), but still filtered through stored bans.
  const candidate = resolvePlan(signals);
  const result = validatePlan(candidate, {
    signals,
    previousPlan,
    preferences,
    pinnedSections: head?.pinned ?? [],
    defaultPlan: defaultPlan(signals),
  });
  const plan = result.ok ? applyBans(result.plan, preferences) : result.fallback;

  // A plan is "new" when its content differs — sections or reason. plan_id
  // embeds the signals hash, which drifts with time; comparing it would write
  // a new history row on every render.
  const content = (p: LayoutPlan) => JSON.stringify([p.sections, p.reason_summary ?? null]);
  const changed = !previousPlan || content(previousPlan) !== content(plan);
  return {
    plan,
    signals,
    version: head?.version ?? 0,
    pinned: head?.pinned ?? [],
    updatedAt: head?.createdAt ?? null,
    changed,
  };
}

/** Persist a newly-computed plan as the head (background, never throws). */
export async function persistPlan(userId: string, bundle: PlanBundle): Promise<void> {
  try {
    if (!bundle.changed) return;
    const head = await getPlanHead(userId);
    // Re-check under the fresh head (two renders can race; last write wins).
    const content = (p: LayoutPlan) => JSON.stringify([p.sections, p.reason_summary ?? null]);
    if (head && content(head.spec as LayoutPlan) === content(bundle.plan)) return;
    await db.insert(layoutSpecs).values({
      userId,
      version: (head?.version ?? 0) + 1,
      spec: bundle.plan,
      pinned: head?.pinned ?? [],
      kind: "plan",
      signalsHash: signalsHash(bundle.signals, REGISTRY_VERSION),
      reasonSummary: bundle.plan.reason_summary ?? null,
      outcome: "accepted",
    });
  } catch (err) {
    console.error("persistPlan failed", err);
  }
}

/**
 * One-tap revert (SPEC §1 invariant 7): the previous plan becomes a new head
 * and the reverted head is labeled — every revert is a labeled wrong
 * prediction, our accuracy metric.
 */
export async function revertPlan(userId: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(layoutSpecs)
    .where(and(eq(layoutSpecs.userId, userId), eq(layoutSpecs.kind, "plan")))
    .orderBy(desc(layoutSpecs.version))
    .limit(2);
  if (rows.length < 2) return false;
  const [head, previous] = rows;
  await db
    .update(layoutSpecs)
    .set({ outcome: "reverted" })
    .where(eq(layoutSpecs.id, head.id));
  await db.insert(layoutSpecs).values({
    userId,
    version: head.version + 1,
    spec: previous.spec as LayoutPlan,
    pinned: head.pinned,
    kind: "plan",
    signalsHash: previous.signalsHash,
    reasonSummary: previous.reasonSummary,
    outcome: "accepted",
  });
  return true;
}

/** Pin/unpin a section key on the head plan row. */
export async function setPinned(userId: string, key: string, pinned: boolean): Promise<boolean> {
  const head = await getPlanHead(userId);
  if (!head) return false;
  const plan = head.spec as LayoutPlan;
  if (pinned && !plan.sections.some((s) => sectionKey(s) === key)) return false;
  const next = new Set(head.pinned);
  if (pinned) next.add(key);
  else next.delete(key);
  await db
    .update(layoutSpecs)
    .set({ pinned: [...next] })
    .where(eq(layoutSpecs.id, head.id));
  return true;
}
