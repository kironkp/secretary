// Every harness knob in one place, env-overridable. The sim stack must never
// collide with the dev stack (ports 3000/5432, .pgdata, .next).
export const cfg = {
  appPort: Number(process.env.SIM_APP_PORT ?? 3100),
  get appUrl() {
    return `http://localhost:${this.appPort}`;
  },
  pgPort: Number(process.env.SIM_PG_PORT ?? 5433),
  pgDataDir: process.env.SIM_PGDATA_DIR ?? "./.pgdata-sim",
  pgDb: "secretary_sim",
  get simDatabaseUrl() {
    return `postgresql://postgres:postgres@localhost:${this.pgPort}/${this.pgDb}`;
  },
  distDir: ".next-sim",
  // fixed secret: sim-only, lets sessions survive instance restarts
  authSecret: "sim-only-secret-not-for-production-use-0000",

  /** Overrides the app's TEXT_MODEL inside the sim instance (cheap-brain mode). */
  brainModel: process.env.SIM_TEXT_MODEL,
  /** User-simulator + fixture-generator model (cheap tier). */
  simModel: process.env.SIM_SIM_MODEL ?? "gpt-5-mini",
  /** LLM judge model (cheap tier). */
  judgeModel: process.env.SIM_JUDGE_MODEL ?? "gpt-5-mini",

  concurrency: Math.min(4, Number(process.env.SIM_CONCURRENCY ?? 2)),
  maxTurnsDefault: 6,
  maxTurnsHard: 10,
  /** How long to wait for the async post-turn extraction before end checks. */
  extractionWaitMs: 30_000,
  /** Grace re-poll window for claims-vs-writes (extraction writes lag claims). */
  claimGraceMs: 10_000,
  /** Duplicate detection threshold — matches CREATE_GUARD_SIMILARITY in tools. */
  dupThreshold: 0.85,
};

export function repoRoot(): string {
  // sim/ lives at the repo root; scripts are always run from the root via npm
  return process.cwd();
}
