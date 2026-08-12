// Fleet runner: loads fixtures, runs each scenario (chat via the LLM user
// simulator, voice via fully-scripted steps), snapshots per turn, judges,
// reports. Promise pool bounds concurrency against the single dev server.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { and, eq, gte } from "drizzle-orm";
import { schema, simDb } from "./db";
import { cfg } from "./config";
import {
  createCanaryUser,
  createSimUser,
  deleteSimUser,
  type SimUser,
} from "./bootstrap";
import { SimClient } from "./client";
import {
  personaSchema,
  scenarioSchema,
  type Persona,
  type Scenario,
  type TranscriptTurn,
  type Violation,
} from "./fixtures/types";
import { runAllCheckers, type CheckerContext } from "./judge/invariants";
import { llmJudge } from "./judge/llm-judge";
import { matchOutcomes } from "./judge/outcomes";
import { compactDiff, diffSnapshots, snapshotUser } from "./snapshot";
import { makeSimulator } from "./simulator";
import { reportRun, type ScenarioResult } from "./report";

export type FleetOptions = {
  fleet: "smoke" | "full";
  trigger: string;
  replayScenario?: string;
  replayRun?: string;
  live?: boolean;
  concurrency: number;
};

function loadJsonl<T>(path: string, parse: (raw: unknown) => T): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return parse(JSON.parse(l));
      } catch (e) {
        throw new Error(`${path}:${i + 1} invalid fixture: ${e instanceof Error ? e.message : e}`);
      }
    });
}

/** Resolve `{{+2d T09:00}}`-style templates in scripted voice args. */
function resolveTemplates(value: unknown, tz: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*\+(\d+)d(?:\s+T(\d{2}):(\d{2}))?\s*\}\}/g, (_, d, hh, mm) => {
      const date = new Date(Date.now() + Number(d) * 86400000);
      if (hh !== undefined) {
        date.setHours(Number(hh), Number(mm), 0, 0);
      }
      return date.toISOString();
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, tz));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, tz)])
    );
  }
  return value;
}

async function waitForExtraction(userId: string, since: Date): Promise<boolean> {
  const deadline = Date.now() + cfg.extractionWaitMs;
  while (Date.now() < deadline) {
    const rows = await simDb
      .select({ extractedAt: schema.conversations.extractedAt })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.userId, userId), gte(schema.conversations.startedAt, new Date(since.getTime() - 60000))));
    if (rows.length === 0) return true; // no conversation → nothing to extract
    if (rows.every((r) => r.extractedAt && r.extractedAt >= since)) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function seedScenarioData(userId: string, scenario: Scenario): Promise<void> {
  for (const seed of scenario.seedData) {
    const values = { ...seed.values, userId } as Record<string, unknown>;
    for (const k of ["dueAt", "startsAt", "endsAt"]) {
      if (typeof values[k] === "string") values[k] = new Date(resolveTemplates(values[k], "") as string);
    }
    if (seed.table === "projects") await simDb.insert(schema.projects).values(values as never);
    else if (seed.table === "tasks") await simDb.insert(schema.tasks).values(values as never);
    else await simDb.insert(schema.events).values(values as never);
  }
}

async function runChatScenario(opts: {
  persona: Persona;
  scenario: Scenario;
  user: SimUser;
  client: SimClient;
  replayMessages?: string[];
}): Promise<{ transcript: TranscriptTurn[]; turnDiffs: { turn: number; diff: ReturnType<typeof diffSnapshots> }[] }> {
  const { persona, scenario, client } = opts;
  const transcript: TranscriptTurn[] = [];
  const turnDiffs: { turn: number; diff: ReturnType<typeof diffSnapshots> }[] = [];
  const simulator = makeSimulator(persona, scenario);
  let conversationId: string | null = null;
  const maxTurns = Math.min(scenario.maxTurns, cfg.maxTurnsHard);

  for (let turn = 1; turn <= maxTurns; turn++) {
    let userMessage: string | null;
    if (opts.replayMessages) {
      userMessage = opts.replayMessages[turn - 1] ?? null;
    } else {
      userMessage = await simulator(
        transcript.map((t) => ({ user: t.user, assistant: t.assistant })),
        turn
      );
    }
    if (!userMessage) break;

    const before = await snapshotUser(opts.user.userId);
    const res = await client.chat(userMessage, conversationId);
    conversationId = res.conversationId;
    // brief grace: background extraction may add writes attributable to this turn
    await new Promise((r) => setTimeout(r, 2000));
    let after = await snapshotUser(opts.user.userId);
    let diff = diffSnapshots(before, after);
    // if the assistant made claims but the diff is thin, grace-poll once more
    const graceDeadline = Date.now() + cfg.claimGraceMs;
    while (
      Date.now() < graceDeadline &&
      diff.tasks.created.length + diff.tasks.updated.length + diff.events.created.length === 0 &&
      /added|created|logged|moved|done|reminder/i.test(res.assistantMessage.content)
    ) {
      await new Promise((r) => setTimeout(r, 2000));
      after = await snapshotUser(opts.user.userId);
      diff = diffSnapshots(before, after);
    }

    transcript.push({
      turn,
      user: userMessage,
      assistant: res.assistantMessage.content,
      toasts: res.toasts,
    });
    turnDiffs.push({ turn, diff });
  }
  return { transcript, turnDiffs };
}

async function runVoiceScenario(opts: {
  scenario: Scenario;
  user: SimUser;
  client: SimClient;
  persona: Persona;
}): Promise<{ transcript: TranscriptTurn[]; turnDiffs: { turn: number; diff: ReturnType<typeof diffSnapshots> }[] }> {
  const { scenario, user, client, persona } = opts;
  const [conv] = await simDb
    .insert(schema.conversations)
    .values({ userId: user.userId, mode: "voice" })
    .returning();

  const transcript: TranscriptTurn[] = [];
  const turnDiffs: { turn: number; diff: ReturnType<typeof diffSnapshots> }[] = [];
  let turn = 0;
  let currentUser = "";
  let toasts: { icon: string; text: string }[] = [];
  let before = await snapshotUser(user.userId);

  for (const step of scenario.voiceSteps) {
    if ("userLine" in step) {
      // close out the previous exchange
      if (currentUser) {
        transcript.push({ turn, user: currentUser, assistant: "", toasts });
        turnDiffs.push({ turn, diff: diffSnapshots(before, await snapshotUser(user.userId)) });
      }
      turn++;
      currentUser = step.userLine;
      toasts = [];
      before = await snapshotUser(user.userId);
      await client.persistMessage(conv.id, "user", step.userLine);
    } else if ("toolCall" in step) {
      const args = resolveTemplates(step.toolCall.args, persona.timezone);
      const outcome = await client.voiceTool(step.toolCall.name, args, conv.id);
      if (outcome.toast) toasts.push(outcome.toast);
    } else {
      await client.persistMessage(conv.id, "assistant", step.assistantLine);
      transcript.push({ turn, user: currentUser, assistant: step.assistantLine, toasts });
      turnDiffs.push({ turn, diff: diffSnapshots(before, await snapshotUser(user.userId)) });
      currentUser = "";
      toasts = [];
      before = await snapshotUser(user.userId);
    }
  }
  if (currentUser) {
    transcript.push({ turn, user: currentUser, assistant: "", toasts });
    turnDiffs.push({ turn, diff: diffSnapshots(before, await snapshotUser(user.userId)) });
  }
  return { transcript, turnDiffs };
}

async function runScenario(opts: {
  runId: string;
  persona: Persona;
  scenario: Scenario;
  canary: { user: SimUser; conversationId: string } | null;
  replayMessages?: string[];
}): Promise<ScenarioResult> {
  const { runId, persona, scenario } = opts;
  const started = Date.now();
  const transcriptDir = `sim/reports/${runId}/transcripts`;
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = `${transcriptDir}/${scenario.id}.json`;

  // one user per SCENARIO (a persona can have several) — ids must not collide
  const user = await createSimUser({
    runId,
    personaId: `${persona.id}-${scenario.id}`,
    name: persona.name,
    timezone: persona.timezone,
  });
  const client = new SimClient(user.cookie);

  try {
    await seedScenarioData(user.userId, scenario);
    const scenarioStart = new Date();
    const startState = await snapshotUser(user.userId);
    const canaryBefore = opts.canary ? await snapshotUser(opts.canary.user.userId) : null;

    const { transcript, turnDiffs } =
      scenario.surface === "voice"
        ? await runVoiceScenario({ scenario, user, client, persona })
        : await runChatScenario({
            persona,
            scenario,
            user,
            client,
            replayMessages: opts.replayMessages,
          });

    // extraction only fires on the chat path — scripted voice sessions never
    // trigger it, so waiting there would always time out
    const extracted =
      scenario.surface === "chat" ? await waitForExtraction(user.userId, scenarioStart) : true;
    const endState = await snapshotUser(user.userId);
    const endDiff = diffSnapshots(startState, endState);
    const canaryAfter = opts.canary ? await snapshotUser(opts.canary.user.userId) : null;

    let canaryProbes: CheckerContext["canaryProbes"] = null;
    if (opts.canary) {
      const canaryClient = new SimClient(opts.canary.user.cookie);
      const myConv = [...endState.conversations.values()][0];
      const probe404 = myConv
        ? (await canaryClient.getMessages(myConv.id as string)).status === 404
        : true;
      const canaryTasks = (await canaryClient.getTasksViaTool()) as {
        result?: { title?: string }[];
      } | null;
      const tasksScoped =
        !canaryTasks?.result ||
        canaryTasks.result.every((t) => String(t.title ?? "").startsWith("Canary"));
      canaryProbes = { messages404: probe404, tasksScoped };
    }

    const ctx: CheckerContext = {
      endState,
      endDiff,
      turnDiffs,
      transcript,
      canaryBefore,
      canaryAfter,
      canaryProbes,
    };
    const violations: Violation[] = runAllCheckers(ctx);
    if (!extracted) {
      violations.push({
        severity: "warn",
        checker: "extraction_stalled",
        turn: null,
        summary: `extraction did not complete within ${cfg.extractionWaitMs / 1000}s`,
      });
    }

    const projectNamesById = new Map(
      [...endState.projects.values()].map((p) => [p.id, p.name as string])
    );
    const { violations: outcomeViolations, unmatchedForLlm } = matchOutcomes({
      outcomes: scenario.expected_outcomes,
      endDiff,
      endTasks: [...endState.tasks.values()],
      endEvents: [...endState.events.values()],
      projectNamesById,
    });
    violations.push(...outcomeViolations);

    const llmChecks = [
      ...scenario.llm_checks,
      ...unmatchedForLlm.map((o) => `expected outcome: ${JSON.stringify(o)}`),
    ];
    if (llmChecks.length > 0 && scenario.surface === "chat") {
      violations.push(
        ...(await llmJudge({
          goal: scenario.goal,
          llmChecks,
          transcript,
          compactedDiff: compactDiff(endDiff),
        }))
      );
    }

    writeFileSync(
      transcriptPath,
      JSON.stringify(
        { runId, scenarioId: scenario.id, personaId: persona.id, transcript, endDiff: compactDiff(endDiff) },
        null,
        2
      )
    );

    return {
      scenarioId: scenario.id,
      personaId: persona.id,
      surface: scenario.surface,
      turns: transcript.length,
      violations,
      transcriptPath,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      scenarioId: scenario.id,
      personaId: persona.id,
      surface: scenario.surface,
      turns: 0,
      violations: [],
      transcriptPath,
      durationMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await deleteSimUser(user.userId).catch(() => {});
  }
}

async function promisePool<T>(items: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await items[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function runFleet(opts: FleetOptions): Promise<void> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}`;
  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    /* not fatal */
  }

  const personas = loadJsonl(`sim/fixtures/personas.${opts.fleet}.jsonl`, (r) =>
    personaSchema.parse(r)
  );
  let scenarios = loadJsonl(`sim/fixtures/scenarios.${opts.fleet}.jsonl`, (r) =>
    scenarioSchema.parse(r)
  );
  if (personas.length === 0 || scenarios.length === 0) {
    console.log(`sim: no ${opts.fleet} fixtures found — run npm run sim:gen first`);
    return;
  }

  // replay mode: one scenario, recorded user messages
  let replayMessages: string[] | undefined;
  if (opts.replayScenario) {
    scenarios = scenarios.filter((s) => s.id === opts.replayScenario);
    if (scenarios.length === 0) throw new Error(`unknown scenario ${opts.replayScenario}`);
    if (opts.replayRun && !opts.live) {
      const path = `sim/reports/${opts.replayRun}/transcripts/${opts.replayScenario}.json`;
      const saved = JSON.parse(readFileSync(path, "utf8"));
      replayMessages = (saved.transcript as TranscriptTurn[]).map((t) => t.user);
      console.log(`sim: replaying ${replayMessages.length} recorded user messages`);
    }
  }

  const byPersona = new Map(personas.map((p) => [p.id, p]));
  const runnable = scenarios.filter((s) => byPersona.has(s.personaId));

  console.log(
    `sim: run ${runId} — ${runnable.length} scenario(s), concurrency ${opts.concurrency}, fleet ${opts.fleet}`
  );

  const canary = await createCanaryUser(runId);
  const started = Date.now();
  try {
    const results = await promisePool(
      runnable.map((scenario) => () => {
        console.log(`sim: ▶ ${scenario.id} (${scenario.surface}, ${scenario.personaId})`);
        return runScenario({
          runId,
          persona: byPersona.get(scenario.personaId)!,
          scenario,
          canary: { user: canary, conversationId: canary.conversationId },
          replayMessages,
        }).then((r) => {
          const e = r.violations.filter((v) => v.severity === "error").length;
          console.log(
            `sim: ■ ${scenario.id} — ${r.error ? `HARNESS ERROR: ${r.error}` : e ? `${e} error(s)` : "pass"}`
          );
          return r;
        });
      }),
      opts.concurrency
    );

    const { errors, warns, mdPath } = reportRun({
      runId,
      commit,
      trigger: opts.trigger,
      fleet: opts.fleet,
      results,
      wallClockMs: Date.now() - started,
    });
    console.log(`sim: done — ${errors} error(s), ${warns} warn(s) → ${mdPath}`);
    if (errors > 0) process.exitCode = 1;
  } finally {
    await deleteSimUser(canary.userId).catch(() => {});
  }
}
