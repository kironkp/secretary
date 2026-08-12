// Run reports: bugs JSONL (machine) + markdown summary (human) + latest.md.
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Violation } from "./fixtures/types";

export type ScenarioResult = {
  scenarioId: string;
  personaId: string;
  surface: string;
  turns: number;
  violations: Violation[];
  transcriptPath: string;
  durationMs: number;
  error?: string; // harness-level failure (scenario couldn't run)
};

export function reportRun(opts: {
  runId: string;
  commit: string;
  trigger: string;
  fleet: string;
  results: ScenarioResult[];
  wallClockMs: number;
}): { errors: number; warns: number; mdPath: string } {
  mkdirSync("sim/reports", { recursive: true });
  const bugsPath = `sim/reports/${opts.runId}.bugs.jsonl`;
  const mdPath = `sim/reports/${opts.runId}.md`;

  let errors = 0;
  let warns = 0;
  for (const r of opts.results) {
    for (const v of r.violations) {
      if (v.severity === "error") errors++;
      else warns++;
      appendFileSync(
        bugsPath,
        JSON.stringify({
          runId: opts.runId,
          commit: opts.commit,
          trigger: opts.trigger,
          scenarioId: r.scenarioId,
          personaId: r.personaId,
          surface: r.surface,
          turn: v.turn,
          severity: v.severity,
          checker: v.checker,
          summary: v.summary,
          evidence: v.evidence ?? {},
          transcript: r.transcriptPath,
          replay: `npm run sim:replay -- --scenario ${r.scenarioId} --run ${opts.runId}`,
        }) + "\n"
      );
    }
  }

  const byChecker = new Map<string, number>();
  for (const r of opts.results)
    for (const v of r.violations) byChecker.set(v.checker, (byChecker.get(v.checker) ?? 0) + 1);

  const lines = [
    `# Sim run ${opts.runId}`,
    "",
    `- commit: \`${opts.commit}\` · trigger: ${opts.trigger} · fleet: ${opts.fleet}`,
    `- scenarios: ${opts.results.length} · **errors: ${errors}** · warns: ${warns} · wall clock: ${Math.round(opts.wallClockMs / 1000)}s`,
    "",
    "| Scenario | Persona | Surface | Turns | Result |",
    "|---|---|---|---|---|",
    ...opts.results.map((r) => {
      const e = r.violations.filter((v) => v.severity === "error").length;
      const w = r.violations.filter((v) => v.severity === "warn").length;
      const status = r.error
        ? `⚠ harness error: ${r.error.slice(0, 60)}`
        : e > 0
          ? `❌ ${e} error(s)${w ? `, ${w} warn(s)` : ""}`
          : w > 0
            ? `⚠ ${w} warn(s)`
            : "✅ pass";
      return `| ${r.scenarioId} | ${r.personaId} | ${r.surface} | ${r.turns} | ${status} |`;
    }),
    "",
    ...(byChecker.size > 0
      ? [
          "## Violations by checker",
          ...[...byChecker.entries()].map(([c, n]) => `- \`${c}\`: ${n}`),
          "",
        ]
      : []),
    ...(errors + warns > 0
      ? [
          "## Details",
          ...opts.results.flatMap((r) =>
            r.violations.map(
              (v) =>
                `- **${v.severity}** \`${v.checker}\` [${r.scenarioId}${v.turn !== null ? ` · turn ${v.turn}` : ""}]: ${v.summary}`
            )
          ),
          "",
          `Full evidence: \`${bugsPath}\``,
        ]
      : ["All checks passed."]),
  ];
  writeFileSync(mdPath, lines.join("\n") + "\n");
  copyFileSync(mdPath, "sim/reports/latest.md");
  return { errors, warns, mdPath };
}
