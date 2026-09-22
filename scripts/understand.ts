// The understanding loop, run offline — docs/understanding/SPEC.md §11 phase 2.
//
// The gate for the whole loop is whether, on real data, the Caltrans run
// produces the duplicate-CPO contradictions, the next-payment unknown and the
// thing states with correct sources. That is judged by reading the output,
// so this prints everything the run wrote, one line per claim, and with
// --dry writes nothing at all.
//
//   npx tsx --env-file=.env.local scripts/understand.ts [--user <email>] \
//     (--project <name> | --all) [--dry] [--force] [--model <id>]
//
// --dry    call the model, print, write nothing (records, questions, usage,
//          the run log: none of it). Implies --force: a dry run is for
//          reading the output, so the hash compare would only get in the way.
// --force  call the model even when the stored hash matches.
// --model  a model id (UNDERSTANDING_MODEL for this run only).
// The user defaults to the only user in the table; with more than one, --user
// is required.
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, user } from "@/lib/db/schema";
import { runAll, runProject, type RunResult } from "@/lib/understanding/run";
import type { Claim, QuestionDraft, RunOutput, Write } from "@/lib/understanding/types";

type Args = {
  user?: string;
  project?: string;
  all: boolean;
  dry: boolean;
  force: boolean;
  model?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { all: false, dry: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
      return v;
    };
    if (a === "--user") args.user = next();
    else if (a === "--project") args.project = next();
    else if (a === "--model") args.model = next();
    else if (a === "--all") args.all = true;
    else if (a === "--dry") args.dry = true;
    else if (a === "--force") args.force = true;
    else usage(`unknown argument ${a}`);
  }
  if (args.all === Boolean(args.project)) usage("give exactly one of --project <name> or --all");
  return args;
}

function usage(problem?: string): never {
  if (problem) console.error(`error: ${problem}\n`);
  console.error(
    "usage: npx tsx --env-file=.env.local scripts/understand.ts [--user <email>] " +
      "(--project <name> | --all) [--dry] [--force] [--model <id>]"
  );
  process.exit(2);
}

async function resolveUser(email?: string): Promise<{ id: string; email: string; timezone: string }> {
  const cols = { id: user.id, email: user.email, timezone: user.timezone };
  if (email) {
    const [row] = await db.select(cols).from(user).where(eq(user.email, email)).limit(1);
    if (!row) usage(`no user with email ${email}`);
    return row;
  }
  const rows = await db.select(cols).from(user);
  if (rows.length === 1) return rows[0];
  usage(
    rows.length === 0
      ? "no users in the database"
      : `${rows.length} users in the database; pick one with --user <email>`
  );
}

async function resolveProject(userId: string, name: string): Promise<{ id: string; name: string }> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, status: projects.status })
    .from(projects)
    .where(and(eq(projects.userId, userId)));
  const wanted = name.trim().toLowerCase();
  const hits = rows.filter((p) => p.name.trim().toLowerCase() === wanted);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) usage(`${hits.length} projects are named "${name}"; rename one first`);
  usage(`no project named "${name}". Projects: ${rows.map((p) => `${p.name} (${p.status})`).join(", ")}`);
}

// --------------------------------------------------------------------------
// Printing
// --------------------------------------------------------------------------

const sourcesOf = (c: { sources: { type: string; id: string }[] }): string =>
  `[${c.sources.length} source${c.sources.length === 1 ? "" : "s"}]`;

function printClaim(label: string, c: Claim | undefined): void {
  if (c) console.log(`  ${label}: ${c.text} ${sourcesOf(c)} (${c.confidence}${c.at ? `, ${c.at}` : ""})`);
}

function writeLine(w: Write): string {
  switch (w.op) {
    case "complete_task":
    case "drop_task":
      return `${w.op} ${w.taskId}`;
    case "set_due":
      return `set_due ${w.taskId} -> ${w.dueAt}`;
    case "set_recurrence":
      return `set_recurrence ${w.taskId} -> ${w.recurrence}`;
    case "set_blocked_reason":
      return `set_blocked_reason ${w.taskId} -> "${w.reason}"`;
    case "remember_fact":
      return `remember_fact "${w.fact}"${w.tags.length ? ` [${w.tags.join(", ")}]` : ""}`;
    case "clear_expectation":
      return `clear_expectation ${w.expectationId}`;
    case "resolve":
      return "resolve";
  }
}

function printQuestion(q: QuestionDraft, rank: number | undefined): void {
  console.log(`  ${q.kind}${rank !== undefined ? ` rank ${rank}` : ""}: ${q.question}`);
  console.log(`    why: ${q.why}`);
  console.log(`    evidence: ${q.evidence.map((e) => `${e.type}:${e.id}`).join(", ")}`);
  for (const a of q.answers) {
    console.log(`    answer "${a.label}" (${a.id}): ${a.writes.map(writeLine).join("; ") || "no writes"}`);
  }
}

function printOutput(output: RunOutput, ranks?: number[]): void {
  const r = output.record;
  console.log("record:");
  printClaim("objective", r.objective);
  for (const t of r.things) {
    const names = [t.name, ...t.aliases].join(" / ");
    const ids = t.ids.length ? ` (${t.ids.join(", ")})` : "";
    console.log(`  thing: ${names}${ids}`);
    printClaim("  state", t.state);
    printClaim("  waiting on", t.waitingOn);
  }
  r.rules.forEach((c) => printClaim("rule", c));
  r.decisions.forEach((c) => printClaim("decision", c));
  r.currentWork.forEach((c) => printClaim("current work", c));
  printClaim("next action", r.nextAction);
  r.blockers.forEach((c) => printClaim("blocker", c));
  r.attempts.forEach((c) => printClaim("attempt", c));
  printClaim("resume pointer", r.resumePointer);
  for (const c of r.contradictions) console.log(`  contradiction: ${c.text} ${sourcesOf(c)}`);
  for (const u of r.unknowns) console.log(`  unknown: ${u.text} — ${u.why} ${sourcesOf(u)}`);
  console.log(`  asked: ${r.asked.length} entr${r.asked.length === 1 ? "y" : "ies"}`);
  console.log(`  last activity: ${r.lastActivityAt}`);

  console.log(`questions: ${output.questions.length}`);
  output.questions.forEach((q, i) => printQuestion(q, ranks?.[i]));

  console.log("words:");
  for (const [widgetId, lede] of Object.entries(output.words.ledes)) {
    console.log(`  lede ${widgetId}: ${lede}`);
  }
  console.log(`  today: ${output.words.todayLine ?? "(none)"}`);
}

function printResult(projectName: string, result: RunResult): void {
  console.log(`\n=== ${projectName} ===`);
  switch (result.status) {
    case "skipped":
      console.log(`skipped: ${result.reason}`);
      return;
    case "failed":
      console.log("failed; the previous record is untouched. Validation errors:");
      for (const e of result.errors) console.log(`  - ${e}`);
      return;
    case "dry":
      console.log(
        `dry run: ${result.model}, ${result.inputTokens} in / ${result.outputTokens} out, hash ${result.inputsHash.slice(0, 12)}`
      );
      printOutput(result.output, result.ranks);
      return;
    case "ok":
      console.log(
        `stored record ${result.recordId} v${result.version}: ${result.inputTokens} in / ${result.outputTokens} out`
      );
      console.log(
        `questions: ${result.questions.created.length} created, ${result.questions.updated.length} updated, ${result.questions.dismissed.length} dismissed`
      );
      for (const [widgetId, lede] of Object.entries(result.ledes)) console.log(`  lede ${widgetId}: ${lede}`);
      console.log(`  today: ${result.todayLine ?? "(none)"}`);
      return;
  }
}

// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.model) process.env.UNDERSTANDING_MODEL = args.model;
  // A dry run is for reading the output; the hash compare would only get in
  // the way of that.
  const force = args.force || args.dry;

  const who = await resolveUser(args.user);
  console.log(`user ${who.email} (${who.timezone})${args.dry ? " — dry run, nothing is written" : ""}`);

  if (args.all) {
    const names = new Map(
      (await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.userId, who.id))).map(
        (p) => [p.id, p.name]
      )
    );
    const { results, retiredAsr } = await runAll(who.id, {
      timezone: who.timezone,
      force,
      dryRun: args.dry,
    });
    for (const [projectId, result] of Object.entries(results)) {
      printResult(names.get(projectId) ?? projectId, result);
    }
    if (!args.dry) console.log(`\nretired ${retiredAsr} ASR clarification${retiredAsr === 1 ? "" : "s"}`);
    return;
  }

  const project = await resolveProject(who.id, args.project!);
  const result = await runProject(who.id, project.id, {
    timezone: who.timezone,
    force,
    dryRun: args.dry,
  });
  printResult(project.name, result);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  });
