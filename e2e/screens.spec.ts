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

async function shoot(page: Page, path: string, name: string) {
  await page.goto(path);
  // Fonts and the first data refresh settle within a beat; a picture of a
  // half-painted page tells the reviewer nothing.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
}

test("Today", async ({ page }) => {
  await shoot(page, "/today", "today");
});

test("A question, opened", async ({ page }) => {
  await shoot(page, `/today/${E2E_QUESTION.id}`, "question");
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
