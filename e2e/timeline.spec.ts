// Dashboard › Timeline (SEC-A009), on an iPad in landscape: Kiron's device.
// A drag of a task's date moves it on the server by whole days (the same
// update_task a spoken move uses), and Undo puts it back. The stored date is
// read from the API first, so a failure says whether the gesture produced no
// move or the board did not redraw.
import { test, expect, type Page } from "@playwright/test";

const TITLE = `Timeline drag ${Date.now()}`;
const DAY = 86_400_000;
let taskId: string | null = null;
let dueAt = "";

async function storedDue(page: Page): Promise<string> {
  const res = await page.request.get(`/api/tasks/${taskId}`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { task: { dueAt: string } }).task.dueAt;
}

test.beforeAll(async ({ request }) => {
  // Five days out at noon UTC: clear of today's line and of any DST edge by a margin.
  const d = new Date(Date.now() + 5 * DAY);
  d.setUTCHours(12, 0, 0, 0);
  const created = await request.post("/api/secretary/tools", {
    data: { name: "create_task", args: { title: TITLE, due_at: d.toISOString() } },
  });
  expect(created.ok()).toBeTruthy();
  const outcome = (await created.json()) as { result?: { task_id?: string; error?: string } };
  expect(outcome.result?.error, "create_task refused the task").toBeUndefined();
  taskId = outcome.result?.task_id ?? null;
});

test.afterAll(async ({ request }) => {
  if (taskId) await request.patch(`/api/tasks/${taskId}`, { data: { status: "dropped" } });
});

test("dragging a date two days right moves it two days, and Undo puts it back", async ({ page }) => {
  dueAt = await storedDue(page);
  await page.goto("/dashboard?view=timeline");
  await expect(page.getByTestId("timeline-board")).toBeVisible();
  await expect(page.getByTestId("progress-strip")).toBeVisible();

  const item = page.locator(`[data-item="${taskId}"]`);
  await item.scrollIntoViewIfNeeded();
  const box = await item.boundingBox();
  if (!box) throw new Error("the task is not on the board");
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Month is the default zoom: 30 px a day.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (62 * i) / 8, from.y);
  await page.mouse.up();

  await expect(page.getByRole("status")).toContainText(`Moved "${TITLE}"`);
  await expect.poll(async () => new Date(await storedDue(page)).getTime() - new Date(dueAt).getTime()).toBe(2 * DAY);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => storedDue(page)).toBe(dueAt);
});

test("a tap opens the task instead of moving it", async ({ page }) => {
  await page.goto("/dashboard?view=timeline");
  const item = page.locator(`[data-item="${taskId}"]`);
  await item.scrollIntoViewIfNeeded();
  await item.click();
  await expect(page.getByRole("dialog")).toContainText(TITLE);
  expect(await storedDue(page)).toBe(dueAt);
});
