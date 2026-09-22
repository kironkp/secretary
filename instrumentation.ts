// Server boot hook (Next instrumentation): starts the reminder minute-scanner
// so due task/event reminders become phone pushes, and the understanding
// sweep. Runs in the Node server only — never during build, never under
// vitest.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.VITEST || process.env.npm_lifecycle_event === "build") return;
  const { scanDueReminders } = await import("@/lib/push");
  const { kickQueue } = await import("@/lib/shop/shop");
  const { scanInbox } = await import("@/lib/email-intake");
  const { sweepMinutes, sweepUnderstanding } = await import("@/lib/understanding/sweep");
  setInterval(() => {
    scanDueReminders().catch((e) =>
      console.error("reminder scan failed:", e instanceof Error ? e.message : e)
    );
    // Shop queue sweeper: approved builds / filed plans start within a minute
    // of the lane clearing, even if a runner crashed or the server restarted.
    kickQueue().catch((e) =>
      console.error("shop queue kick failed:", e instanceof Error ? e.message : e)
    );
    // Email intake: the secretary reads the dedicated mailbox (no-op until
    // INBOUND_EMAIL_* credentials exist; internal latch prevents overlap).
    scanInbox().catch((e) =>
      console.error("inbox scan failed:", e instanceof Error ? e.message : e)
    );
  }, 60 * 1000);

  // The understanding sweep (docs/understanding/SPEC.md §8): every
  // UNDERSTANDING_SWEEP_MINUTES (default 10, never under 2), first run two
  // minutes after boot so a deploy is serving before it reads anything. This
  // is the "always looking through the data" the user asked for, and it is
  // affordable because of the hash: a sweep over unchanged data is a handful
  // of indexed queries per project and a compare, no model call; the local
  // date is part of the hash, so every project re-runs once a day and a
  // busy day adds a run per change. Cents a day, not a model call a minute.
  // The module keeps its own latch, so a slow sweep and the next tick never
  // overlap.
  const sweep = () => sweepUnderstanding().catch(console.error);
  const sweepMs = sweepMinutes() * 60 * 1000;
  setTimeout(() => {
    sweep();
    setInterval(sweep, sweepMs);
  }, 2 * 60 * 1000);
}
