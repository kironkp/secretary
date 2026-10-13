// arrange_dashboard: the user moves, hides and shows sections of the Overview
// by NAME ("put the shopping list at the top"), by voice or in the chat. It
// turns what was said into plain operations and hands them to the one
// function every request goes through (lib/layout/request.ts, SPEC §2).
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { titleSimilarity } from "@/lib/secretary/dedupe";
import { COMPONENT_NAMES, namesOf, type NamedProject } from "./names";
import { defaultPlan, sectionKey, type LayoutPlan, type PlanSection } from "./plan";
import { computeCurrentPlan, getPreferences } from "./plan-store";
import { requestBoard, type BoardOp } from "./request";

export const ARRANGE_OPS = ["move_to_top", "move_up", "move_down", "move_to_bottom", "hide", "show"] as const;
export type ArrangeOp = { op: (typeof ARRANGE_OPS)[number]; section: string };

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
  const [bundle, prefs, projectRows] = await Promise.all([
    computeCurrentPlan(userId),
    getPreferences(userId),
    db
      .select({ id: projects.id, name: projects.name, kind: projects.kind })
      .from(projects)
      .where(and(eq(projects.userId, userId), ne(projects.status, "archived"))),
  ]);
  const byId = new Map<string, NamedProject>(projectRows.map((p) => [p.id, p]));
  const named = (s: PlanSection): Named => ({ key: sectionKey(s), names: namesOf(s, byId), section: s });
  // What is on the board, and what could be brought onto it: what he hid
  // (earlier, or a moment ago in this same request), every project's card,
  // every section of the default board.
  const here = new Map(bundle.plan.sections.map((s) => [sectionKey(s), s]));
  const hidden = prefs.filter((p) => p.kind === "hide_section").map((p) => p.value.section);
  /** Taken off the board by this request. A section he added is in no other list: without this, "hide it, show it" found nothing to show. */
  const taken = new Map<string, PlanSection>();
  const away = (): Named[] => {
    const all: PlanSection[] = [
      ...taken.values(),
      ...projectRows.map((p): PlanSection => ({ component: "project_card", props: { project_id: p.id, variant: "full" } })),
      ...defaultPlan(bundle.signals).sections.filter((s) => s.component !== "project_card"),
      ...hidden.filter((key) => !key.startsWith("project_card:")).map((key): PlanSection => ({ component: key })),
    ];
    const seen = new Set<string>();
    return all.filter((s) => !here.has(sectionKey(s)) && !seen.has(sectionKey(s)) && seen.add(sectionKey(s))).map(named);
  };

  const request: BoardOp[] = [];
  const changed: string[] = [];
  for (const op of ops) {
    let hit: Named;
    const onBoard = pick(op.section, [...here.values()].map(named));
    if ("hit" in onBoard) hit = onBoard.hit;
    else if (op.op === "hide") return { ok: false, error: onBoard.error };
    else {
      // "Show the timeline", or "put the shopping list at the top" when it is not on the board yet.
      const off = pick(op.section, away());
      if (!("hit" in off)) return { ok: false, error: onBoard.error };
      hit = off.hit;
    }
    if (op.op === "hide") {
      request.push({ op: "hide", key: hit.key });
      here.delete(hit.key);
      taken.set(hit.key, hit.section);
      changed.push(`hid ${hit.names[0]}`);
    } else if (op.op === "show") {
      request.push({ op: "show", key: hit.key });
      here.set(hit.key, hit.section);
      changed.push(`showed ${hit.names[0]}`);
    } else {
      const to = ({ move_to_top: "top", move_to_bottom: "bottom", move_up: "up", move_down: "down" } as const)[op.op];
      request.push({ op: "move", key: hit.key, to });
      here.set(hit.key, hit.section);
      changed.push(`moved ${hit.names[0]} ${{ top: "to the top", bottom: "to the bottom", up: "up", down: "down" }[to]}`);
    }
  }
  const reply = await requestBoard(userId, { ops: request });
  if (!reply.ok) return { ok: false, error: reply.error };
  return { ok: true, version: reply.version, sections: reply.plan.sections.map((s) => named(s).names[0]), changed };
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
