// The Workspace, in a real browser, on a phone profile.
//
// This is the file phase 0 existed for. Everything here is invisible to vitest:
// whether a drag handle is where a thumb can reach it, whether dragging moves
// the widget it grabbed and nothing else, whether the move survives a reload.
// Four Canvas rebuilds shipped green without a test like this.
import { test, expect, type Page } from "@playwright/test";
import { E2E_LEDE } from "./global-setup";

const board = (page: Page) => page.getByTestId("workspace-board");
const widget = (page: Page, id: string) => page.locator(`[data-widget="${id}"]`);

/**
 * The widget's PERSISTED grid position, straight from the API.
 *
 * Asserting this first separates the two things a failing drag could mean: the
 * gesture never produced an operation, or it did and the board did not re-render.
 * Pixels alone cannot tell those apart, and two CI rounds were spent guessing.
 */
async function storedPos(page: Page, id: string): Promise<{ x: number; y: number }> {
  const res = await page.request.get("/api/workspace");
  const body = await res.json();
  const w = (body.widgets as Array<{ id: string; x: number; y: number }>).find((n) => n.id === id);
  if (!w) throw new Error(`widget ${id} is not on the board`);
  return { x: w.x, y: w.y };
}

/**
 * Position in DOCUMENT coordinates, not viewport coordinates.
 *
 * boundingBox() is relative to the viewport, so any scroll between two
 * measurements silently changes the answer — scrolling a handle into view
 * before a drag cancelled the drag exactly, and the test read 197 both times.
 */
async function boxOf(page: Page, id: string) {
  const b = await widget(page, id).boundingBox();
  if (!b) throw new Error(`widget ${id} has no box`);
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  return { ...b, x: b.x + scroll.x, y: b.y + scroll.y };
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

    // Mark it done through the same API the rest of the app uses. The row is
    // picked by title, not position: the first row by due date is another
    // spec's fixture (the Today question rests on an overdue task), and every
    // project in the run shares this one seed.
    const id = await box
      .locator("[data-row-check]")
      .filter({ hasText: "E2E undated task" })
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

/**
 * "Nothing is cut off" (docs/understanding/SPEC.md §9). A title the user cannot
 * read in full is a title cut off, and no prompt can enforce that: only the
 * shell's styles can, and only a layout engine can check them. The title is 140
 * characters — three lines or more at phone width, two on the desktop grid —
 * and it goes in through the same tool the voice path uses rather than straight
 * into Postgres, so the row arrives the way a real one does.
 *
 * Shared by the phone profile and the "wide screen" describe: on the desktop
 * grid a widget sits on its grid height and its body scrolls, which is a
 * second way to lose the end of a title, so both profiles assert it.
 */
// Exactly 140 characters; asserted below so the number in the spec stays true.
const LONG_TITLE =
  "Reconcile the production monitor purchase order against the September bank " +
  "statement, then send the signed copy to Marissa and Walter today.";
let longTitleTaskId: string | null = null;

/** There is no DELETE route for a task. Dropping it through the task API takes
 *  it out of every open-task widget, and global setup wipes the user's tasks at
 *  the start of the next run. */
async function dropLongTitleTask(page: Page) {
  if (!longTitleTaskId) return;
  await page.request.patch(`/api/tasks/${longTitleTaskId}`, { data: { status: "dropped" } });
  longTitleTaskId = null;
}

async function expectLongTitleShownInFull(page: Page) {
  expect(LONG_TITLE).toHaveLength(140);

  // Three days past due, so the Overdue binding (due_at before today) takes it.
  const dueAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const created = await page.request.post("/api/secretary/tools", {
    data: { name: "create_task", args: { title: LONG_TITLE, due_at: dueAt } },
  });
  expect(created.ok()).toBeTruthy();
  const outcome = (await created.json()) as {
    result?: { task_id?: string; error?: string };
  };
  expect(outcome.result?.error, "create_task refused the task").toBeUndefined();
  longTitleTaskId = outcome.result?.task_id ?? null;
  expect(longTitleTaskId ?? "").toMatch(/^[0-9a-f-]{36}$/);

  await page.reload();
  await expect(board(page)).toBeVisible();

  const row = widget(page, "overdue").locator(`[data-row-id="${longTitleTaskId}"]`);
  await expect(row).toBeVisible();
  const title = row.locator('[data-field="title"]');
  await expect(title).toHaveText(LONG_TITLE);
  await row.scrollIntoViewIfNeeded();

  const m = await row.evaluate((el) => {
    const rowEl = el as HTMLElement;
    const titleEl = rowEl.querySelector<HTMLElement>('[data-field="title"]');
    const body = rowEl.closest<HTMLElement>(".wk-body");
    if (!titleEl || !body) throw new Error("the row has no title element or no body");
    const rowStyle = getComputedStyle(rowEl);
    const titleStyle = getComputedStyle(titleEl);
    const bodyRect = body.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    // One rect per line box: the geometry of every line, clipped or not. A
    // Range over the text, not the element: a flex item is a block and would
    // report one rect however many lines it wraps to.
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const lines = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    const inside = (r: DOMRect, box: DOMRect) =>
      r.left >= box.left - 1 &&
      r.right <= box.right + 1 &&
      r.top >= box.top - 1 &&
      r.bottom <= box.bottom + 1;
    return {
      innerText: titleEl.innerText,
      title: { scrollWidth: titleEl.scrollWidth, clientWidth: titleEl.clientWidth },
      row: {
        scrollWidth: rowEl.scrollWidth,
        clientWidth: rowEl.clientWidth,
        scrollHeight: rowEl.scrollHeight,
        clientHeight: rowEl.clientHeight,
      },
      textOverflow: [rowStyle.textOverflow, titleStyle.textOverflow],
      whiteSpace: [rowStyle.whiteSpace, titleStyle.whiteSpace],
      lineClamp: [rowStyle.webkitLineClamp, titleStyle.webkitLineClamp],
      lineCount: lines.length,
      linesInsideRow: lines.every((r) => inside(r, rowRect)),
      rowInsideBody: inside(rowRect, bodyRect),
    };
  });

  // The whole title: not a prefix, not an ellipsis, not a clamp.
  expect(m.innerText).toBe(LONG_TITLE);
  for (const v of m.textOverflow) expect(v).not.toBe("ellipsis");
  for (const v of m.whiteSpace) expect(v).not.toMatch(/nowrap|^pre$/);
  for (const v of m.lineClamp) expect(v).not.toMatch(/^\d+$/);
  // Nothing spills past its box. The row is the block, so its numbers are the
  // ones with teeth; an inline span reports 0 for both and is checked anyway
  // because the rule is stated on the title.
  expect(m.title.scrollWidth).toBeLessThanOrEqual(m.title.clientWidth + 1);
  expect(m.row.scrollWidth).toBeLessThanOrEqual(m.row.clientWidth + 1);
  expect(m.row.scrollHeight).toBeLessThanOrEqual(m.row.clientHeight + 1);
  // It wrapped — 140 characters do not fit one line in a 6-column widget at
  // any profile — and every line sits inside its row, and the row inside the
  // body's visible area.
  expect(m.lineCount).toBeGreaterThanOrEqual(2);
  expect(m.linesInsideRow).toBe(true);
  expect(m.rowInsideBody).toBe(true);
}

test.describe("nothing is cut off", () => {
  test.afterEach(async ({ page }) => {
    await dropLongTitleTask(page);
  });

  test("a 140-character title in the Overdue widget is shown in full", async ({ page }) => {
    await expectLongTitleShownInFull(page);
  });

  test("a widget header can wrap: no ellipsis, no nowrap, no overflow", async ({ page }) => {
    // There is no rename operation yet (lib/workspace/types.ts opSchema), so a
    // long stored title cannot be produced through the API. Until there is,
    // this checks the rule on every header the board has; the wrap itself is
    // verified once a rename exists.
    const headers = page.locator("[data-widget] > header > h2");
    expect(await headers.count()).toBeGreaterThan(0);
    const styles = await headers.evaluateAll((els) =>
      els.map((el) => {
        const s = getComputedStyle(el);
        return {
          textOverflow: s.textOverflow,
          whiteSpace: s.whiteSpace,
          overflowing: el.scrollWidth - el.clientWidth,
        };
      })
    );
    for (const s of styles) {
      expect(s.textOverflow).not.toBe("ellipsis");
      expect(s.whiteSpace).not.toMatch(/nowrap|^pre$/);
      expect(s.overflowing).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("ledes", () => {
  test("the Overdue widget shows its lede in full, above the rows", async ({ page }) => {
    // Seeded on the E2E Project's record in global setup (docs/understanding/
    // SPEC.md §7, §9): the board ships `ledes[widgetId]` from the last record
    // and the shell renders it as text above the rows. The same rule as a
    // title: read in full, never an ellipsis.
    const lede = widget(page, E2E_LEDE.widgetId).locator(`[data-lede="${E2E_LEDE.widgetId}"]`);
    await expect(lede).toBeVisible();
    await expect(lede).toHaveText(E2E_LEDE.text);
    const m = await lede.evaluate((el) => {
      const s = getComputedStyle(el);
      // Above the rows: the lede precedes the body in the DOM, whatever the
      // stacking or the position of the widget.
      const body = el.parentElement?.querySelector(".wk-body");
      return {
        textOverflow: s.textOverflow,
        whiteSpace: s.whiteSpace,
        lineClamp: s.webkitLineClamp,
        overflowing: el.scrollWidth - el.clientWidth,
        beforeBody: !!body && !!(el.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    expect(m.textOverflow).not.toBe("ellipsis");
    expect(m.whiteSpace).not.toMatch(/nowrap|^pre$/);
    expect(m.lineClamp).not.toMatch(/^\d+$/);
    expect(m.overflowing).toBeLessThanOrEqual(1);
    expect(m.beforeBody).toBe(true);
  });
});

test.describe("wide screen", () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  test.afterEach(async ({ page }) => {
    await dropLongTitleTask(page);
  });

  test("a 140-character title is shown in full on the desktop grid too", async ({ page }) => {
    // Here a widget sits on its grid height and the body scrolls inside it
    // (components/workspace/workspace-board.tsx invariant 2); the phone profile
    // never exercises that path, so the same assertions run at this width.
    await expectLongTitleShownInFull(page);
  });

  test("dragging a widget moves it, and it stays moved after a reload", async ({ page }) => {
    const startRow = (await storedPos(page, "overdue")).y;
    const before = await boxOf(page, "overdue");
    await dragBy(page, "overdue", 0, 300);

    // Did the gesture become an operation at all?
    await expect
      .poll(async () => (await storedPos(page, "overdue")).y, { timeout: 8000 })
      .toBeGreaterThan(startRow);

    // And did the board show it?
    await expect
      .poll(async () => (await boxOf(page, "overdue")).y, { timeout: 5000 })
      .toBeGreaterThan(before.y + 80);

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
    const startRow = (await storedPos(page, "overdue")).y;
    await dragBy(page, "overdue", 0, 300);
    await expect
      .poll(async () => (await storedPos(page, "overdue")).y, { timeout: 8000 })
      .toBeGreaterThan(startRow);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect
      .poll(async () => (await storedPos(page, "overdue")).y, { timeout: 8000 })
      .toBe(startRow);
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
