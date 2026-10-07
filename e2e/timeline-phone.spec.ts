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

/**
 * A real touch on the item's centre, once nothing is scrolling. Taps within
 * 150 ms of a scroll are scroll-stops, not requests (isMomentumTap in
 * components/dashboard/shared.tsx), and locator.tap() scrolls the item into
 * view itself just before touching, so it is swallowed. touchscreen.tap()
 * never scrolls; the item is centred first, clear of the fixed tab bar.
 */
async function touchItem(page: Page, item: ReturnType<Page["locator"]>) {
  // Centred: at the edge of the scroll area the fixed tab bar covers it.
  await item.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let quiet = setTimeout(done, 300);
        function bump() {
          clearTimeout(quiet);
          quiet = setTimeout(done, 300);
        }
        function done() {
          window.removeEventListener("scroll", bump, true);
          resolve();
        }
        window.addEventListener("scroll", bump, true);
      })
  );
  const box = await item.boundingBox();
  if (!box) throw new Error("the item is not on the board");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
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
  await page.getByTestId("timeline-board").waitFor();
  await touchItem(page, page.locator(`[data-item="${taskId}"]`));

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(TITLE);
  await page.waitForTimeout(600);
  await expect(dialog).toBeVisible();

  const target = new Date(Date.now() + 9 * DAY);
  const day = target.toISOString().slice(0, 10);
  const due = dialog.getByLabel("Due date", { exact: true });
  await due.fill(`${day}T09:00`);
  await due.blur();
  await expect.poll(() => storedDue(page)).toBe(`${day}T09:00:00.000Z`);
});
