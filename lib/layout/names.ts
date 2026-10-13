// What people call each section of the board, first name first. One place,
// because the voice tool matches what was said against these, reads the
// board back in them, and every refusal names a section by them: a reply
// never shows a raw key (SPEC §2).
import type { PlanSection } from "./plan";

export const COMPONENT_NAMES: Record<string, string[]> = {
  focus_banner: ["banner", "focus banner"],
  hero_next_up: ["next up", "up next", "what's next", "hero"],
  stat_row: ["stats", "numbers", "stat row", "counts"],
  // The projects progress strip since registry v3 (SEC-A007); the first name
  // is what a read-back says ("Done: hid project progress.").
  timeline: ["project progress", "progress", "progress strip", "projects strip", "timeline"],
  date_chase: ["needs a date", "no date", "date chase", "undated"],
  people_index: ["people", "people index", "contacts"],
  documents: ["documents", "docs"],
  coming_up: ["coming up", "upcoming"],
  kanban: ["kanban", "board"],
  procrastination_zone: ["procrastination", "putting off", "procrastinating"],
  suggested_zone: ["suggestions", "suggested"],
};

export type NamedProject = { id: string; name: string; kind: string | null };

/** Every name a section answers to. */
export function namesOf(section: PlanSection, projects: Map<string, NamedProject>): string[] {
  if (section.component === "project_card") {
    const p = projects.get(String(section.props?.project_id));
    const name = p?.name ?? "project";
    return p?.kind === "list" ? [`${name} list`, name] : [name, `${name} project`];
  }
  return COMPONENT_NAMES[section.component] ?? [section.component.replaceAll("_", " ")];
}

/** The one name a section is called in a reply, from its key. */
export function nameOfKey(key: string, projects: Map<string, NamedProject>): string {
  // A card whose project has been deleted has no name left: say so, not the bare word "project".
  if (key.startsWith("project_card:") && !projects.has(key.slice("project_card:".length))) return "a project that is no longer there";
  if (key.startsWith("project_card:")) return namesOf({ component: "project_card", props: { project_id: key.slice("project_card:".length) } }, projects)[0];
  return namesOf({ component: key }, projects)[0];
}
