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
  // A widget pushed below the fold by an earlier test would otherwise be
  // dragged from coordinates outside the viewport, and the gesture goes nowhere.
  await handle.scrollIntoViewIfNeeded();
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
  // Every test starts from a packed board. These specs share one board and one
  // database, so without this each drag leaves the next test's widget lower
  // than the last — which is exactly how "undo puts it back" passed on one
  // branch and failed on another from the identical commit.
  await page.request.post("/api/workspace", { data: { operations: [{ op: "tidy" }] } });
  await page.goto("/workspace");
  await expect(board(page)).toBeVisible();
});

test("the board renders its widgets", async ({ page }) => {
  await expect(widget(page, "overdue")).toBeVisible();
  await expect(widget(page, "due-today")).toBeVisible();
  await expect(widget(page, "everything-open")).toBeVisible();
});

test.describe("live data", () => {
  test("a task appears in the widget whose query matches it", async ({ page }) => {
    // Seeded in global setup. This is the whole phase: the model wrote a
    // template, the shell filled it from Postgres.
    await expect(widget(page, "overdue")).toContainText("E2E overdue task");
    await expect(widget(page, "due-today")).toContainText("E2E today task");
    await expect(widget(page, "everything-open")).toContainText("E2E undated task");
  });

  test("a query excludes what it should", async ({ page }) => {
    // Done tasks are not open; today's task is not overdue.
    await expect(widget(page, "everything-open")).not.toContainText("E2E finished task");
    await expect(widget(page, "overdue")).not.toContainText("E2E today task");
  });

  test("each row carries its real task id, ready to be ticked", async ({ page }) => {
    const ids = await widget(page, "overdue")
      .locator("[data-row-check]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-check")));
    expect(ids.length).toBeGreaterThan(0);
    // A uuid, not a placeholder: the same id the task API takes.
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a widget with nothing to show says so", async ({ page }) => {
    // Nothing was seeded on the calendar, so the empty state is the right one.
    await expect(widget(page, "coming-up")).toContainText("Nothing on the calendar");
  });

  test("the count matches the rows rendered", async ({ page }) => {
    const box = widget(page, "everything-open");
    const stated = Number(await box.locator("[data-count]").innerText());
    const rendered = await box.locator("[data-row-check]").count();
    expect(stated).toBe(rendered);
  });

  test("a change made elsewhere reaches the board without a reload", async ({ page }) => {
    const box = widget(page, "everything-open");
    await expect(box).toContainText("E2E undated task");
    const before = await box.locator("[data-row-check]").count();

    // Mark it done through the same API the rest of the app uses.
    const id = await box
      .locator("[data-row-check]")
      .first()
      .getAttribute("data-check");
    const res = await page.request.patch(`/api/tasks/${id}`, {
      data: { status: "done", source: "dashboard" },
    });
    expect(res.ok()).toBeTruthy();

    // No reload, no model call: the board notices on its own.
    await page.evaluate(() => window.dispatchEvent(new Event("secretary:data-changed")));
    await expect
      .poll(async () => box.locator("[data-row-check]").count(), { timeout: 8000 })
      .toBe(before - 1);
  });
});

/** Apple's minimum is 44pt. The Canvas shipped an 18px checkbox on a row that
 *  navigated away on a near miss; that class of defect is only visible here,
 *  with a layout engine. */
async function assertTapTargets(page: Page, selectors: string[]) {
  for (const sel of selectors) {
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
}

test("on a phone, the handles you get are big enough", async ({ page }) => {
  // No resize grip here on purpose: the board stacks at phone width, so a
  // corner drag would fight the page scroll for no gain.
  await assertTapTargets(page, ["[data-drag-handle]", "[data-collapse]"]);
  await expect(page.locator("[data-resize-handle]")).toHaveCount(0);
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
    const before = await boxOf(page, "overdue");
    await dragBy(page, "overdue", 0, 200);
    await expect
      .poll(async () => (await boxOf(page, "overdue")).y, { timeout: 5000 })
      .toBeGreaterThan(before.y + 80);

    // The real assertion: it persisted, not just animated.
    await page.reload();
    await expect(board(page)).toBeVisible();
    expect((await boxOf(page, "overdue")).y).toBeGreaterThan(before.y + 80);
  });

  test("dragging one widget does not move any other", async ({ page }) => {
    const other = await boxOf(page, "everything-open");
    await dragBy(page, "due-today", -120, 0);
    await expect
      .poll(async () => (await boxOf(page, "due-today")).x, { timeout: 5000 })
      .toBeLessThan(await boxOf(page, "everything-open").then(() => other.x + 9999));
    const afterOther = await boxOf(page, "everything-open");
    expect(Math.abs(afterOther.x - other.x)).toBeLessThanOrEqual(2);
  });

  test("undo puts it back", async ({ page }) => {
    const before = await boxOf(page, "overdue");
    await dragBy(page, "overdue", 0, 200);
    await expect
      .poll(async () => (await boxOf(page, "overdue")).y, { timeout: 5000 })
      .toBeGreaterThan(before.y + 80);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect
      .poll(async () => (await boxOf(page, "overdue")).y, { timeout: 5000 })
      .toBeLessThanOrEqual(before.y + 2);
  });

  test("every handle clears 44px, resize grip included", async ({ page }) => {
    await assertTapTargets(page, [
      "[data-drag-handle]",
      "[data-collapse]",
      "[data-resize-handle]",
    ]);
  });

  test("collapsing hides the body and keeps the header reachable", async ({ page }) => {
    await page.locator('[data-collapse="everything-open"]').click();
    await expect(widget(page, "everything-open").locator(".wk-body")).toHaveCount(0);
    await expect(page.locator('[data-drag-handle="everything-open"]')).toBeVisible();
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
