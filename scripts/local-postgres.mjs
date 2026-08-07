// Local Postgres without Docker: real postgres binaries via embedded-postgres.
// Same DATABASE_URL as the docker-compose setup — app code is identical either way.
// Usage: npm run db:local   (keeps running; Ctrl-C to stop)
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";

const DATA_DIR = "./.pgdata";

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: "postgres",
  password: "postgres",
  port: 5432,
  persistent: true,
});

if (!existsSync(`${DATA_DIR}/PG_VERSION`)) {
  console.log("First run — initialising Postgres data directory…");
  await pg.initialise();
}

await pg.start();

const client = pg.getPgClient();
await client.connect();
const { rowCount } = await client.query(
  "SELECT 1 FROM pg_database WHERE datname = 'secretary'"
);
if (rowCount === 0) {
  await pg.createDatabase("secretary");
  console.log("Created database 'secretary'.");
}
await client.end();

console.log(
  "Postgres running on postgresql://postgres:postgres@localhost:5432/secretary — Ctrl-C to stop."
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    console.log("\nStopping Postgres…");
    await pg.stop();
    process.exit(0);
  });
}
