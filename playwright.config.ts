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
    storageState: "e2e/.auth/user.json",
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
    // Workspace interaction tests (drag, resize, tap) land with phase 1 of
    // docs/workspace/SPEC.md. They are the reason this harness exists: that
    // surface gets a real browser from its first commit, not after four
    // rebuilds.
  ],

  webServer: {
    // Uses the build the verify job already produced; does not rebuild.
    command: `npx next start -p ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
