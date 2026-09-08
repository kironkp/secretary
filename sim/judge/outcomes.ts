// Deterministic expected_outcome matcher: scenario expectations vs the
// end-state diff + final DB rows. Failures here are error-severity — the
// scenario's contract was explicit.
import { titleSimilarity } from "@/lib/secretary/dedupe";
import type { ExpectedOutcome, Violation } from "../fixtures/types";
import type { Row, StateDiff } from "../snapshot";

const DAY = 86400000;
const TOLERANCE = 36 * 60 * 60 * 1000; // matches extraction's DATE_TOLERANCE_MS

/** Fuzzy match; `b` may hold alternatives ("grocer|food") — any may match. */
function like(a: string, b: string): boolean {
  return b.split("|").some(
    (alt) =>
      a.toLowerCase().includes(alt.toLowerCase()) ||
      alt.toLowerCase().includes(a.toLowerCase()) ||
      titleSimilarity(a, alt) >= 0.6
  );
}

function resolveDue(spec: string, now: Date): Date | null {
  if (spec === "today") return now;
  const rel = spec.match(/^\+(\d+)d$/);
  if (rel) return new Date(now.getTime() + Number(rel[1]) * DAY);
  const abs = new Date(spec);
  return Number.isNaN(abs.getTime()) ? null : abs;
}

function dueMatches(rowDue: unknown, spec: string | undefined, now: Date): boolean {
  if (!spec) return true;
  if (!rowDue) return false;
  const want = resolveDue(spec, now);
  if (!want) return true;
  return Math.abs(new Date(rowDue as string | Date).getTime() - want.getTime()) <= TOLERANCE;
}

export function matchOutcomes(opts: {
  outcomes: ExpectedOutcome[];
  endDiff: StateDiff;
  endTasks: Row[];
  endEvents: Row[];
  projectNamesById: Map<string, string>;
}): { violations: Violation[]; unmatchedForLlm: ExpectedOutcome[] } {
  const { outcomes, endDiff, endTasks, endEvents, projectNamesById } = opts;
  const now = new Date();
  const violations: Violation[] = [];
  const unmatchedForLlm: ExpectedOutcome[] = [];

  const fail = (o: ExpectedOutcome, why: string) =>
    violations.push({
      severity: "error",
      checker: "expected_outcome",
      turn: null,
      summary: `${o.kind}: ${why}`,
      evidence: { outcome: o },
    });

  const projectNameOf = (row: Row): string | null =>
    row.projectId ? (projectNamesById.get(row.projectId as string) ?? null) : null;

  for (const o of outcomes) {
    switch (o.kind) {
      case "none":
        break;
      case "task_created": {
        const hits = endDiff.tasks.created.filter((r) => like(r.title as string, o.title_like));
        if (hits.length === 0) {
          fail(o, `no created task like "${o.title_like}"`);
          break;
        }
        if (o.count !== undefined && hits.length !== o.count) {
          fail(o, `expected ${o.count} task(s) like "${o.title_like}", found ${hits.length}`);
          break;
        }
        const t = hits[0];
        if (!dueMatches(t.dueAt, o.due, now)) fail(o, `due mismatch for "${t.title}" (wanted ${o.due})`);
        if (o.project && !like(projectNameOf(t) ?? "", o.project))
          fail(o, `"${t.title}" filed under "${projectNameOf(t) ?? "nothing"}", wanted "${o.project}"`);
        if (o.recurrence && t.recurrence !== o.recurrence)
          fail(o, `recurrence "${t.recurrence}" ≠ "${o.recurrence}"`);
        if (o.reminders_count !== undefined && (t.reminders as unknown[]).length !== o.reminders_count)
          fail(o, `${(t.reminders as unknown[]).length} reminder(s), wanted ${o.reminders_count}`);
        if (o.stages_count !== undefined && (t.stages as unknown[]).length !== o.stages_count)
          fail(o, `${(t.stages as unknown[]).length} stage(s), wanted ${o.stages_count}`);
        break;
      }
      case "task_updated": {
        const hit = endDiff.tasks.updated.find((u) => like(u.after.title as string, o.title_like));
        if (!hit) {
          fail(o, `no updated task like "${o.title_like}"`);
          break;
        }
        if (o.status && hit.after.status !== o.status)
          fail(o, `status "${hit.after.status}" ≠ "${o.status}"`);
        if (o.due && !dueMatches(hit.after.dueAt, o.due, now)) fail(o, `due mismatch`);
        if (o.blocked_reason) {
          // `like` treats "" as a substring of everything — an unrecorded
          // blocker must fail, not match by accident.
          const recorded = String(hit.after.blockedReason ?? "");
          if (!recorded || !like(recorded, o.blocked_reason))
            fail(o, `blocker "${recorded || "(none recorded)"}" ≠ "${o.blocked_reason}"`);
        }
        if (o.stage_done) {
          const stages = hit.after.stages as { name: string; done: boolean }[];
          const s = stages.find((x) => like(x.name, o.stage_done!));
          if (!s?.done) fail(o, `stage "${o.stage_done}" not marked done`);
        }
        break;
      }
      case "task_completed": {
        const done =
          endDiff.tasks.updated.some(
            (u) => like(u.after.title as string, o.title_like) && u.after.status === "done"
          ) ||
          endTasks.some((t) => like(t.title as string, o.title_like) && t.status === "done");
        if (!done) fail(o, `task like "${o.title_like}" not completed`);
        break;
      }
      case "event_created": {
        const hits = endDiff.events.created.filter((r) => like(r.title as string, o.title_like));
        if (hits.length === 0) {
          fail(o, `no created event like "${o.title_like}"`);
          break;
        }
        const e = hits[0];
        if (o.project && !like(projectNameOf(e) ?? "", o.project))
          fail(o, `event filed under "${projectNameOf(e) ?? "nothing"}", wanted "${o.project}"`);
        if (o.reminders_count !== undefined && (e.reminders as unknown[]).length !== o.reminders_count)
          fail(o, `${(e.reminders as unknown[]).length} reminder(s), wanted ${o.reminders_count}`);
        break;
      }
      case "event_updated": {
        if (!endDiff.events.updated.some((u) => like(u.after.title as string, o.title_like)))
          fail(o, `no updated event like "${o.title_like}"`);
        break;
      }
      case "event_deleted": {
        if (!endDiff.events.deleted.some((r) => like(r.title as string, o.title_like)))
          fail(o, `no deleted event like "${o.title_like}"`);
        break;
      }
      case "project_created": {
        if (!endDiff.projects.created.some((r) => like(r.name as string, o.name_like)))
          fail(o, `no created project like "${o.name_like}"`);
        break;
      }
      case "task_filed": {
        const t = endTasks.find((r) => like(r.title as string, o.title_like));
        if (!t) {
          fail(o, `no task like "${o.title_like}"`);
          break;
        }
        if (!like(projectNameOf(t) ?? "", o.project))
          fail(o, `"${t.title}" in "${projectNameOf(t) ?? "no project"}", wanted "${o.project}"`);
        break;
      }
      case "document_created": {
        if (!endDiff.documents.created.some((r) => like(r.title as string, o.title_like)))
          fail(o, `no created document like "${o.title_like}"`);
        break;
      }
      case "document_section_edited": {
        // "edited" is satisfied by an update OR by creation-with-content
        // within the scenario (start→end diff collapses create-then-edit).
        const updated = endDiff.documents.updated.find(
          (u) => like(u.after.title as string, o.doc_like) && u.changed.some((c) => c.field === "sections")
        );
        const createdWithContent = endDiff.documents.created.find((r) => {
          if (!like(r.title as string, o.doc_like)) return false;
          const sections = (r.sections as { heading: string; content: string }[]) ?? [];
          const target = o.section_like
            ? sections.filter((s) => like(s.heading, o.section_like!))
            : sections;
          return target.some((s) => s.content.trim().length > 20);
        });
        if (updated) {
          if (o.section_like) {
            const sections = updated.after.sections as { heading: string; content: string }[];
            const s = sections.find((x) => like(x.heading, o.section_like!));
            if (!s) fail(o, `no section like "${o.section_like}" in the edited document`);
            else if (s.content.trim().length <= 20)
              fail(o, `section "${s.heading}" has no real content after the edit`);
          }
        } else if (!createdWithContent) {
          fail(o, `document like "${o.doc_like}" was neither edited nor created with content in "${o.section_like ?? "any section"}"`);
        }
        break;
      }
      case "memory_created": {
        if (!endDiff.memories.created.some((r) => like(r.fact as string, o.fact_like)))
          fail(o, `no memory like "${o.fact_like}"`);
        break;
      }
      case "no_duplicate": {
        const rows = (o.table === "tasks" ? endTasks : endEvents).filter(
          (r) =>
            like(r.title as string, o.title_like) &&
            (o.table !== "tasks" || !["done", "dropped"].includes(r.status as string))
        );
        if (rows.length > 1)
          fail(o, `${rows.length} rows like "${o.title_like}" — duplicates exist`);
        break;
      }
      case "recurrence_respawn": {
        const open = endTasks.filter(
          (t) =>
            like(t.title as string, o.title_like) &&
            !["done", "dropped"].includes(t.status as string) &&
            t.recurrence
        );
        const done = endTasks.filter(
          (t) => like(t.title as string, o.title_like) && t.status === "done"
        );
        if (done.length === 0 || open.length !== 1)
          fail(o, `expected 1 done + exactly 1 respawned open occurrence, got ${done.length} done / ${open.length} open`);
        break;
      }
      default:
        unmatchedForLlm.push(o);
    }
  }
  return { violations, unmatchedForLlm };
}
