// Deterministic invariant checkers — pure code over DB state. These are the
// harness's teeth: every one of them encodes a bug class this app actually
// shipped at some point.
import { findDuplicate, findDuplicateEvent, titleSimilarity } from "@/lib/secretary/dedupe";
import { cfg } from "../config";
import type { TranscriptTurn, Violation } from "../fixtures/types";
import type { Row, Snapshot, StateDiff } from "../snapshot";
import { classifyClaims, type ClaimCategory } from "./claims";

export type CheckerContext = {
  endState: Snapshot;
  endDiff: StateDiff; // scenario start → end
  turnDiffs: { turn: number; diff: StateDiff }[];
  transcript: TranscriptTurn[];
  canaryBefore: Snapshot | null;
  canaryAfter: Snapshot | null;
  canaryProbes: { messages404: boolean; tasksScoped: boolean } | null;
};

const OPEN = new Set(["inbox", "todo", "in_progress", "blocked"]);

function openTasks(state: Snapshot): Row[] {
  return [...state.tasks.values()].filter((t) => OPEN.has(t.status as string));
}

export function checkDuplicates(ctx: CheckerContext): Violation[] {
  const out: Violation[] = [];
  const open = openTasks(ctx.endState);
  for (let i = 0; i < open.length; i++) {
    const rest = open.slice(i + 1).map((r) => ({
      ...r,
      title: r.title as string,
      dueAt: r.dueAt as Date | null,
    }));
    const dup = findDuplicate(
      { title: open[i].title as string, dueAt: open[i].dueAt as Date | null },
      rest,
      cfg.dupThreshold
    );
    if (dup) {
      out.push({
        severity: "error",
        checker: "duplicate_open_tasks",
        turn: null,
        summary: `Duplicate open tasks (similarity ≥ ${cfg.dupThreshold}): "${open[i].title}" / "${dup.title}"`,
        evidence: { ids: [open[i].id, dup.id] },
      });
    }
  }
  const events = [...ctx.endState.events.values()].map((r) => ({
    ...r,
    title: r.title as string,
    startsAt: r.startsAt as Date,
  }));
  for (let i = 0; i < events.length; i++) {
    const dup = findDuplicateEvent(
      { title: events[i].title, startsAt: events[i].startsAt },
      events.slice(i + 1),
      cfg.dupThreshold
    );
    if (dup) {
      out.push({
        severity: "error",
        checker: "duplicate_events",
        turn: null,
        summary: `Duplicate events: "${events[i].title}" / "${dup.title}"`,
        evidence: { ids: [events[i].id, dup.id] },
      });
    }
  }
  return out;
}

/** Does a turn's diff contain evidence for a claim category? */
function diffSatisfies(diff: StateDiff, category: ClaimCategory): boolean {
  switch (category) {
    case "created":
      return (
        diff.tasks.created.length > 0 ||
        diff.events.created.length > 0 ||
        diff.projects.created.length > 0 ||
        diff.documents.created.length > 0 ||
        diff.memories.created.length > 0
      );
    case "completed":
      return (
        diff.tasks.updated.some((u) =>
          u.changed.some(
            (c) =>
              (c.field === "status" && c.after === "done") ||
              (c.field === "stages" &&
                JSON.stringify(c.after ?? "").split('"done":true').length >
                  JSON.stringify(c.before ?? "").split('"done":true').length)
          )
        ) || diff.tasks.created.some((t) => t.status === "done")
      );
    case "moved":
      return (
        diff.tasks.updated.some((u) =>
          u.changed.some((c) => c.field === "dueAt" || c.field === "projectId" || c.field === "status")
        ) || diff.events.updated.some((u) => u.changed.some((c) => c.field === "startsAt" || c.field === "projectId"))
      );
    case "reminder":
      return (
        diff.tasks.updated.some((u) => u.changed.some((c) => c.field === "reminders")) ||
        diff.events.updated.some((u) => u.changed.some((c) => c.field === "reminders")) ||
        diff.tasks.created.some((t) => ((t.reminders as unknown[]) ?? []).length > 0) ||
        diff.events.created.some((e) => ((e.reminders as unknown[]) ?? []).length > 0)
      );
    case "merged":
      return diff.projects.deleted.length > 0 && diff.tasks.updated.some((u) => u.changed.some((c) => c.field === "projectId"));
    case "edited":
      return (
        diff.tasks.updated.length > 0 ||
        diff.events.updated.length > 0 ||
        diff.documents.updated.length > 0 ||
        diff.projects.updated.length > 0
      );
    case "deleted":
      return (
        diff.tasks.deleted.length > 0 ||
        diff.events.deleted.length > 0 ||
        diff.documents.deleted.length > 0 ||
        diff.projects.deleted.length > 0 ||
        // "removed/cancelled" often means status → dropped
        diff.tasks.updated.some((u) => u.changed.some((c) => c.field === "status" && c.after === "dropped"))
      );
  }
}

export function checkClaimsVsWrites(ctx: CheckerContext): Violation[] {
  const out: Violation[] = [];
  for (const turn of ctx.transcript) {
    const claims = classifyClaims(turn.assistant);
    if (claims.length === 0) continue;
    const turnDiff = ctx.turnDiffs.find((t) => t.turn === turn.turn)?.diff;
    if (!turnDiff) continue;
    for (const claim of claims) {
      if (!diffSatisfies(turnDiff, claim)) {
        out.push({
          severity: "error",
          checker: "claims_vs_writes",
          turn: turn.turn,
          summary: `Assistant claimed "${claim}" but the database shows no matching write this turn`,
          evidence: { assistantText: turn.assistant.slice(0, 300), claim },
        });
      }
    }
  }
  return out;
}

export function checkUnfiledProjectMention(ctx: CheckerContext): Violation[] {
  const out: Violation[] = [];
  const projectNames = [...ctx.endState.projects.values()].map((p) => p.name as string);
  if (projectNames.length === 0) return out;
  for (const t of openTasks(ctx.endState)) {
    if (t.projectId) continue;
    const text = `${t.title} ${t.notes ?? ""}`;
    const hit = projectNames.find(
      (n) => text.toLowerCase().includes(n.toLowerCase()) || titleSimilarity(text, n) >= 0.6
    );
    if (hit) {
      out.push({
        severity: "warn",
        checker: "unfiled_project_mention",
        turn: null,
        summary: `Unfiled task "${t.title}" mentions existing project "${hit}"`,
        evidence: { taskId: t.id },
      });
    }
  }
  return out;
}

export function checkRecurrenceSpawn(ctx: CheckerContext): Violation[] {
  const out: Violation[] = [];
  const completedRecurring = ctx.endDiff.tasks.updated.filter(
    (u) => u.after.recurrence && u.changed.some((c) => c.field === "status" && c.after === "done")
  );
  for (const done of completedRecurring) {
    const successors = ctx.endDiff.tasks.created.filter(
      (t) =>
        titleSimilarity(t.title as string, done.after.title as string) >= 0.6 &&
        t.recurrence === done.after.recurrence &&
        OPEN.has(t.status as string)
    );
    if (successors.length !== 1) {
      out.push({
        severity: "error",
        checker: "recurrence_spawn_exactly_one",
        turn: null,
        summary: `Recurring "${done.after.title}" completed → ${successors.length} successor(s), expected exactly 1`,
        evidence: { taskId: done.id },
      });
    }
  }
  return out;
}

export function checkRemindersStages(ctx: CheckerContext): Violation[] {
  const out: Violation[] = [];
  for (const table of ["tasks", "events"] as const) {
    for (const r of ctx.endState[table].values()) {
      for (const iso of (r.reminders as string[]) ?? []) {
        if (Number.isNaN(new Date(iso).getTime())) {
          out.push({
            severity: "error",
            checker: "reminders_stages_roundtrip",
            turn: null,
            summary: `Unparseable reminder "${iso}" on ${table} "${r.title}"`,
          });
        }
      }
    }
  }
  for (const t of ctx.endState.tasks.values()) {
    for (const s of (t.stages as { name?: unknown; done?: unknown }[]) ?? []) {
      if (typeof s.name !== "string" || typeof s.done !== "boolean") {
        out.push({
          severity: "error",
          checker: "reminders_stages_roundtrip",
          turn: null,
          summary: `Malformed stage entry on task "${t.title}": ${JSON.stringify(s)}`,
        });
      }
    }
  }
  // stage flips never regress within a scenario
  for (const u of ctx.endDiff.tasks.updated) {
    const change = u.changed.find((c) => c.field === "stages");
    if (!change) continue;
    const before = (change.before as { name: string; done: boolean }[]) ?? [];
    const after = (change.after as { name: string; done: boolean }[]) ?? [];
    for (const b of before) {
      const a = after.find((x) => x.name === b.name);
      if (b.done && a && !a.done) {
        out.push({
          severity: "error",
          checker: "reminders_stages_roundtrip",
          turn: null,
          summary: `Stage "${b.name}" on "${u.after.title}" regressed from done to not-done`,
        });
      }
    }
  }
  return out;
}

export function checkCanary(ctx: CheckerContext): Violation[] {
  const out: Violation[] = [];
  if (ctx.canaryBefore && ctx.canaryAfter) {
    for (const table of Object.keys(ctx.canaryBefore) as (keyof Snapshot)[]) {
      const b = ctx.canaryBefore[table];
      const a = ctx.canaryAfter[table];
      if (b.size !== a.size) {
        out.push({
          severity: "error",
          checker: "cross_user_isolation",
          turn: null,
          summary: `Canary ${table} row count changed ${b.size} → ${a.size} during another user's scenario`,
        });
      }
    }
  }
  if (ctx.canaryProbes) {
    if (!ctx.canaryProbes.messages404) {
      out.push({
        severity: "error",
        checker: "cross_user_isolation",
        turn: null,
        summary: "Canary could read another user's conversation messages (expected 404)",
      });
    }
    if (!ctx.canaryProbes.tasksScoped) {
      out.push({
        severity: "error",
        checker: "cross_user_isolation",
        turn: null,
        summary: "Canary's get_tasks returned rows that aren't the canary's",
      });
    }
  }
  return out;
}

export function checkDbIntegrity(ctx: CheckerContext): Violation[] {
  const out: Violation[] = [];
  for (const t of ctx.endState.tasks.values()) {
    if (t.status === "done" && !t.completedAt) {
      out.push({
        severity: "warn",
        checker: "db_integrity",
        turn: null,
        summary: `Task "${t.title}" is done but completedAt is null`,
      });
    }
  }
  for (const e of ctx.endState.events.values()) {
    if (e.endsAt && new Date(e.endsAt as Date).getTime() < new Date(e.startsAt as Date).getTime()) {
      out.push({
        severity: "warn",
        checker: "db_integrity",
        turn: null,
        summary: `Event "${e.title}" ends before it starts`,
      });
    }
  }
  // document edited ⇒ a version snapshot must have been taken
  const docEdits = ctx.endDiff.documents.updated.filter((u) =>
    u.changed.some((c) => c.field === "sections")
  );
  if (docEdits.length > 0 && ctx.endDiff.documentVersions.created.length === 0) {
    out.push({
      severity: "error",
      checker: "db_integrity",
      turn: null,
      summary: "Document sections changed but no version snapshot was created",
    });
  }
  return out;
}

export function runAllCheckers(ctx: CheckerContext): Violation[] {
  return [
    ...checkDuplicates(ctx),
    ...checkClaimsVsWrites(ctx),
    ...checkUnfiledProjectMention(ctx),
    ...checkRecurrenceSpawn(ctx),
    ...checkRemindersStages(ctx),
    ...checkCanary(ctx),
    ...checkDbIntegrity(ctx),
  ];
}
