// The gating browser test. Keep it green: CI is what Heroku waits on before it
// deploys. Everything asserted here is something vitest structurally cannot
// see — a real layout, at a real phone width, in a real browser.
import { test, expect } from "@playwright/test";
import { TEST_USER } from "./global-setup";

test.describe("signed in, on a phone", () => {
  // If the saved session did not survive into the browser context, every test
  // below fails as a redirect and reads like an app bug. Say so once, here.
  test.beforeEach(async ({ context }) => {
    const jar = await context.cookies();
    // Match the suffix: Better Auth prefixes the name with __Secure- when it
    // believes the origin is https, and the prefix itself is what browsers
    // reject over http.
    expect(
      jar.map((c) => c.name).join(","),
      "the browser context carries no session cookie: global setup's storage state did not load"
    ).toContain("better-auth.session_token");
  });

  test("the dashboard renders", async ({ page }) => {
    await page.goto("/dashboard");
    // Not a redirect back to sign-in: the saved session is real.
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.locator("main")).toBeVisible();
  });

  test("nothing overflows the viewport sideways", async ({ page }) => {
    // The single cheapest guard against a layout that looks fine on a laptop
    // and is unusable on the device the user actually holds.
    for (const path of ["/dashboard", "/canvas"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      });
      expect(
        overflow.scrollWidth,
        `${path} scrolls sideways at phone width (${overflow.scrollWidth} > ${overflow.clientWidth})`
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    }
  });

  test("the nav tabs are reachable and every tap target is big enough", async ({ page }) => {
    await page.goto("/dashboard");
    const tabs = page.locator("nav a");
    await expect(tabs.first()).toBeVisible();

    // Apple's minimum is 44pt. The Canvas shipped an 18px checkbox; this is the
    // assertion that would have caught it, applied to the chrome we own.
    const count = await tabs.count();
    for (let i = 0; i < count; i++) {
      const box = await tabs.nth(i).boundingBox();
      if (!box) continue;
      const label = (await tabs.nth(i).textContent())?.trim() || `tab ${i}`;
      expect(box.height, `nav tap target "${label}" is ${box.height}px tall`).toBeGreaterThanOrEqual(36);
    }
  });
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a protected page redirects to sign-in", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByLabel(/email/i)).toBeVisible();
  });
});

test.describe("remember me (SEC-A012)", () => {
  // A fresh browser, signed in through the real form: what the box says is
  // what the session cookie does.
  test.use({ storageState: { cookies: [], origins: [] } });

  const signInThroughTheForm = async (page: import("@playwright/test").Page, remember: boolean) => {
    await page.goto("/sign-in");
    const box = page.locator("#remember");
    await expect(box).toBeChecked(); // ticked by default
    if (!remember) await box.uncheck();
    await page.locator("#email").fill(TEST_USER.email);
    await page.locator("#password").fill(TEST_USER.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
  };
  const sessionCookie = async (page: import("@playwright/test").Page) =>
    (await page.context().cookies()).find((c) => c.name.endsWith("better-auth.session_token"));

  test("ticked: the session cookie lasts about 60 days", async ({ page }) => {
    await signInThroughTheForm(page, true);
    const cookie = await sessionCookie(page);
    expect(cookie, "no session cookie after signing in").toBeTruthy();
    const days = (cookie!.expires * 1000 - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
    expect(days).toBeLessThan(61);
  });

  test("unticked: the session cookie ends with the browser", async ({ page }) => {
    await signInThroughTheForm(page, false);
    const cookie = await sessionCookie(page);
    expect(cookie, "no session cookie after signing in").toBeTruthy();
    expect(cookie!.expires).toBe(-1);
  });
});
