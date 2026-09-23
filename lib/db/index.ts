import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Heroku Postgres requires SSL but presents a proxy cert — verify-off is
  // the platform-standard setting. Never enabled locally.
  ssl: process.env.ON_HEROKU ? { rejectUnauthorized: false } : undefined,
  // The Heroku plan allows 20 connections. A deploy overlaps two dynos plus
  // the release process, and pg's default of 10 per process hit "too many
  // connections for role" on 2026-09-23 00:55Z (heroku logs). Six per
  // process leaves room for three processes; an idle connection is let go
  // after thirty seconds so a quiet dyno holds none of them.
  max: 6,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });
export { schema };
