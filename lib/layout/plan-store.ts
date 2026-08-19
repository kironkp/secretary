// Plan orchestration + persistence (SPEC §1 fast loop, Phase 1 flavor):
// signals → resolvePlan (rules; calm mode short-circuits) → validate → render.
// Every distinct plan is a new layout_specs row (kind "plan"), which is the
// plan history that one-tap revert walks; reverts are logged via `outcome`.
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs } from "@/lib/db/schema";
import { REGISTRY_VERSION } from "./registry";
import { defaultPlan, sectionKey, type LayoutPlan } from "./plan";
import { planWithFallback } from "./plan-from-llm";
import { computeSignals, signalsHash, type Signals } from "./signals";
import { listDynamicComponents, openPriorityWishes } from "./slow-loop";
import { applyBans, type LayoutPreference } from "./validator";

export type PlanBundle = {
  plan: LayoutPlan;
  signals: Signals;
  version: number;
  pinned: string[];
  updatedAt: Date | null;
  /** true when this render's plan differs from the stored head (needs persisting) */
  changed: boolean;
  /** true when signals changed and the LLM should refine the plan in the background */
  wantsLlmRefinement: boolean;
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

/** Compute the plan to render right now. LLM → rules → previous → default. */
export async function computeCurrentPlan(userId: string): Promise<PlanBundle> {
  const [signals, head, preferences] = await Promise.all([
    computeSignals(userId),
    getPlanHead(userId),
    getPreferences(userId),
  ]);
  const previousPlan = head ? (head.spec as LayoutPlan) : null;

  // The render path is synchronous-fast: rules or cache, never a model call.
  // The LLM refinement happens in persistPlan (background, after render) and
  // is served by the durable cache on the NEXT open — measured nano-model
  // latency (~5s) is far over the fast-loop budget to block a render on.
  let plan: LayoutPlan;
  let wantsLlmRefinement = false;
  if (signals.context.calm_mode) {
    // Invariant 7: DEFAULT_PLAN unconditionally — no planner of any kind.
    plan = applyBans(defaultPlan(signals), preferences);
  } else if (
    head?.signalsHash &&
    head.signalsHash === signalsHash(signals, REGISTRY_VERSION) &&
    previousPlan
  ) {
    // Durable cache (SPEC §6): same signals as the stored head → zero calls.
    plan = applyBans(previousPlan, preferences);
  } else {
    ({ plan } = await planWithFallback(signals, {
      previousPlan,
      preferences,
      pinnedSections: head?.pinned ?? [],
      llmEnabled: false, // rules only on the render path
      dynamicComponents: await listDynamicComponents(userId),
    }));
    wantsLlmRefinement = true;
  }

  // F8 interim substitution (SPEC §7.5 tier 2): while a wished view is being
  // built, its closest component stands in — emphasized, with an honest why.
  if (!signals.context.calm_mode) {
    for (const wish of await openPriorityWishes(userId)) {
      const stand = plan.sections.find((s) => s.component === wish.closestComponent);
      if (!stand) continue;
      if (stand.component === "timeline") {
        stand.props = { ...stand.props, span_days: 14, expanded: true };
      }
      stand.why = `closest I have until the ${wish.need.split("—")[0].trim()} view is built`.slice(0, 140);
    }
  }

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
    wantsLlmRefinement,
  };
}

const planContent = (p: LayoutPlan) => JSON.stringify([p.sections, p.reason_summary ?? null]);

/**
 * Persist a newly-computed plan as the head, then (when signals changed) let
 * the LLM refine it in the background — the refined plan becomes the head the
 * NEXT open serves from the durable cache. Never throws (background job).
 */
export async function persistPlan(userId: string, bundle: PlanBundle): Promise<void> {
  try {
    const hash = signalsHash(bundle.signals, REGISTRY_VERSION);
    if (bundle.changed) {
      const head = await getPlanHead(userId);
      // Re-check under the fresh head (two renders can race; last write wins).
      if (!head || planContent(head.spec as LayoutPlan) !== planContent(bundle.plan)) {
        await db.insert(layoutSpecs).values({
          userId,
          version: (head?.version ?? 0) + 1,
          spec: bundle.plan,
          pinned: head?.pinned ?? [],
          kind: "plan",
          signalsHash: hash,
          reasonSummary: bundle.plan.reason_summary ?? null,
          outcome: "accepted",
        });
      }
    }

    // LLM refinement (SPEC §6) — tests never call a live model (VITEST guard).
    const { claudeBrainEnabled, brainSettings } = await import("@/lib/anthropic");
    const useClaude = claudeBrainEnabled();
    if (
      !bundle.wantsLlmRefinement ||
      (!process.env.OPENAI_API_KEY && !useClaude) ||
      process.env.VITEST ||
      bundle.signals.context.calm_mode
    )
      return;
    const preferences = await getPreferences(userId);
    const { claudePlannerCall } = await import("./plan-from-llm");
    const refined = await planWithFallback(bundle.signals, {
      previousPlan: bundle.plan,
      preferences,
      pinnedSections: bundle.pinned,
      llmEnabled: true,
      call: useClaude ? claudePlannerCall((await brainSettings(userId)).model) : undefined,
      dynamicComponents: await listDynamicComponents(userId),
    });
    if (refined.source !== "llm" && refined.source !== "llm-cache") return;
    if (planContent(refined.plan) === planContent(bundle.plan)) return;
    const head = await getPlanHead(userId);
    // Only land the refinement if the situation hasn't moved on meanwhile.
    if (head?.signalsHash && head.signalsHash !== hash) return;
    await db.insert(layoutSpecs).values({
      userId,
      version: (head?.version ?? 0) + 1,
      spec: refined.plan,
      pinned: head?.pinned ?? [],
      kind: "plan",
      signalsHash: hash,
      reasonSummary: refined.plan.reason_summary ?? null,
      outcome: "accepted",
    });
  } catch (err) {
    console.error("persistPlan failed", err);
  }
}

/**
 * Store a user-initiated plan (chat edit, ban re-render) as the new head.
 * Stamped with the CURRENT signals hash so the durable cache serves it until
 * the situation actually changes — the planner can't immediately undo the user.
 */
export async function savePlanAsHead(userId: string, plan: LayoutPlan): Promise<number> {
  const [head, signals] = await Promise.all([getPlanHead(userId), computeSignals(userId)]);
  const version = (head?.version ?? 0) + 1;
  await db.insert(layoutSpecs).values({
    userId,
    version,
    spec: plan,
    pinned: head?.pinned ?? [],
    kind: "plan",
    signalsHash: signalsHash(signals, REGISTRY_VERSION),
    reasonSummary: plan.reason_summary ?? null,
    outcome: "accepted",
  });
  return version;
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
