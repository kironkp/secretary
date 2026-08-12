// Drizzle handle bound to the SIM database (5433/secretary_sim) — never the
// dev database. Re-exports the app schema so checkers and bootstrap share the
// exact table definitions the app writes with.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/lib/db/schema";
import { cfg } from "./config";

const pool = new Pool({ connectionString: cfg.simDatabaseUrl, max: 10 });

export const simDb = drizzle(pool, { schema });
export { schema };

export async function closeSimDb() {
  await pool.end();
}
