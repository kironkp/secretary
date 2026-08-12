import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Heroku Postgres requires SSL but presents a proxy cert — verify-off is
  // the platform-standard setting. Never enabled locally.
  ssl: process.env.ON_HEROKU ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
export { schema };
