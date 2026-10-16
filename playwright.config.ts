// Browser tests. THIS MAC CANNOT RUN THEM: Playwright refuses to install
// Chromium on macOS 12 ("Playwright does not support chromium on mac12"),
// verified 2026-09-17. They run on the CI ubuntu runner, which is also where
// they gate the Heroku deploy. Locally, `npm test` (vitest) is still the loop.
//
// Why this exists at all: four Canvas rebuilds shipped with tsc, eslint, 439
// vitest tests and `next build` all green, and a human still could not tick a
// checkbox. Nothing in that set executes layout, hit-testing or touch. This is
// the only harness in the repo that does.
//
// The device profile is an iPhone, not a desktop, because every defect that
// reached the user was a touch defect. That profile runs on WebKit, which is
// the point: the iOS tap delay and Safari's hit-testing do not reproduce in
// Chromium, and that is precisely why four rounds of Canvas fixes missed them.
import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE } from "./e2e/paths";

const PORT = Number(process.env.E2E_PORT ?? 3000);
// `localhost`, not 127.0.0.1: lib/auth.ts allowlists hosts as `localhost:*`
// when BETTER_AUTH_URL is unset, and the loopback IP is not that string.
export const BASE_URL = `http://localhost:${PORT}`;
// The model stand-in (e2e/model-standin.mjs): a chat turn that reaches the
// server is answered by it, never by a real model (v1.17).
const STANDIN_PORT = Number(process.env.E2E_STANDIN_PORT ?? PORT + 1000);

export default defineConfig({
  testDir: "./e2e",
  // A board test that needs a retry is a board test that is lying to you.
  retries: 0,
  // One worker: the tests share one Postgres and one signed-in user.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  globalSetup: "./e2e/global-setup.ts",

  use: {
    baseURL: BASE_URL,
    storageState: STORAGE_STATE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      // Gating. These must stay green: CI is what Heroku waits on.
      name: "smoke",
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // The reason this harness exists. The Workspace gets a real browser from
      // its first commit rather than after four rebuilds.
      name: "workspace",
      testMatch: /workspace\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // Pictures, not assertions: every screen on the phone profile, uploaded
      // from CI as the "screenshots" artifact. Runs before "today" so the
      // seeded question is still open in the frame.
      name: "screens",
      testMatch: /screens\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // The Interview: the seeded question read in full and skipped, never
      // answered. Before "today", which answers it.
      name: "interview",
      testMatch: /interview\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // Today and an opened question (docs/understanding/SPEC.md §9): the hero
      // is read in full, an answer writes through the API, nothing is cut off.
      name: "today",
      testMatch: /today\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // Dashboard › Timeline (SEC-A009): dragging is for the iPad and the
      // desktop; a phone shows the board and taps to edit.
      name: "timeline",
      testMatch: /timeline\.spec\.ts/,
      use: { ...devices["iPad Pro 11 landscape"] },
    },
    {
      // On a phone the timeline is read and tapped, never dragged.
      name: "timeline-phone",
      testMatch: /timeline-phone\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // Overview, Needs a date and the project filter (SEC-A007), on both.
      name: "overview",
      testMatch: /overview\.spec\.ts/,
      use: { ...devices["iPad Pro 11 landscape"] },
    },
    {
      name: "overview-phone",
      testMatch: /overview\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // A chat answer reaches him (v1.09, docs/chat/SPEC.md §3): a cut stream
      // or the router's 503 page is resumed, and only his tap runs the turn
      // again. /api/chat is answered by page.route; no model is reached.
      name: "chat",
      testMatch: /chat-turn\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // Something he placed on the Overview stays there (v1.02): a list sent
      // to the top through the real tool, next up directly under it, after a
      // reload too. Last, because while it runs the shared board has a pin.
      name: "pins",
      testMatch: /pins\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // His project order (v1.11, docs/projects/SPEC.md §5): the Projects
      // screen at 390 wide against the approved values, the grab handle, a
      // failed store. After pins: it changes the shared user's project order.
      name: "projects",
      testMatch: /projects-order\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // A model write never loses his notes (v1.17, docs/tasks/SPEC.md §1):
      // his save from the editor keeps what a chat turn (the real route, the
      // model stand-in answering) and a call (the real tool route) added
      // while it was open.
      name: "notes",
      testMatch: /task-notes\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
    {
      // A task reads like a reminder (v1.10, docs/tasks/SPEC.md §2.4): the task
      // screen at 390 wide against the approved 1-task.html.
      name: "task",
      testMatch: /task-screen\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
  ],

  webServer: [
    {
      // Uses the build the verify job already produced; does not rebuild.
      command: `npx next start -p ${PORT}`,
      url: BASE_URL,
      env: {
        // `next start` runs in production mode, and without an explicit base URL
        // Better Auth falls through its protocol checks to "is production" and
        // issues a __Secure- prefixed session cookie. No browser accepts one of
        // those over plain http, so every spec ran signed out (CI run 8). Naming
        // the real http origin makes the decision deterministic and truthful.
        BETTER_AUTH_URL: BASE_URL,
        NEXT_PUBLIC_APP_URL: BASE_URL,
        // Answering a question schedules that project's understanding run
        // (docs/understanding/SPEC.md §6 step 4). CI carries placeholder model
        // keys, so without this the run would try a real call and fail in the
        // log after every answer; the specs assert on the writes, not the run.
        UNDERSTANDING_DISABLED: "true",
        // The Overview production renders (the LayoutPlan board), not the
        // legacy one that runs when the flag is unset (SEC-A007). Its planner
        // refines in the background with a model; SPEND_KILL refuses every
        // paid call but a user's own chat or voice turn, so none is made.
        ADAPTIVE_V2: "true",
        SPEND_KILL: "true",
        // A chat turn on a Claude model goes to the stand-in, with a key that is
        // not one (v1.17). The shared user's chat stays on the OpenAI default
        // unless a spec picks a Claude model for itself.
        CLAUDE_BRAIN: "true",
        ANTHROPIC_API_KEY: "e2e-standin-not-a-key",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${STANDIN_PORT}`,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "node e2e/model-standin.mjs",
      url: `http://127.0.0.1:${STANDIN_PORT}/health`,
      env: { STANDIN_PORT: String(STANDIN_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
