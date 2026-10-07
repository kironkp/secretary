// Dashboard › Timeline on a phone (SEC-A009): nothing drags there, so a tap
// is the only way in. A real touch tap opens the task, the dialog stays open
// (the compatibility click after a touch used to land on its backdrop and
// shut it ~9 ms later), and its date can be changed from the dialog.
import { test, expect, type Page } from "@playwright/test";

// The date field speaks the browser's wall clock: pin it, so the value typed
// is the instant stored.
test.use({ timezoneId: "UTC" });

const TITLE = `Timeline phone ${Date.now()}`;
const DAY = 86_400_000;
let taskId: string | null = null;

async function storedDue(page: Page): Promise<string> {
  const res = await page.request.get(`/api/tasks/${taskId}`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { task: { dueAt: string } }).task.dueAt;
}

test.beforeAll(async ({ request }) => {
  const d = new Date(Date.now() + 2 * DAY);
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

test("a tap opens the task, it stays open, and its date changes from the dialog", async ({ page }) => {
  await page.goto("/dashboard?view=timeline");
  const item = page.locator(`[data-item="${taskId}"]`);
  await item.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300); // past the 150 ms scroll-stop guard
  await item.tap();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(TITLE);
  await page.waitForTimeout(600);
  await expect(dialog).toBeVisible();

  const target = new Date(Date.now() + 9 * DAY);
  const day = target.toISOString().slice(0, 10);
  const due = dialog.getByLabel("Due date");
  await due.fill(`${day}T09:00`);
  await due.blur();
  await expect.poll(() => storedDue(page)).toBe(`${day}T09:00:00.000Z`);
});
