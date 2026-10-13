// Plan orchestration + persistence (SPEC §1 fast loop, Phase 1 flavor):
// signals → resolvePlan (rules; calm mode short-circuits) → validate → render.
// Every distinct plan is a new layout_specs row (kind "plan"), which is the
// plan history that one-tap revert walks; reverts are logged via `outcome`.
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, layoutSpecs } from "@/lib/db/schema";
import { REGISTRY_VERSION } from "./registry";
import { composePlan } from "./compose";
import { defaultPlan, sectionKey, type LayoutPlan } from "./plan";
import { planWithFallback, type PlannerCall } from "./plan-from-llm";
import { computeSignals, layoutChanged, signalsHash, type Signals } from "./signals";
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

/**
 * The hash a plan about to be stored will be found under at the next render,
 * if nothing else changes (docs/spend/SPEC.md §4, v1.04). A stored plan in
 * which the system changed the layout resets the layout clock, and the clock
 * is in the hash: stored under the hash of the signals as they were BEFORE
 * it, the row that answered a situation made the next open look like a new
 * one, and the planner was asked again. So a row that resets the clock is
 * stored under the hash with the clock already reset. The pins are in the
 * hash too, and a row carries its own: `pinned` are the keys of what he has
 * placed on this plan. `previous` is the row it follows.
 */
export function hashOnceStored(signals: Signals, plan: LayoutPlan, previous: { spec: LayoutPlan; pinned: string[] } | null, pinned: string[]): string {
  const resets = previous !== null && layoutChanged(previous, { spec: plan, pinned });
  const context = { ...signals.context, pinned_sections: pinned, ...(resets ? { days_since_layout_change: 0 } : {}) };
  return signalsHash({ ...signals, context }, REGISTRY_VERSION);
}

/** Everything an open reads: his signals, the stored row, his preferences. */
export type BoardState = {
  signals: Signals;
  head: { spec: LayoutPlan; pinned: string[]; signalsHash: string | null; version: number; createdAt: Date | null } | null;
  preferences: LayoutPreference[];
  dynamic: { name: string; description: string }[];
  /** Views being built that a section stands in for meanwhile (SPEC §7.5). */
  wishes: { closestComponent: string | null; need: string }[];
};

/** Read what an open reads. */
export async function loadState(userId: string): Promise<BoardState> {
  const [signals, head, preferences, dynamic, wishes] = await Promise.all([
    computeSignals(userId),
    getPlanHead(userId),
    getPreferences(userId),
    listDynamicComponents(userId),
    openPriorityWishes(userId),
  ]);
  return {
    signals,
    head: head ? { spec: head.spec as LayoutPlan, pinned: head.pinned, signalsHash: head.signalsHash, version: head.version, createdAt: head.createdAt } : null,
    preferences,
    dynamic,
    wishes: wishes.map((w) => ({ closestComponent: w.closestComponent, need: w.need })),
  };
}

/**
 * What an open runs, on a state: the board that renders. No I/O beyond the
 * state it is given, so a request can run it on the state it is ABOUT to
 * write and answer with exactly what the next open will show (SPEC §2).
 * LLM → rules → held → default, every branch ending in the composition.
 */
export async function openOn(state: BoardState): Promise<{ plan: LayoutPlan; wantsLlmRefinement: boolean }> {
  const { signals, head, preferences } = state;
  const previousPlan = head?.spec ?? null;
  // The render path is synchronous-fast: rules or cache, never a model call.
  // The LLM refinement happens in persistPlan (background, after render) and
  // is served by the durable cache on the NEXT open.
  let plan: LayoutPlan;
  let wantsLlmRefinement = false;
  const compose = (system: LayoutPlan): LayoutPlan =>
    composePlan(system, { signals, stored: previousPlan, pinned: head?.pinned ?? [], preferences });
  if (signals.context.calm_mode) {
    // Invariant 7: DEFAULT_PLAN unconditionally — no planner of any kind.
    plan = compose(defaultPlan(signals));
  } else if (head?.signalsHash && head.signalsHash === signalsHash(signals, REGISTRY_VERSION) && previousPlan) {
    // Durable cache (SPEC §6): the stored board was written for exactly these
    // signals, so it is today's system plan → zero calls. The hash does not
    // carry everything the card order reads, which is why it is composed too.
    plan = compose(previousPlan);
  } else {
    ({ plan } = await planWithFallback(signals, {
      previousPlan,
      preferences,
      pinnedSections: head?.pinned ?? [],
      llmEnabled: false, // rules only on the render path
      dynamicComponents: state.dynamic,
    }));
    wantsLlmRefinement = true;
  }

  // F8 interim substitution (SPEC §7.5 tier 2): while a wished view is being
  // built, its closest component stands in — emphasized, with an honest why.
  if (!signals.context.calm_mode) {
    for (const wish of state.wishes) {
      const stand = plan.sections.find((s) => s.component === wish.closestComponent);
      if (!stand) continue;
      if (stand.component === "timeline") {
        stand.props = { ...stand.props, span_days: 14, expanded: true };
      }
      stand.why = `closest I have until the ${wish.need.split("—")[0].trim()} view is built`.slice(0, 140);
    }
  }
  return { plan, wantsLlmRefinement };
}

/** Compute the plan to render right now. */
export async function computeCurrentPlan(userId: string): Promise<PlanBundle> {
  const state = await loadState(userId);
  const { plan, wantsLlmRefinement } = await openOn(state);
  // A plan is "new" when its content differs — sections or reason. plan_id
  // embeds the signals hash, which drifts with time; comparing it would write
  // a new history row on every render.
  const changed = !state.head || planContent(state.head.spec) !== planContent(plan);
  return {
    plan,
    signals: state.signals,
    version: state.head?.version ?? 0,
    pinned: state.head?.pinned ?? [],
    updatedAt: state.head?.createdAt ?? null,
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
    // What this call itself stored the render's plan under, when it stored
    // one: the hash the next open will compute (hashOnceStored), which is
    // not `hash` when that row reset the layout clock. Such a row is this
    // situation's, and must not be stamped back to the hash from before it.
    let storedUnder: string | null = null;
    const forThisSituation = (stored: string | null | undefined) => stored === hash || (storedUnder !== null && stored === storedUnder);
    const stamp = async () => {
      const head = await getPlanHead(userId);
      if (head && !forThisSituation(head.signalsHash) && planContent(head.spec as LayoutPlan) === planContent(bundle.plan)) {
        await db.update(layoutSpecs).set({ signalsHash: hash }).where(eq(layoutSpecs.id, head.id));
      }
    };
    if (bundle.changed) {
      const head = await getPlanHead(userId);
      // Re-check under the fresh head (two renders can race; last write wins).
      if (!head || planContent(head.spec as LayoutPlan) !== planContent(bundle.plan)) {
        storedUnder = hashOnceStored(bundle.signals, bundle.plan, head ? { spec: head.spec as LayoutPlan, pinned: head.pinned } : null, placedOn(bundle.plan));
        await db.insert(layoutSpecs).values({
          userId,
          version: (head?.version ?? 0) + 1,
          spec: bundle.plan,
          // What he placed is what carries a place on this board (one home for a pin, SPEC §2).
          pinned: placedOn(bundle.plan),
          kind: "plan",
          signalsHash: storedUnder,
          reasonSummary: bundle.plan.reason_summary ?? null,
          outcome: "accepted",
        });
        await markPinPreferences(userId, placedOn(bundle.plan));
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
    } else if (refined.unanswered) {
      // Sent, and it never came back: counted at what was sent, so the cap
      // sees it (docs/spend/SPEC.md §1.2).
      const { recordUnanswered } = await import("@/lib/unanswered");
      await recordUnanswered({ userId, kind: "layout", ...refined.unanswered });
    }
    if (refined.source !== "llm" && refined.source !== "llm-cache") return await stamp();
    if (planContent(refined.plan) === planContent(bundle.plan)) return await stamp();
    const head = await getPlanHead(userId);
    // Only land the refinement if the situation hasn't moved on meanwhile.
    if (head?.signalsHash && !forThisSituation(head.signalsHash)) return;
    await db.insert(layoutSpecs).values({
      userId,
      version: (head?.version ?? 0) + 1,
      spec: refined.plan,
      pinned: placedOn(refined.plan),
      kind: "plan",
      signalsHash: hashOnceStored(bundle.signals, refined.plan, head ? { spec: head.spec as LayoutPlan, pinned: head.pinned } : null, placedOn(refined.plan)),
      reasonSummary: refined.plan.reason_summary ?? null,
      outcome: "accepted",
    });
  } catch (err) {
    console.error("persistPlan failed", err);
  }
}

/**
 * The keys of what he placed on a board: the sections that carry a place.
 * A pin has one home (SPEC §2): the place written on the section; the row's
 * `pinned` is this list, written with the board.
 */
export function placedOn(plan: LayoutPlan): string[] {
  return plan.sections.filter((s) => s.place !== undefined).map((s) => sectionKey(s));
}

/** A `pin_section` preference whose section now carries a place is marked, and no longer read as a pin (left, not deleted). */
export async function markPinPreferences(userId: string, placed: string[]): Promise<void> {
  if (!placed.length) return;
  const rows = await db.select().from(layoutPreferences).where(and(eq(layoutPreferences.userId, userId), eq(layoutPreferences.kind, "pin_section")));
  for (const row of rows) {
    const value = row.value as Record<string, string>;
    if (value.migrated === "1" || !placed.includes(value.section)) continue;
    await db.update(layoutPreferences).set({ value: { ...value, migrated: "1" } }).where(eq(layoutPreferences.id, row.id));
  }
}
