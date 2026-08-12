// Local Postgres without Docker: real postgres binaries via embedded-postgres.
// Same DATABASE_URL as the docker-compose setup — app code is identical either way.
// Usage: npm run db:local   (keeps running; Ctrl-C to stop)
// Env overrides (used by the simulation harness for its isolated instance):
//   PGPORT (default 5432) · PGDATA_DIR (default ./.pgdata) · PGDATABASE (default secretary)
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";

const DATA_DIR = process.env.PGDATA_DIR ?? "./.pgdata";
const PORT = Number(process.env.PGPORT ?? 5432);
const DB_NAME = process.env.PGDATABASE ?? "secretary";

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "postgres",
  password: "postgres",
  port: PORT,
  persistent: true,
});

if (!existsSync(`${DATA_DIR}/PG_VERSION`)) {
  console.log("First run — initialising Postgres data directory…");
  await pg.initialise();
}

await pg.start();

const client = pg.getPgClient();
await client.connect();
const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
  DB_NAME,
]);
if (rowCount === 0) {
  await pg.createDatabase(DB_NAME);
  console.log(`Created database '${DB_NAME}'.`);
}
await client.end();

console.log(
  `Postgres running on postgresql://postgres:postgres@localhost:${PORT}/${DB_NAME} — Ctrl-C to stop.`
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log("\nStopping Postgres…");
    await pg.stop();
    process.exit(0);
  });
}
