// Fixture generator for bigger fleets: LLM produces personas + scenarios,
// zod-validated, written to sim/fixtures/*.<tier>.jsonl for human review +
// commit. Usage: npm run sim:gen -- --count 100 --tier full
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { cfg } from "./config";
import { expectedOutcomeSchema, personaSchema, scenarioSchema } from "./fixtures/types";
import { jsonCall } from "./llm";

const RISK_AREAS = [
  "near-duplicate phrasing of the same task within one conversation (duplicate guard)",
  "recurring obligations mentioned casually ('rent every month', 'weekly report')",
  "tasks that belong to an existing project the user names or implies",
  "reminders at specific offsets ('ten minutes before') that must land as exact times",
  "multi-step deliverables that deserve stages (and small errands that don't)",
  "document creation + section-level editing by conversation",
  "asking for capabilities the app lacks (email, calls) — honesty required",
  "changing one's mind mid-conversation (postpone, retitle, move project)",
  "events with locations and timezone mentions",
  "completing things verbally ('yeah I did that this morning')",
];

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const batchSchema = z.object({
  personas: z.array(personaSchema),
  scenarios: z.array(scenarioSchema),
});

async function main() {
  const count = Number(argValue("--count", "10"));
  const tier = argValue("--tier", "full");
  const personas: z.infer<typeof personaSchema>[] = [];
  const scenarios: z.infer<typeof scenarioSchema>[] = [];

  const BATCH = 5;
  let attempt = 0;
  let lastError = "";
  while (personas.length < count && attempt < Math.ceil(count / BATCH) * 3) {
    attempt++;
    const n = Math.min(BATCH, count - personas.length);
    try {
      const batch = await jsonCall({
        model: cfg.simModel,
        instructions: [
          "You generate test fixtures for simulating users of a voice-first AI secretary app (tasks, events with reminders, projects, recurring tasks, staged tasks, living documents).",
          `Produce ${n} DIVERSE personas (vary occupation, age, timezone across US zones, verbosity terse/normal/rambly, typos, self-correction habits) and 2 scenarios per persona.`,
          "Scenario rules:",
          `- Each scenario targets ONE of these risk areas: ${RISK_AREAS.join("; ")}`,
          '- surface is "chat" for all generated scenarios (voice scenarios are hand-written).',
          "- goal is written TO the simulated user (second person), concrete and achievable in ≤5 turns.",
          "- expected_outcomes use ONLY the provided schema kinds and must be literally checkable against database rows (title_like fragments the app would plausibly use).",
          "- llm_checks hold anything fuzzier.",
          `- ids: personas p-<slug>, scenarios s-<slug>, unique. seed: random ints. seedData rows may pre-create projects/tasks the scenario needs (values need title/name, status for tasks).`,
          lastError ? `- Your previous output failed validation: ${lastError}. Fix that.` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        input: `Existing persona ids to avoid: ${personas.map((p) => p.id).join(", ") || "(none)"}`,
        schemaName: "fixtures",
        schema: z.toJSONSchema(batchSchema) as Record<string, unknown>,
        parse: (raw) => batchSchema.parse(raw),
      });
      personas.push(...batch.personas);
      scenarios.push(...batch.scenarios.filter((s) => batch.personas.some((p) => p.id === s.personaId)));
      lastError = "";
      console.log(`generated ${personas.length}/${count} personas, ${scenarios.length} scenarios`);
    } catch (e) {
      lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      console.warn(`batch failed validation, retrying: ${lastError}`);
    }
  }

  writeFileSync(
    `sim/fixtures/personas.${tier}.jsonl`,
    personas.map((p) => JSON.stringify(p)).join("\n") + "\n"
  );
  writeFileSync(
    `sim/fixtures/scenarios.${tier}.jsonl`,
    scenarios.map((s) => JSON.stringify(s)).join("\n") + "\n"
  );
  console.log(
    `wrote sim/fixtures/{personas,scenarios}.${tier}.jsonl — review before committing/running`
  );
}

void expectedOutcomeSchema; // referenced via scenarioSchema; kept for clarity

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
