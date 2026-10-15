// v1.11 (docs/projects/SPEC.md §5): the Projects screen as approved, in a real
// browser at 390 wide, and his order by the grab handle. What vitest cannot
// see: the computed sizes and colours against the approved screen's own
// values (docs/projects/2-projects.png; the Reviewer's method: roles, not
// pixels), the 44 × 44 hit box, a drag that only starts at the handle, the row
// moving before the server answers, and a failed store putting it back with a
// plain line. Screenshots go to screenshots/ (the CI artifact), for the WebKit
// iPhone look. Last in the run: it changes the shared user's project order.
import { mkdirSync } from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const MINE = ["Garden shed", "Kitchen repaint", "Spring concert set", "Tax paperwork"];
const DIR = "screenshots";

async function tool(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const res = await request.post("/api/secretary/tools", { data: { name, args } });
  expect(res.ok(), `${name} ${JSON.stringify(args)}`).toBe(true);
}
/** My four, in the order the Active card shows them now. */
const order = async (page: Page) =>
  (await page.locator("[data-project-group='active'] [data-project-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-project-name") ?? ""))).filter((n) => MINE.includes(n));
const row = (page: Page, name: string) => page.locator(`[data-project-group='active'] [data-project-row][data-project-name="${name}"]`);
const handle = (page: Page, name: string) => page.getByRole("button", { name: `Reorder ${name}` });
/** The store of a move has answered (the row moved before it did). */
const stored = (page: Page) => page.waitForResponse((r) => r.url().includes("/api/projects/order") && r.request().method() === "POST");
/** A drag by the mouse from one handle to just above another row. */
async function drag(page: Page, name: string, aboveName: string) {
  const from = (await handle(page, name).boundingBox())!;
  const to = (await row(page, aboveName).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + ((to.y + 4 - (from.y + from.height / 2)) * i) / 8);
  await page.mouse.up();
}

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 390, height: 844 } });

test.beforeAll(async ({ request }) => {
  mkdirSync(DIR, { recursive: true });
  for (const name of MINE) await tool(request, "create_project", { name });
  for (const name of MINE) await tool(request, "create_task", { title: `${name}: something to do`, project: name });
});

test("the Projects screen as approved, at 390 wide: sizes, colours, the 44 × 44 handle", async ({ page }) => {
  await page.goto("/projects");
  const h1 = page.getByRole("heading", { level: 1, name: "Projects" });
  await expect(h1).toBeVisible();
  const styles = await page.evaluate(() => {
    const cs = (el: Element | null) => (el ? getComputedStyle(el) : null);
    const screen = document.querySelector("[data-projects-screen]");
    const card = document.querySelector("[data-project-group='active']");
    const r = document.querySelector("[data-project-group='active'] [data-project-row]");
    const name = r?.querySelector("[data-project-name-text]") ?? null;
    const count = r?.querySelector("[data-project-count]") ?? null;
    const dot = r?.querySelector("[data-project-dot]") ?? null;
    const btn = r?.querySelector("button[aria-label^='Reorder']") ?? null;
    const glyph = btn?.querySelector("svg") ?? null;
    const link = r?.querySelector("a") ?? null;
    const box = (el: Element | null) => (el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null);
    return {
      title: { size: cs(document.querySelector("h1"))!.fontSize, line: cs(document.querySelector("h1"))!.lineHeight, weight: cs(document.querySelector("h1"))!.fontWeight },
      ground: cs(screen)?.backgroundColor,
      card: { bg: cs(card)?.backgroundColor, radius: cs(card)?.borderTopLeftRadius },
      row: { minHeight: Math.round(r!.getBoundingClientRect().height), padLeft: cs(r)?.paddingLeft, padRight: cs(r)?.paddingRight },
      name: { size: cs(name)?.fontSize, weight: cs(name)?.fontWeight, color: cs(name)?.color },
      count: { size: cs(count)?.fontSize, color: cs(count)?.color },
      dot: box(dot),
      handle: box(btn),
      glyph: { ...box(glyph), fill: glyph?.getAttribute("fill") ?? cs(glyph)?.fill },
      touch: { handle: cs(btn)?.touchAction, row: cs(link)?.touchAction },
    };
  });
  expect(styles.title).toEqual({ size: "34px", line: "40px", weight: "700" });
  expect(styles.ground).toBe("rgb(242, 242, 247)");
  expect(styles.card).toEqual({ bg: "rgb(255, 255, 255)", radius: "12px" });
  expect(styles.row.minHeight).toBeGreaterThanOrEqual(56);
  expect([styles.row.padLeft, styles.row.padRight]).toEqual(["16px", "4px"]);
  expect(styles.name).toMatchObject({ size: "17px", weight: "400", color: "rgb(28, 28, 30)" });
  expect(styles.count).toEqual({ size: "15px", color: "rgb(110, 110, 115)" });
  expect(styles.dot).toEqual({ w: 12, h: 12 });
  expect(styles.handle).toEqual({ w: 44, h: 44 });
  expect(styles.glyph).toMatchObject({ w: 20, h: 20 });
  // The handle takes the touch; the rest of the row lets the page scroll.
  expect(styles.touch.handle).toBe("none");
  expect(styles.touch.row).not.toBe("none");
  await page.screenshot({ path: `${DIR}/projects-390.png` });
});

test("dark: the same roles on the dark tokens, text at 4.5:1", async ({ page, baseURL }) => {
  // Dark is his theme setting, kept in a cookie (app/layout.tsx), not the system's preference: v1.11's test set
  // the preference and measured the light page.
  await page.context().addCookies([{ name: "theme", value: "dark", url: baseURL! }]);
  await page.goto("/projects");
  expect(await page.evaluate(() => document.documentElement.dataset.theme), "the page is dark").toBe("dark");
  expect(await page.locator("[data-project-group='active']").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgb(255, 255, 255)");
  const ratios = await page.evaluate(() => {
    const rgb = (s: string) => (s.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (fg: string, bg: string) => {
      const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    };
    const card = getComputedStyle(document.querySelector("[data-project-group='active']")!).backgroundColor;
    const r = document.querySelector("[data-project-group='active'] [data-project-row]")!;
    return {
      name: ratio(getComputedStyle(r.querySelector("[data-project-name-text]")!).color, card),
      count: ratio(getComputedStyle(r.querySelector("[data-project-count]")!).color, card),
      title: ratio(getComputedStyle(document.querySelector("h1")!).color, getComputedStyle(document.querySelector("[data-projects-screen]")!).backgroundColor),
    };
  });
  for (const [what, r] of Object.entries(ratios)) expect(r, what).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: `${DIR}/projects-390-dark.png` });
});

// v1.11 r3: in dark the lifted row was the card's own colour, and its shadow does not show on black.
for (const theme of ["light", "dark"] as const) {
  test(`the lifted row in ${theme}: ${theme === "light" ? "white" : "the raised #2c2c2e, not the card's colour"}, its text at 4.5:1`, async ({ page, baseURL }) => {
    if (theme === "dark") await page.context().addCookies([{ name: "theme", value: "dark", url: baseURL! }]);
    await page.goto("/projects");
    expect(await page.evaluate(() => document.documentElement.dataset.theme ?? "light")).toBe(theme);
    const name = MINE.at(-1)!;
    const from = (await handle(page, name).boundingBox())!;
    await page.mouse.move(from.x + 22, from.y + 22);
    await page.mouse.down();
    await page.mouse.move(from.x + 22, from.y - 40, { steps: 4 });
    await expect(row(page, name)).toHaveAttribute("data-lifted", "true");
    const seen = await row(page, name).evaluate((li) => {
      const rgb = (s: string) => (s.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (fg: string, bg: string) => {
        const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
      };
      const fill = getComputedStyle(li).backgroundColor;
      return {
        fill,
        card: getComputedStyle(li.closest("[data-project-group]")!).backgroundColor,
        name: ratio(getComputedStyle(li.querySelector("[data-project-name-text]")!).color, fill),
        count: ratio(getComputedStyle(li.querySelector("[data-project-count]")!).color, fill),
      };
    });
    await page.screenshot({ path: `${DIR}/projects-390-dragging-${theme}.png` });
    // Back where it started before letting go: no move.
    await page.mouse.move(from.x + 22, from.y + 22, { steps: 4 });
    await page.mouse.up();
    if (theme === "light") expect(seen.fill).toBe("rgb(255, 255, 255)");
    else {
      expect(seen.fill).toBe("rgb(44, 44, 46)");
      expect(seen.fill, "not the card's own colour").not.toBe(seen.card);
    }
    expect(seen.name, "its name").toBeGreaterThanOrEqual(4.5);
    expect(seen.count, "its count").toBeGreaterThanOrEqual(4.5);
  });
}

test("a drag by the handle moves the project at once, and the order stays after a reload", async ({ page, request }, testInfo) => {
  // Run again (--repeat-each), mine are put back in their first order: the run before moved them.
  if (testInfo.repeatEachIndex > 0) for (const name of [...MINE].reverse()) await tool(request, "move_project", { project: name, to: "top" });
  await page.goto("/projects");
  expect(await order(page)).toEqual(MINE);
  // Held halfway: the row is lifted (at least 60 px tall, the rows it has not passed where they were), the handle
  // accent.
  const from = (await handle(page, "Tax paperwork").boundingBox())!;
  const firstTop = async () => (await row(page, "Garden shed").boundingBox())!.y;
  const firstBefore = await firstTop();
  await page.mouse.move(from.x + 22, from.y + 22);
  await page.mouse.down();
  await page.mouse.move(from.x + 22, from.y - 40, { steps: 4 });
  await expect(row(page, "Tax paperwork")).toHaveAttribute("data-lifted", "true");
  expect((await row(page, "Tax paperwork").boundingBox())!.height, "the lifted row's height").toBeGreaterThanOrEqual(60);
  expect(Math.abs((await firstTop()) - firstBefore), "a row it has not passed does not move").toBeLessThanOrEqual(0.5);
  await page.screenshot({ path: `${DIR}/projects-390-dragging.png` });
  // Back where it started before letting go: no move, nothing stored.
  await page.mouse.move(from.x + 22, from.y + 22, { steps: 4 });
  await page.mouse.up();
  expect(await order(page)).toEqual(MINE);
  const second = stored(page);
  await drag(page, "Tax paperwork", "Garden shed");
  expect(await order(page)).toEqual(["Tax paperwork", "Garden shed", "Kitchen repaint", "Spring concert set"]);
  await second;
  await page.reload();
  expect(await order(page)).toEqual(["Tax paperwork", "Garden shed", "Kitchen repaint", "Spring concert set"]);
});

test("a drag never starts from the row body, and a tap on the row opens the project", async ({ page }) => {
  await page.goto("/projects");
  const before = await order(page);
  const name = (await row(page, "Kitchen repaint").locator("[data-project-name-text]").boundingBox())!;
  await page.mouse.move(name.x + 10, name.y + name.height / 2);
  await page.mouse.down();
  await page.mouse.move(name.x + 10, name.y - 120, { steps: 6 });
  await page.mouse.up();
  await page.goto("/projects");
  expect(await order(page)).toEqual(before);
  await row(page, "Kitchen repaint").locator("[data-project-name-text]").tap();
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
});

test("the strip between the count and the handle opens the project, like the rest of the row", async ({ page }) => {
  await page.goto("/projects");
  const count = (await row(page, "Kitchen repaint").locator("[data-project-count]").boundingBox())!;
  const grab = (await handle(page, "Kitchen repaint").boundingBox())!;
  expect(grab.x - (count.x + count.width), "the strip is there, 12 px").toBeGreaterThanOrEqual(10);
  await page.mouse.click((count.x + count.width + grab.x) / 2, count.y + count.height / 2);
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
});

test("the handle's arrow keys move the project one place", async ({ page }) => {
  await page.goto("/projects");
  const before = await order(page);
  const last = before.at(-1)!;
  await handle(page, last).focus();
  const saved = stored(page);
  await page.keyboard.press("ArrowUp");
  const moved = [...before.slice(0, -2), last, before.at(-2)!];
  await expect.poll(() => order(page)).toEqual(moved);
  await saved;
  await page.reload();
  expect(await order(page)).toEqual(moved);
});

test("New project: a row at the top of Active, the name field focused; Enter makes it, an empty name makes nothing", async ({ page }, testInfo) => {
  // A name of its own on each run: a name that is there already makes nothing new.
  const made = testInfo.repeatEachIndex > 0 ? `Bike tune-up ${testInfo.repeatEachIndex + 1}` : "Bike tune-up";
  await page.goto("/projects");
  const count = await page.locator("[data-project-group='active'] [data-project-row]").count();
  await page.getByRole("button", { name: "New project" }).click();
  const field = page.getByRole("textbox", { name: "New project name" });
  await expect(field).toBeFocused();
  await page.screenshot({ path: `${DIR}/projects-390-new.png` });
  // Nothing typed, the field left: nothing is made, the row goes.
  await field.blur();
  await expect(field).toHaveCount(0);
  expect(await page.locator("[data-project-group='active'] [data-project-row]").count()).toBe(count);
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByRole("textbox", { name: "New project name" }).fill(made);
  await page.keyboard.press("Enter");
  await expect(row(page, made)).toBeVisible();
  expect(await page.locator("[data-project-group='active'] [data-project-row]").count()).toBe(count + 1);
});

test("a store that fails puts the row back and says so plainly", async ({ page }) => {
  await page.goto("/projects");
  const before = await order(page);
  await page.route("**/api/projects/order", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "down" }) }));
  await drag(page, before.at(-1)!, before[0]);
  await expect(page.getByText(`Couldn't move ${before.at(-1)}. It's back where it was.`)).toBeVisible();
  expect(await order(page)).toEqual(before);
});

test("held near the top edge, a long list scrolls under the row: a project goes from the bottom to the top in one drag", async ({ page, request }) => {
  for (let i = 1; i <= 12; i++) await tool(request, "create_project", { name: `Long list ${String(i).padStart(2, "0")}` });
  await page.goto("/projects");
  const names = () => page.locator("[data-project-group='active'] [data-project-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-project-name") ?? ""));
  const before = await names();
  expect(before.length).toBeGreaterThanOrEqual(16);
  const last = before.at(-1)!;
  // The list is longer than the screen: its last row is reached by scrolling the page's own scroller.
  const scroller = page.locator("main");
  await handle(page, last).scrollIntoViewIfNeeded();
  const startScroll = await scroller.evaluate((el) => el.scrollTop);
  expect(startScroll, "the list is longer than the screen").toBeGreaterThan(200);
  const from = (await handle(page, last).boundingBox())!;
  const top = (await scroller.boundingBox())!.y;
  await page.mouse.move(from.x + 22, from.y + 22);
  await page.mouse.down();
  // To the top edge of the list's view, and held there while the list scrolls under it.
  await page.mouse.move(from.x + 22, top + 6, { steps: 12 });
  const t0 = Date.now();
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBe(0);
  console.log(`[edge scroll] ${startScroll} px to the top in ${Date.now() - t0} ms, held 6 px from the edge`);
  // Let go there: held above the first row, it is first (the rows have made room below it).
  await expect(row(page, before[0])).toBeInViewport();
  const saved = stored(page);
  await page.mouse.up();
  await saved;
  await page.reload();
  expect((await names())[0]).toBe(last);
});

// v1.11 r3, the bottom edge (the Reviewer's r2 finding): a row held at the bottom ran the list past its end in
// Chromium (the held row's transform counts in the scroller's overflow, and the scroll had no limit), the row was then
// off the finger, and the zone itself lay under the tab bar. These tests use the long list made just above.

/** Every row of Active, in order. */
const activeNames = (page: Page) => page.locator("[data-project-group='active'] [data-project-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-project-name") ?? ""));
/** The top of what covers the bottom of the screen: the tab bar, and the voice button above it at the right. */
const coveredTop = (page: Page) =>
  page.evaluate(() => Math.min(...["tab-bar", "chat-launcher"].map((id) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top)));
/** A finger: the mouse, or a real touch through the DevTools protocol (Chromium only). */
type Finger = { down: (x: number, y: number) => Promise<void>; move: (x: number, y: number, steps: number) => Promise<void>; up: () => Promise<void> };
async function fingerOf(page: Page, input: "mouse" | "touch"): Promise<Finger> {
  if (input === "mouse")
    return {
      down: async (x, y) => {
        await page.mouse.move(x, y);
        await page.mouse.down();
      },
      move: (x, y, steps) => page.mouse.move(x, y, { steps }),
      up: () => page.mouse.up(),
    };
  const cdp = await page.context().newCDPSession(page);
  let at = { x: 0, y: 0 };
  const send = async (type: "touchStart" | "touchMove" | "touchEnd", p?: { x: number; y: number }) => {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [p] : [] });
  };
  return {
    down: async (x, y) => {
      at = { x, y };
      await send("touchStart", at);
    },
    move: async (x, y, steps) => {
      const from = at;
      for (let i = 1; i <= steps; i++) {
        at = { x: from.x + ((x - from.x) * i) / steps, y: from.y + ((y - from.y) * i) / steps };
        await send("touchMove", at);
        await page.waitForTimeout(16);
      }
    },
    up: () => send("touchEnd"),
  };
}
/** A list longer than the screen: the test above makes one; run alone, these tests make their own. */
async function longList(request: APIRequestContext, page: Page) {
  await page.goto("/projects");
  const have = (await activeNames(page)).length;
  for (let i = have + 1; i <= 17; i++) await tool(request, "create_project", { name: `Edge list ${String(i).padStart(2, "0")}` });
  if (have < 17) await page.goto("/projects");
}
/** The scroller's highest scrollTop from now on, read every frame in the page. */
const recordTop = (page: Page) =>
  page.locator("main").evaluate((m) => {
    const w = window as unknown as { __maxTop: number };
    w.__maxTop = m.scrollTop;
    const tick = () => {
      w.__maxTop = Math.max(w.__maxTop, m.scrollTop);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

for (const input of ["mouse", "touch"] as const) {
  test.describe(`the bottom edge, by ${input}`, () => {
    if (input === "touch") test.use({ hasTouch: true, isMobile: true });
    for (const hold of [400, 1500]) {
      test(`held at the bottom for ${hold} ms, then back to the middle: the list stops at its end, the row stays under the finger, it lands where it is let go`, async ({ page, browserName, request }) => {
        test.skip(input === "touch" && browserName !== "chromium", "Playwright sends touch input to Chromium only");
        await longList(request, page);
        const main = page.locator("main");
        await main.evaluate((m) => (m.scrollTop = 0));
        const before = await activeNames(page);
        const first = before[0];
        // The list's end, measured before anything is held.
        const max = await main.evaluate((m) => m.scrollHeight - m.clientHeight);
        expect(max, "the list is longer than the screen").toBeGreaterThan(200);
        const height = page.viewportSize()!.height;
        const h = (await handle(page, first).boundingBox())!;
        const x = h.x + h.width / 2;
        await recordTop(page);
        const finger = await fingerOf(page, input);
        await finger.down(x, h.y + h.height / 2);
        // All the way down, over the tab bar: inside the edge zone wherever it is.
        await finger.move(x, height - 6, 12);
        await page.waitForTimeout(hold);
        const mid = Math.round(height / 2);
        await finger.move(x, mid, 6);
        await page.waitForTimeout(400);
        const seen = await page.evaluate((y) => {
          const rows = [...document.querySelectorAll("[data-project-group='active'] [data-project-row]")];
          const lifted = rows.find((r) => r.getAttribute("data-lifted") === "true")!;
          const centre = (el: Element) => {
            const b = el.getBoundingClientRect();
            return b.top + b.height / 2;
          };
          return {
            maxTop: (window as unknown as { __maxTop: number }).__maxTop,
            top: document.querySelector("main")!.scrollTop,
            rowOffFinger: centre(lifted) - y,
            // The place under the finger: the rows (the held one aside) whose centre is above it.
            under: rows.filter((r) => r !== lifted && centre(r) < y).length,
          };
        }, mid);
        console.log(`[bottom edge] ${input} ${hold} ms: max ${max}, highest scrollTop ${seen.maxTop}, now ${seen.top}, row ${seen.rowOffFinger} px off the finger, place under it ${seen.under}`);
        expect(seen.maxTop, "the list never scrolls past its end").toBeLessThanOrEqual(max + 1);
        expect(Math.abs(seen.rowOffFinger), "the held row is under the finger").toBeLessThanOrEqual(3);
        const saved = seen.under !== 0 ? stored(page) : null;
        await finger.up();
        await saved;
        expect((await activeNames(page)).indexOf(first), "it lands at the place under the finger").toBe(seen.under);
        // Back on top for the next test.
        if (seen.under !== 0) await tool(request, "move_project", { project: first, to: "top" });
      });
    }
  });
}

for (const [label, viewport] of [
  ["a phone", { width: 390, height: 844 }],
  ["a wide screen", { width: 1280, height: 800 }],
] as const) {
  test.describe(`the bottom edge zone on ${label}`, () => {
    test.use({ viewport });
    test("is above the tab bar and the voice button, 64 px tall: held just above the voice button the list scrolls, held just above the zone it does not", async ({ page, request }) => {
      await longList(request, page);
      const main = page.locator("main");
      await main.evaluate((m) => (m.scrollTop = 0));
      expect(await main.evaluate((m) => m.scrollHeight - m.clientHeight), "the list is longer than the screen").toBeGreaterThan(0);
      const covered = await coveredTop(page);
      const first = (await activeNames(page))[0];
      const h = (await handle(page, first).boundingBox())!;
      const x = h.x + h.width / 2;
      await page.mouse.move(x, h.y + h.height / 2);
      await page.mouse.down();
      // Just above the zone: nothing scrolls.
      await page.mouse.move(x, covered - 64 - 8, { steps: 8 });
      await page.waitForTimeout(500);
      expect(await main.evaluate((m) => m.scrollTop), `held ${64 + 8} px above the voice button`).toBe(0);
      // Just above the voice button, inside the zone: the list scrolls.
      await page.mouse.move(x, covered - 8, { steps: 4 });
      await expect.poll(() => main.evaluate((m) => m.scrollTop), { timeout: 2_000, message: "held 8 px above the voice button" }).toBeGreaterThan(0);
      await page.screenshot({ path: `${DIR}/projects-${viewport.width}-bottom-edge.png` });
      // Let go, and the first project back on top for the next test.
      await page.mouse.up();
      await page.waitForTimeout(300);
      if ((await activeNames(page))[0] !== first) await tool(request, "move_project", { project: first, to: "top" });
    });
  });
}
