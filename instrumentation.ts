// Server boot hook (Next instrumentation): starts the reminder minute-scanner
// so due task/event reminders become phone pushes. Runs in the Node server
// only — never during build, never under vitest.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VITEST || process.env.npm_lifecycle_event === "build") return;
  const { scanDueReminders } = await import("@/lib/push");
  setInterval(() => {
    scanDueReminders().catch((e) =>
      console.error("reminder scan failed:", e instanceof Error ? e.message : e)
    );
  }, 60 * 1000);
}
