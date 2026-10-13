// Plan orchestration + persistence (SPEC §1 fast loop, Phase 1 flavor):
// signals → resolvePlan (rules; calm mode short-circuits) → validate → render.
// Every distinct plan is a new layout_specs row (kind "plan"), which is the
// plan history that one-tap revert walks; reverts are logged via `outcome`.
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs } from "@/lib/db/schema";
import { REGISTRY_VERSION } from "./registry";
import { composePlan, pinKeys, placeOn } from "./compose";
import { defaultPlan, sectionKey, type LayoutPlan } from "./plan";
import { planWithFallback, type PlannerCall } from "./plan-from-llm";
import { computeSignals, signalsHash, type Signals } from "./signals";
import { listDynamicComponents, openPriorityWishes } from "./slow-loop";
import type { LayoutPreference } from "./validator";

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
  // What renders is composed (SPEC §2, v1.02; lib/layout/compose.ts): from a
  // system plan come the emphasis and the places of the sections that are not
  // cards; the sections he placed go back where he put them; the cards he did
  // not place are in data order; then his hides, bans and presence. Every
  // branch below ends in the same composition, so the order follows the data
  // whichever plan it starts from.
  const compose = (system: LayoutPlan): LayoutPlan =>
    composePlan(system, { signals, stored: previousPlan, pinned: head?.pinned ?? [], preferences });
  if (signals.context.calm_mode) {
    // Invariant 7: DEFAULT_PLAN unconditionally — no planner of any kind.
    plan = compose(defaultPlan(signals));
  } else if (
    head?.signalsHash &&
    head.signalsHash === signalsHash(signals, REGISTRY_VERSION) &&
    previousPlan
  ) {
    // Durable cache (SPEC §6): the stored plan was written for exactly these
    // signals, so it is today's system plan → zero calls. The hash does not
    // carry everything the card order reads (a task's date edited into the
    // past leaves it unchanged), which is why the cards are ordered here too.
    plan = compose(previousPlan);
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
  const changed = !previousPlan || planContent(previousPlan) !== planContent(plan);
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

/**
 * A plan's content, the same however its keys are ordered. A stored plan comes
 * back from jsonb with its object keys reordered, so a plain JSON.stringify
 * called it different from the identical plan in memory (SEC-A004): every new
 * situation wrote a new version row and asked the planner again.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}
const planContent = (p: LayoutPlan) => JSON.stringify(canonical([p.sections, p.reason_summary ?? null]));

/**
 * Persist a newly-computed plan as the head, then (when signals changed) let
 * the LLM refine it in the background — the refined plan becomes the head the
 * NEXT open serves from the durable cache. Never throws (background job).
 */
/**
 * The Claude planner (SEC-A004): Sonnet, not the user's brain model. It runs
 * in the background after a dashboard render, and its prose is never read.
 */
const PLANNER_CLAUDE_MODEL = process.env.PLANNER_CLAUDE_MODEL ?? "claude-sonnet-5";

export async function persistPlan(
  userId: string,
  bundle: PlanBundle,
  /** Tests: the planner to call instead of a live model. */
  opts: { call?: PlannerCall } = {}
): Promise<void> {
  try {
    const hash = signalsHash(bundle.signals, REGISTRY_VERSION);
    // Planned for these signals already (another render got here first).
    const before = await getPlanHead(userId);
    const alreadyPlanned = before?.signalsHash === hash;
    /**
     * The head IS the plan for these signals: stamp it so the next render,
     * in this process or after a restart, is a cache hit and no model call.
     * Without it, a refinement that came back unchanged (or invalid) left
     * the head's hash stale, and every new process paid for it again.
     */
    const stamp = async () => {
      const head = await getPlanHead(userId);
      if (head && head.signalsHash !== hash && planContent(head.spec as LayoutPlan) === planContent(bundle.plan)) {
        await db.update(layoutSpecs).set({ signalsHash: hash }).where(eq(layoutSpecs.id, head.id));
      }
    };
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
    const { anthropicFor, claudeBrainEnabled } = await import("@/lib/anthropic");
    const claude = opts.call ? null : claudeBrainEnabled() ? await anthropicFor(userId) : null;
    if (
      !bundle.wantsLlmRefinement ||
      alreadyPlanned ||
      (!opts.call && ((!process.env.OPENAI_API_KEY && !claude) || process.env.VITEST)) ||
      bundle.signals.context.calm_mode
    )
      return await stamp();
    // Background work under the global net (SPEND_KILL, the all-background cap).
    const { paidCallAllowed } = await import("@/lib/spend-guard");
    if (!(await paidCallAllowed(userId, "layout")).ok) return;
    // The head may be this very plan under an older situation's hash (his data
    // changed, the board did not, so no row was written above). Stamp it now:
    // otherwise the answer about to be paid for is taken for one about a
    // situation that has moved on, and thrown away (v1.02).
    await stamp();
    const preferences = await getPreferences(userId);
    const { claudePlannerCall } = await import("./plan-from-llm");
    const refined = await planWithFallback(bundle.signals, {
      previousPlan: bundle.plan,
      preferences,
      pinnedSections: bundle.pinned,
      llmEnabled: true,
      call: opts.call ?? (claude ? claudePlannerCall(claude, PLANNER_CLAUDE_MODEL) : undefined),
      dynamicComponents: await listDynamicComponents(userId),
    });
    // Bill the planner BEFORE any of the reasons this function returns early —
    // the tokens were spent whether or not the refinement lands, and whether
    // or not the validator kept its plan (sec rev: a refused plan went
    // unrecorded, so the caps under-counted it). A cache hit spent nothing.
    if (refined.called) {
      const { lastPlannerUsage } = await import("./plan-from-llm");
      if (lastPlannerUsage.model) {
        const { recordUsage } = await import("@/lib/usage");
        await recordUsage({
          userId,
          kind: "layout",
          model: lastPlannerUsage.model,
          inputTokens: lastPlannerUsage.input,
          outputTokens: lastPlannerUsage.output,
        });
      }
    }
    if (refined.source !== "llm" && refined.source !== "llm-cache") return await stamp();
    if (planContent(refined.plan) === planContent(bundle.plan)) return await stamp();
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
export async function savePlanAsHead(
  userId: string,
  plan: LayoutPlan,
  /** Section keys to pin with it: what the user just placed stays where they put it. */
  pin: string[] = []
): Promise<number> {
  const [head, signals] = await Promise.all([getPlanHead(userId), computeSignals(userId)]);
  const version = (head?.version ?? 0) + 1;
  const present = new Set(plan.sections.map((s) => sectionKey(s)));
  await db.insert(layoutSpecs).values({
    userId,
    version,
    spec: plan,
    // A pin on a section that left the plan has nothing to hold.
    pinned: [...new Set([...(head?.pinned ?? []), ...pin])].filter((k) => present.has(k)),
    kind: "plan",
    signalsHash: signalsHash(signals, REGISTRY_VERSION),
    reasonSummary: plan.reason_summary ?? null,
    outcome: "accepted",
  });
  return version;
}

/**
 * Save a plan the user just changed, as it will render (SPEC §2, composition).
 * What he moved or added is PINNED at the place it has on that plan (the n-th
 * section from the top, or last), and the plan is composed before it is
 * stored: the answer a tool gives is then what the next render shows.
 * `preferences` are his preferences as they stand after this change (a hide
 * just made, a hide just lifted).
 */
export async function saveUsersPlan(
  userId: string,
  plan: LayoutPlan,
  opts: { signals: Signals; placed: string[]; preferences: LayoutPreference[] }
): Promise<{ version: number; plan: LayoutPlan }> {
  const head = await getPlanHead(userId);
  const sections = plan.sections.map((s) => {
    const key = sectionKey(s);
    return opts.placed.includes(key) ? { ...s, place: placeOn(plan.sections, key) ?? ("last" as const) } : s;
  });
  const placedPlan = { ...plan, sections };
  const present = new Set(sections.map((s) => sectionKey(s)));
  const pinned = [...pinKeys([...(head?.pinned ?? []), ...opts.placed], [])].filter((k) => present.has(k));
  const composed = composePlan(placedPlan, { signals: opts.signals, stored: placedPlan, pinned, preferences: opts.preferences });
  const version = await savePlanAsHead(userId, composed, opts.placed);
  return { version, plan: composed };
}

/**
 * One-tap revert (SPEC §1 invariant 7): the previous plan becomes a new head
 * and the reverted head is labeled — every revert is a labeled wrong
 * prediction, our accuracy metric. The previous plan's PINS come back with
 * it (v1.02): a pin holds a place now, so the pin a move made must go when
 * the move is undone, or the section would hold its old place for good.
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
    pinned: previous.pinned,
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
