// Dashboard › Overview, "a clear Overview" (SEC-A007), on the iPad
// ([overview]) and the phone ([overview-phone]), always by touch:
// - no WHAT/WHEN/HEARD table and no 5-week chart; the progress strip instead,
//   and a tap on it opens the Timeline on that project;
// - project cards in a grid that uses the width (2 across on the iPad);
// - Needs a date: tap a task, tap Tomorrow, and it is dated with no dialog,
//   through the move route (update_task), never the raw task PATCH; Undo;
// - Board narrowed to one project by its chip, remembered after a reload.
import { test, expect, type Page, type Request } from "@playwright/test";
import { touch } from "./touch";

const STAMP = Date.now();
const UNDATED = `Overview undated ${STAMP}`;
const IN_PROJECT = `Overview E2E ${STAMP}`;
const LOOSE = `Overview loose ${STAMP}`;
const DAY = 86_400_000;
const ids: Record<string, string> = {};

async function create(page: Page | import("@playwright/test").APIRequestContext, args: Record<string, unknown>) {
  const res = await ("request" in page ? page.request : page).post("/api/secretary/tools", { data: { name: "create_task", args } });
  expect(res.ok()).toBeTruthy();
  const outcome = (await res.json()) as { result?: { task_id?: string; error?: string } };
  expect(outcome.result?.error, "create_task refused the task").toBeUndefined();
  return outcome.result!.task_id!;
}
async function storedDue(page: Page, id: string): Promise<string | null> {
  const res = await page.request.get(`/api/tasks/${id}`);
  return ((await res.json()) as { task: { dueAt: string | null } }).task.dueAt;
}

test.beforeAll(async ({ request }) => {
  ids.undated = await create(request, { title: UNDATED });
  ids.inProject = await create(request, { title: IN_PROJECT, project: "E2E Project", due_at: new Date(Date.now() + 3 * DAY).toISOString() });
  ids.loose = await create(request, { title: LOOSE, due_at: new Date(Date.now() + 4 * DAY).toISOString() });
});
test.afterAll(async ({ request }) => {
  for (const id of Object.values(ids)) await request.patch(`/api/tasks/${id}`, { data: { status: "dropped" } });
});

test("no table and no 5-week chart; the progress strip; the cards use the width", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByTestId("progress-strip")).toBeVisible();
  // The chart's legend and the table's headers are gone.
  await expect(page.getByText("imminent — under a week")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: /^(what|heard)$/i })).toHaveCount(0);
  // Each task once: the in-project task is on its card and nowhere else on Overview.
  await expect(page.getByText(IN_PROJECT, { exact: true })).toHaveCount(1);

  const grid = page.getByTestId("project-grid").first();
  const columns = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  const width = page.viewportSize()!.width;
  expect(columns).toBe(width >= 1280 ? 3 : width >= 768 ? 2 : 1);
});

test("Needs a date: tap the task, tap Tomorrow; dated through the move route with no dialog; Undo", async ({ page }) => {
  const writes: Request[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && /\/api\/(tasks|timeline)\//.test(r.url())) writes.push(r);
  });
  await page.goto("/dashboard");
  const chase = page.getByTestId("date-chase");
  await touch(page, chase.locator(`[data-chase="${ids.undated}"]`));
  const choices = chase.getByRole("group", { name: `A date for ${UNDATED}` });
  await expect(choices).toBeVisible();

  const moved = page.waitForRequest((r) => r.url().endsWith("/api/timeline/move") && r.method() === "POST");
  await touch(page, choices.getByRole("button", { name: "Tomorrow" }));
  expect((await moved).postDataJSON()).toMatchObject({ kind: "task", id: ids.undated });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(chase.getByRole("status")).toContainText("is due tomorrow");
  await expect.poll(() => storedDue(page, ids.undated)).not.toBeNull();
  const due = new Date((await storedDue(page, ids.undated))!).getTime();
  expect(due - Date.now()).toBeGreaterThan(0);
  expect(due - Date.now()).toBeLessThan(2 * DAY);
  // Never the raw task PATCH: the tool layer's rules apply to a tap too.
  expect(writes.filter((r) => r.url().includes(`/api/tasks/${ids.undated}`))).toEqual([]);

  await touch(page, chase.getByRole("button", { name: "Undo" }));
  await expect.poll(() => storedDue(page, ids.undated)).toBeNull();
});

test("Board: a project's chip shows only that project, and is remembered", async ({ page }) => {
  await page.goto("/dashboard?view=board");
  const chips = page.getByTestId("project-filter");
  await expect(page.getByText(LOOSE)).toBeVisible();
  await touch(page, chips.getByRole("button", { name: "E2E Project", exact: true }));
  await expect(page.getByText(IN_PROJECT)).toBeVisible();
  await expect(page.getByText(LOOSE)).toHaveCount(0);

  await page.reload();
  await expect(chips.getByRole("button", { name: "E2E Project", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(LOOSE)).toHaveCount(0);
  await touch(page, chips.getByRole("button", { name: "All", exact: true }));
  await expect(page.getByText(LOOSE)).toBeVisible();
});

test("the progress strip: a tap opens the Timeline on that project", async ({ page }) => {
  await page.goto("/dashboard");
  await touch(page, page.getByTestId("progress-strip").getByRole("button", { name: /E2E Project/ }));
  await expect(page).toHaveURL(/view=timeline/);
  await expect(page.getByTestId("timeline-board")).toBeVisible();
  // The Timeline's own filter chip names the project; the loose task's lane is not shown.
  await expect(page.getByRole("button", { name: /^E2E Project ✕$/ })).toBeVisible();
  await expect(page.locator(`[data-item="${ids.loose}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-item="${ids.inProject}"]`)).toHaveCount(1);
});
