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

test("dark: the same roles on the dark tokens, text at 4.5:1", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/projects");
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

test("a drag by the handle moves the project at once, and the order stays after a reload", async ({ page }) => {
  await page.goto("/projects");
  expect(await order(page)).toEqual(MINE);
  // Held halfway: the row is lifted, the handle accent.
  const from = (await handle(page, "Tax paperwork").boundingBox())!;
  await page.mouse.move(from.x + 22, from.y + 22);
  await page.mouse.down();
  await page.mouse.move(from.x + 22, from.y - 40, { steps: 4 });
  await expect(row(page, "Tax paperwork")).toHaveAttribute("data-lifted", "true");
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

test("New project: a row at the top of Active, the name field focused; Enter makes it, an empty name makes nothing", async ({ page }) => {
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
  await page.getByRole("textbox", { name: "New project name" }).fill("Bike tune-up");
  await page.keyboard.press("Enter");
  await expect(row(page, "Bike tune-up")).toBeVisible();
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
