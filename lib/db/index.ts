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
  // No request waits for a connection for more than ten seconds: past that it
  // fails with an error, rather than hanging the process (docs/projects/SPEC.md
  // §2: on 2026-10-14 eight project moves at once held all six and nothing
  // answered again until a restart).
  connectionTimeoutMillis: 10_000,
});

export const db = drizzle(pool, { schema });
/** What a read can go through: the pool, or a transaction it is part of (so it waits for no second connection). */
export type Reader = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Several reads through one reader: all at once on the pool, one after another in a transaction. A transaction is
 * one connection, and a query sent on it while another is running is deprecated in pg 8 (it warns: "Calling
 * client.query() when the client is already executing a query") and refused in pg 9.
 */
export async function readAll<T extends readonly unknown[]>(reader: Reader, reads: { [K in keyof T]: () => PromiseLike<T[K]> }): Promise<T> {
  const thunks = reads as unknown as readonly (() => PromiseLike<unknown>)[];
  if (reader === db) return (await Promise.all(thunks.map((read) => read()))) as unknown as T;
  const out: unknown[] = [];
  for (const read of thunks) out.push(await read());
  return out as unknown as T;
}
export { schema };
