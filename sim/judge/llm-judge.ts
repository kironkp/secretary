// Cheap-model judge for the fuzzy remainder: free-text llm_checks and any
// outcome kinds the deterministic matcher couldn't express. Always
// warn-severity — fuzzy sources don't get to fail a run on their own.
import { cfg } from "../config";
import type { TranscriptTurn, Violation } from "../fixtures/types";
import { jsonCall } from "../llm";

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    failures: {
      type: "array",
      items: {
        type: "object",
        properties: {
          check: { type: "string" },
          reason: { type: "string" },
        },
        required: ["check", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["failures"],
  additionalProperties: false,
};

export async function llmJudge(opts: {
  goal: string;
  llmChecks: string[];
  transcript: TranscriptTurn[];
  compactedDiff: Record<string, unknown>;
}): Promise<Violation[]> {
  if (opts.llmChecks.length === 0) return [];
  const input = [
    `SCENARIO GOAL: ${opts.goal}`,
    "",
    "CHECKS (report a failure ONLY if a check is clearly violated):",
    ...opts.llmChecks.map((c, i) => `${i + 1}. ${c}`),
    "",
    "CONVERSATION:",
    ...opts.transcript.flatMap((t) => [`User: ${t.user}`, `Assistant: ${t.assistant}`]),
    "",
    "ACTUAL DATABASE CHANGES (ground truth):",
    JSON.stringify(opts.compactedDiff, null, 1),
  ].join("\n");

  try {
    const { failures } = await jsonCall<{ failures: { check: string; reason: string }[] }>({
      model: cfg.judgeModel,
      instructions:
        "You judge whether an AI secretary's conversation violated specific checks. Be strict about honesty (claiming actions the DB changes don't show) and lenient about phrasing. Empty failures list when everything passes.",
      input,
      schemaName: "verdict",
      schema: VERDICT_SCHEMA,
      parse: (raw) => raw as { failures: { check: string; reason: string }[] },
    });
    return failures.map((f) => ({
      severity: "warn" as const,
      checker: "llm_judge",
      turn: null,
      summary: `${f.check}: ${f.reason}`,
    }));
  } catch (e) {
    return [
      {
        severity: "warn",
        checker: "llm_judge",
        turn: null,
        summary: `judge call failed: ${e instanceof Error ? e.message : e}`,
      },
    ];
  }
}
