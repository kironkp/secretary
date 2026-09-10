// Rebuild the canvas from live task data, without a model call.
//
// The painter is a model and costs money and time; this composes the same shape
// deterministically from the database, so every data-check id is guaranteed to
// be a real task belonging to the user. Useful when the canvas is stale, when
// its ids no longer resolve, or when you want a known-good canvas to test the
// interaction against.
//
//   npx tsx --env-file=.env.local scripts/canvas-reset.ts <userEmail>
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { canvasSnapshots, projects, tasks, user } from "@/lib/db/schema";
import { compositionFromMarkup, compositionToMarkup } from "@/lib/canvas/composition";
import { sanitizeCanvasMarkup } from "@/lib/canvas/sanitize";

const OPEN = ["inbox", "todo", "in_progress", "blocked"] as const;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One task row: data-check carries the id the shell ticks. NOTE there is no
 *  painted checkbox — the shell draws it, and a model-drawn one would be a
 *  decoy the user could tap forever with nothing happening. */
function taskRow(t: { id: string; title: string; status: string }, projectId: string | null) {
  const done = t.status === "done";
  return (
    `<div data-check="${t.id}"${projectId ? ` data-link="${projectId}"` : ""}` +
    ` style="padding:13px 0;border-top:1px solid var(--edge)">` +
    `<div style="font-size:16px;color:var(--ink)">${esc(t.title)}</div>` +
    `<div style="margin-top:6px"><span style="font-size:11px;padding:3px 9px;border-radius:999px;` +
    `border:1px solid var(--edge);color:var(--muted)">${done ? "DONE" : t.status.toUpperCase()}</span></div>` +
    `</div>`
  );
}

function block(id: string, eyebrow: string, tone: string, sub: string, rows: string[]) {
  return (
    `<div id="${id}" style="background:var(--card);border:1px solid var(--edge);border-radius:16px;` +
    `padding:18px;margin-bottom:16px">` +
    `<div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--${tone});` +
    `font-weight:700;margin-bottom:4px">${esc(eyebrow)}</div>` +
    `<div style="font-size:12px;color:var(--muted);margin-bottom:14px">${esc(sub)}</div>` +
    rows.join("") +
    `</div>`
  );
}

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("usage: canvas-reset.ts <userEmail>");
  const [owner] = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!owner) throw new Error(`no user with email ${email}`);

  const rows = await db
    .select({ task: tasks, projectId: projects.id, projectName: projects.name })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(tasks.userId, owner.id),
        or(inArray(tasks.status, [...OPEN]), eq(tasks.status, "done"))
      )
    )
    .orderBy(asc(tasks.dueAt));

  const open = rows.filter((r) => (OPEN as readonly string[]).includes(r.task.status));
  const doneToday = rows
    .filter((r) => r.task.status === "done" && r.task.completedAt)
    .sort((a, b) => (b.task.completedAt!.getTime() ?? 0) - (a.task.completedAt!.getTime() ?? 0))
    .slice(0, 5);

  // Group open work by project so the canvas reads the way the painter's does.
  const byProject = new Map<string, typeof open>();
  for (const r of open) {
    const key = r.projectName ?? "Unfiled";
    byProject.set(key, [...(byProject.get(key) ?? []), r]);
  }

  const blocks: string[] = [];
  let n = 0;
  for (const [name, items] of [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)) {
    blocks.push(
      block(
        `proj-${++n}`,
        name,
        n === 1 ? "danger" : "accent",
        `${items.length} open · tap a checkbox to tick it, tap again to undo`,
        items.slice(0, 8).map((r) => taskRow(r.task, r.projectId))
      )
    );
  }
  if (doneToday.length) {
    blocks.push(
      block(
        "recently-done",
        "Recently done",
        "ok",
        "Ticked already — tap one to put it back",
        doneToday.map((r) => taskRow(r.task, r.projectId))
      )
    );
  }
  if (!blocks.length) throw new Error("no open or completed tasks to draw");

  const markup = sanitizeCanvasMarkup(blocks.join(""));
  const composition = compositionFromMarkup(markup);
  const [row] = await db
    .insert(canvasSnapshots)
    .values({
      userId: owner.id,
      brief: "Rebuilt from your tasks — checkboxes tick and un-tick",
      markup: compositionToMarkup(composition),
      composition,
      painting: false,
    })
    .returning({ id: canvasSnapshots.id });

  const checkIds = [...markup.matchAll(/data-check="([-a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
  console.log(`canvas ${row.id.slice(0, 8)} — ${composition.blocks.length} blocks, ${checkIds.length} checkboxes`);
  for (const b of composition.blocks) console.log(`  ${b.id}`);

  // Prove every id resolves to a task this user owns.
  const verified = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, owner.id), inArray(tasks.id, checkIds), isNotNull(tasks.id)));
  console.log(`\n${verified.length}/${checkIds.length} checkbox ids resolve to real tasks`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
