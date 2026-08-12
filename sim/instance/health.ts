import { Pool } from "pg";
import { cfg } from "../config";

export async function pgReady(): Promise<boolean> {
  const pool = new Pool({ connectionString: cfg.simDatabaseUrl, connectionTimeoutMillis: 1500 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function appReady(): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.appUrl}/api/auth/get-session`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function waitFor(
  probe: () => Promise<boolean>,
  label: string,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} not ready after ${Math.round(timeoutMs / 1000)}s`);
}
