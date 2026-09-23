// Screenshots of the real app on the iPhone profile, taken on every CI run and
// uploaded as the "screenshots" artifact (.github/workflows/deploy.yml).
//
// Why: the Mac that develops this app cannot run a browser harness (see
// playwright.config.ts), so until now no one saw a screen before it shipped.
// These are not assertions; they are the eyes. A layout that only reads
// correctly in the DOM and not on a 393-pixel screen is caught here, by a
// person looking at a picture, which is the review the user asked for.
//
// This project runs after the Workspace specs and BEFORE the Today specs, so
// the seeded question (e2e/global-setup.ts E2E_QUESTION) is still open in the
// pictures: the hero card with its answers, and the question opened with its
// evidence. Nothing here changes state. Visiting Today marks the seeded
// question as surfaced, which the Today specs do not depend on.
import { mkdirSync } from "node:fs";
import { test, type Page } from "@playwright/test";
import { E2E_QUESTION } from "./global-setup";

const DIR = "screenshots";

test.beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
});

/** The iPhone 15 viewport Playwright gives the "screens" project. */
const PHONE = { width: 393, height: 659 };
/** Tall enough to show a whole screen's content; the shell scrolls inside a
 *  fixed-height column, so fullPage cannot reach below the first fold. */
const TALL = { width: 393, height: 1800 };

async function shoot(page: Page, path: string, name: string) {
  await page.setViewportSize(PHONE);
  await page.goto(path);
  // Fonts and the first data refresh settle within a beat; a picture of a
  // half-painted page tells the reviewer nothing.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  // What the user sees first.
  await page.screenshot({ path: `${DIR}/${name}.png` });
  // Everything on the screen, for reading the parts under the fold and the
  // docked composer.
  await page.setViewportSize(TALL);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${DIR}/${name}-full.png` });
}

test("Today", async ({ page }) => {
  await shoot(page, "/today", "today");
});

test("Today, writing an answer", async ({ page }) => {
  // ?own=open shows "Write your own" already open, with nothing typed and
  // nothing sent (components/today/answer-buttons.tsx useOwnWordsFromUrl),
  // so the field is in the pictures without a model to answer with.
  await shoot(page, "/today?own=open", "today-writing");
});

test("Today, thinking", async ({ page }) => {
  // ?thinking=open shows the strip above the hero in its active state, as if
  // a project were being read, with nothing polled and nothing sent
  // (components/today/thinking-strip.tsx), so the bars and the line are in
  // the pictures without a model to answer with.
  await shoot(page, "/today?thinking=open", "today-thinking");
});

test("Today, reading failed", async ({ page }) => {
  // ?thinking=failed shows the strip's failed state: the line in the warn
  // tone, why, and the way to fix it as a link to Settings.
  await shoot(page, "/today?thinking=failed", "today-reading-failed");
});

test("A question, opened", async ({ page }) => {
  await shoot(page, `/today/${E2E_QUESTION.id}`, "question");
});

test("Interview", async ({ page }) => {
  await shoot(page, "/interview", "interview");
});

test("Workspace", async ({ page }) => {
  await shoot(page, "/workspace", "workspace");
});

test("Settings", async ({ page }) => {
  await shoot(page, "/settings", "settings");
});

test("Dashboard", async ({ page }) => {
  await shoot(page, "/dashboard", "dashboard");
});
