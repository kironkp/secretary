import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // On Heroku (release phase) the PG proxy needs SSL without CA verification.
    url: process.env.ON_HEROKU
      ? `${process.env.DATABASE_URL!}?sslmode=no-verify`
      : process.env.DATABASE_URL!,
  },
});
