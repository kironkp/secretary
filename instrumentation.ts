// Server boot hook (Next instrumentation): starts the reminder minute-scanner
// so due task/event reminders become phone pushes. Runs in the Node server
// only — never during build, never under vitest.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VITEST || process.env.npm_lifecycle_event === "build") return;
  const { scanDueReminders } = await import("@/lib/push");
  const { kickQueue } = await import("@/lib/shop/shop");
  setInterval(() => {
    scanDueReminders().catch((e) =>
      console.error("reminder scan failed:", e instanceof Error ? e.message : e)
    );
    // Shop queue sweeper: approved builds / filed plans start within a minute
    // of the lane clearing, even if a runner crashed or the server restarted.
    kickQueue().catch((e) =>
      console.error("shop queue kick failed:", e instanceof Error ? e.message : e)
    );
  }, 60 * 1000);
}
