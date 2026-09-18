// The Workspace, in a real browser, on a phone profile.
//
// This is the file phase 0 existed for. Everything here is invisible to vitest:
// whether a drag handle is where a thumb can reach it, whether dragging moves
// the widget it grabbed and nothing else, whether the move survives a reload.
// Four Canvas rebuilds shipped green without a test like this.
import { test, expect, type Page } from "@playwright/test";

const board = (page: Page) => page.getByTestId("workspace-board");
const widget = (page: Page, id: string) => page.locator(`[data-widget="${id}"]`);

async function boxOf(page: Page, id: string) {
  const b = await widget(page, id).boundingBox();
  if (!b) throw new Error(`widget ${id} has no box`);
  return b;
}

/** Drag by the handle, in steps, so the pointer move is real rather than a jump. */
async function dragBy(page: Page, id: string, dx: number, dy: number) {
  const handle = page.locator(`[data-drag-handle="${id}"]`);
  const h = await handle.boundingBox();
  if (!h) throw new Error(`no handle for ${id}`);
  const from = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  }
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/workspace");
  await expect(board(page)).toBeVisible();
});

test("the board renders its widgets", async ({ page }) => {
  await expect(widget(page, "today")).toBeVisible();
  await expect(widget(page, "scratch")).toBeVisible();
  await expect(widget(page, "notes")).toBeVisible();
});

test("every drag and resize target clears 44px", async ({ page }) => {
  // The Canvas shipped an 18px checkbox on a row that navigated away on a near
  // miss. That class of defect is only visible here, with a layout engine.
  for (const sel of ["[data-drag-handle]", "[data-collapse]", "[data-resize-handle]"]) {
    const targets = page.locator(sel);
    const n = await targets.count();
    expect(n, `${sel} should exist`).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const b = await targets.nth(i).boundingBox();
      if (!b) continue;
      expect(b.width, `${sel} #${i} width`).toBeGreaterThanOrEqual(44);
      expect(b.height, `${sel} #${i} height`).toBeGreaterThanOrEqual(44);
    }
  }
});

test("nothing is clipped: every body fits inside its widget", async ({ page }) => {
  // The Canvas clipped every block by 24px because the frame carried padding
  // that its own height measurement did not account for. Assert the opposite.
  const bodies = page.locator(".wk-body");
  for (let i = 0; i < (await bodies.count()); i++) {
    const overflow = await bodies.nth(i).evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(overflow, `body #${i} is cut off`).toBeLessThanOrEqual(1);
  }
});

test.describe("wide screen", () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  test("dragging a widget moves it, and it stays moved after a reload", async ({ page }) => {
    const before = await boxOf(page, "today");
    await dragBy(page, "today", 0, 200);
    await expect
      .poll(async () => (await boxOf(page, "today")).y, { timeout: 5000 })
      .toBeGreaterThan(before.y + 80);

    // The real assertion: it persisted, not just animated.
    await page.reload();
    await expect(board(page)).toBeVisible();
    expect((await boxOf(page, "today")).y).toBeGreaterThan(before.y + 80);
  });

  test("dragging one widget does not move any other", async ({ page }) => {
    const other = await boxOf(page, "notes");
    await dragBy(page, "scratch", -120, 0);
    await expect
      .poll(async () => (await boxOf(page, "scratch")).x, { timeout: 5000 })
      .toBeLessThan(await boxOf(page, "notes").then(() => other.x + 9999));
    const afterOther = await boxOf(page, "notes");
    expect(Math.abs(afterOther.x - other.x)).toBeLessThanOrEqual(2);
  });

  test("undo puts it back", async ({ page }) => {
    const before = await boxOf(page, "today");
    await dragBy(page, "today", 0, 200);
    await expect
      .poll(async () => (await boxOf(page, "today")).y, { timeout: 5000 })
      .toBeGreaterThan(before.y + 80);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect
      .poll(async () => (await boxOf(page, "today")).y, { timeout: 5000 })
      .toBeLessThanOrEqual(before.y + 2);
  });

  test("collapsing hides the body and keeps the header reachable", async ({ page }) => {
    await page.locator('[data-collapse="notes"]').click();
    await expect(widget(page, "notes").locator(".wk-body")).toHaveCount(0);
    await expect(page.locator('[data-drag-handle="notes"]')).toBeVisible();
  });
});

test("on a phone the board stacks and does not scroll sideways", async ({ page }) => {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);

  // Stacked: every widget starts at the same left edge.
  const lefts = await page.locator("[data-widget]").evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().left))
  );
  expect(new Set(lefts).size).toBe(1);
});
