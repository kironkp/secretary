import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Heroku Postgres ships the pg_stat_statements extension, whose two views
  // live in `public`. Without this filter `push` sees views the schema does
  // not declare, emits DROP VIEW, and Postgres refuses ("extension
  // pg_stat_statements requires it") — the release phase then applies
  // nothing. tablesFilter is applied to views as well as tables.
  tablesFilter: ["!pg_stat_statements", "!pg_stat_statements_info"],
  dbCredentials: {
    // On Heroku (release phase) the PG proxy needs SSL without CA verification.
    url: process.env.ON_HEROKU
      ? `${process.env.DATABASE_URL!}?sslmode=no-verify`
      : process.env.DATABASE_URL!,
  },
});
