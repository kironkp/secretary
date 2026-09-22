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
      // Today and an opened question (docs/understanding/SPEC.md §9): the hero
      // is read in full, an answer writes through the API, nothing is cut off.
      name: "today",
      testMatch: /today\.spec\.ts/,
      use: { ...devices["iPhone 15"] },
    },
  ],

  webServer: {
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
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
