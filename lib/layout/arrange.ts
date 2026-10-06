// "Put the shopping list at the top of the dashboard" (SEC-A003, 2026-10-06):
// the user's words → section keys → the board as they asked, at once, with no
// model call for the geometry. The voice session had no layout tool at all,
// so it answered "Sure, let me move that" and then "I can't move the
// dashboard sections with the tools I have right now."
//
// User-initiated (validator invariant 3): no movement rationing. What the
// user placed is pinned, so the background planner cannot move it back, and
// "hide" is a hide_section preference, so no planner brings it back either.
// Structural rules still hold: an urgent project's card cannot be hidden.
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { layoutPreferences, projects } from "@/lib/db/schema";
import { titleSimilarity } from "@/lib/secretary/dedupe";
import { computeCurrentPlan, getPreferences, savePlanAsHead } from "./plan-store";
import { defaultPlan, sectionKey, type LayoutPlan, type PlanSection } from "./plan";
import { listDynamicComponents } from "./slow-loop";
import { validatePlan } from "./validator";

export const ARRANGE_OPS = ["move_to_top", "move_up", "move_down", "move_to_bottom", "hide", "show"] as const;
export type ArrangeOp = { op: (typeof ARRANGE_OPS)[number]; section: string };

/** What people call each section, first name first. */
const COMPONENT_NAMES: Record<string, string[]> = {
  focus_banner: ["banner", "focus banner"],
  hero_next_up: ["next up", "up next", "what's next", "hero"],
  stat_row: ["stats", "numbers", "stat row", "counts"],
  timeline: ["timeline", "calendar strip"],
  open_loops: ["open loops", "loops", "open items", "to-dos", "todos"],
  date_chase: ["needs a date", "no date", "date chase", "undated"],
  people_index: ["people", "people index", "contacts"],
  documents: ["documents", "docs"],
  coming_up: ["coming up", "upcoming"],
  kanban: ["kanban", "board"],
  procrastination_zone: ["procrastination", "putting off", "procrastinating"],
  suggested_zone: ["suggestions", "suggested"],
};

type Named = { key: string; names: string[]; section: PlanSection };

const clean = (words: string) =>
  words
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/^\s*(the|my|our)\s+/, "")
    .replace(/\s+(section|card|box|widget|panel|area)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

/** The one section the words name, among `candidates`; or why not. */
function pick(words: string, candidates: Named[]): { hit: Named } | { error: string } {
  const w = clean(words);
  const scored = candidates.map((c) => {
    const names = c.names.map(clean);
    const score = names.includes(w)
      ? 3
      : names.some((n) => w === `${n} list` || n === `${w} list` || w.startsWith(`${n} `) || n.startsWith(`${w} `))
        ? 2
        : Math.max(...names.map((n) => titleSimilarity(n, w))) >= 0.75
          ? 1
          : 0;
    return { c, score };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best && best > 0);
  if (top.length === 1) return { hit: top[0].c };
  if (top.length === 0) {
    return { error: `There's no "${words}" on the dashboard. It has: ${candidates.map((c) => c.names[0]).join(", ")}.` };
  }
  return { error: `"${words}" could be ${top.map((t) => t.c.names[0]).join(" or ")}. Which one?` };
}

export type ArrangeResult =
  | { ok: true; version: number; sections: string[]; changed: string[] }
  | { ok: false; error: string };

/** Apply the user's moves to the board they see now, and keep them there. */
export async function arrangeDashboard(userId: string, ops: ArrangeOp[]): Promise<ArrangeResult> {
  const [bundle, prefs, projectRows, dynamic] = await Promise.all([
    computeCurrentPlan(userId),
    getPreferences(userId),
    db
      .select({ id: projects.id, name: projects.name, kind: projects.kind })
      .from(projects)
      .where(and(eq(projects.userId, userId), ne(projects.status, "archived"))),
    listDynamicComponents(userId),
  ]);
  const current = bundle.plan;
  const sections: PlanSection[] = structuredClone(current.sections);
  const byId = new Map(projectRows.map((p) => [p.id, p]));

  const named = (s: PlanSection): Named => {
    const key = sectionKey(s);
    if (s.component === "project_card") {
      const p = byId.get(String(s.props?.project_id));
      const name = p?.name ?? "project";
      const names = p?.kind === "list" ? [`${name} list`, name] : [name, `${name} project`];
      return { key, names, section: s };
    }
    return { key, names: COMPONENT_NAMES[s.component] ?? [s.component.replaceAll("_", " ")], section: s };
  };
  // What "show" can bring back: every project, and every section of the default board.
  const offBoard = (): Named[] => {
    const here = new Set(sections.map((s) => sectionKey(s)));
    const all: PlanSection[] = [
      ...projectRows.map((p): PlanSection => ({ component: "project_card", props: { project_id: p.id, variant: "full" } })),
      ...defaultPlan(bundle.signals).sections.filter((s) => s.component !== "project_card"),
    ];
    return all.filter((s) => !here.has(sectionKey(s))).map(named);
  };

  const pins = new Set<string>();
  const hide: string[] = [];
  const unhide: string[] = [];
  const changed: string[] = [];
  const hiddenNow = new Set(prefs.filter((p) => p.kind === "hide_section").map((p) => p.value.section));

  for (const op of ops) {
    let hit: Named;
    const onBoard = pick(op.section, sections.map(named));
    if ("hit" in onBoard) hit = onBoard.hit;
    else if (op.op === "hide") return { ok: false, error: onBoard.error };
    else {
      // "Show the timeline", or "put the shopping list at the top" when it
      // isn't on the board yet: bring it onto the board first.
      const away = pick(op.section, offBoard());
      if (!("hit" in away)) return { ok: false, error: onBoard.error };
      hit = away.hit;
      sections.push(hit.section);
    }
    if (hiddenNow.has(hit.key) && op.op !== "hide") unhide.push(hit.key);

    const idx = sections.findIndex((s) => sectionKey(s) === hit.key);
    if (op.op === "hide") {
      sections.splice(idx, 1);
      hide.push(hit.key);
      pins.delete(hit.key);
      changed.push(`hid ${hit.names[0]}`);
      continue;
    }
    if (op.op === "show") {
      pins.add(hit.key);
      changed.push(`showed ${hit.names[0]}`);
      continue;
    }
    const [moved] = sections.splice(idx, 1);
    // A focus banner owns the very top (validator); "the top" is just under it.
    const top = sections[0]?.component === "focus_banner" ? 1 : 0;
    const to =
      op.op === "move_to_top"
        ? top
        : op.op === "move_to_bottom"
          ? sections.length
          : op.op === "move_up"
            ? Math.max(top, idx - 1)
            : Math.min(sections.length, idx + 1);
    sections.splice(to, 0, moved);
    pins.add(hit.key);
    const where = { move_to_top: "to the top", move_to_bottom: "to the bottom", move_up: "up", move_down: "down" }[op.op];
    changed.push(`moved ${hit.names[0]} ${where}`);
  }

  const candidate: LayoutPlan = {
    plan_id: `user-${Date.now().toString(36)}`,
    reason_summary: current.reason_summary ?? null,
    sections,
  };
  // User-initiated: no movement rationing, no pins against the user's own
  // move; the structural invariants still hold.
  const v = validatePlan(candidate, {
    signals: bundle.signals,
    previousPlan: current,
    preferences: prefs.filter((p) => p.kind !== "hide_section"),
    pinnedSections: [],
    defaultPlan: defaultPlan(bundle.signals),
    userInitiated: true,
    dynamicComponents: dynamic.map((d) => d.name),
  });
  if (!v.ok) return { ok: false, error: `That would break a dashboard rule: ${v.reasons.join("; ")}. Nothing was changed.` };

  for (const key of unhide) {
    await db
      .delete(layoutPreferences)
      .where(and(eq(layoutPreferences.userId, userId), eq(layoutPreferences.kind, "hide_section"), sql`${layoutPreferences.value}->>'section' = ${key}`));
  }
  for (const key of hide) {
    if (!hiddenNow.has(key)) {
      await db.insert(layoutPreferences).values({ userId, kind: "hide_section", value: { section: key } });
    }
  }
  const version = await savePlanAsHead(userId, v.plan, [...pins]);
  return { ok: true, version, sections: v.plan.sections.map((s) => named(s).names[0]), changed };
}

/** The board's sections as people call them, top to bottom (for the briefing). */
export async function boardSectionNames(userId: string, plan: LayoutPlan): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, kind: projects.kind })
    .from(projects)
    .where(eq(projects.userId, userId));
  const byId = new Map(rows.map((p) => [p.id, p]));
  return plan.sections.map((s) => {
    if (s.component === "project_card") {
      const p = byId.get(String(s.props?.project_id));
      return p ? (p.kind === "list" ? `${p.name} list` : p.name) : "a project";
    }
    return (COMPONENT_NAMES[s.component] ?? [s.component.replaceAll("_", " ")])[0];
  });
}
