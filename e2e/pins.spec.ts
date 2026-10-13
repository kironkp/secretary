// Dashboard › Overview with something he placed on it (v1.02, SPEC §2
// "Composition"): a section the user moves is pinned at its place and every
// later render is put together around it. None of the other specs has a pin.
//
// A list is sent to the top through the real tool (arrange_dashboard, the one
// voice and chat use); on the page it is the first section, next up is
// directly under it, the line above the board says the board is arranged by
// him, and all of that is still so after a reload. Then "Put it back" is
// tapped, and the list is no longer on top.
//
// And the pin button (v1.02 r5): a section pinned where it stands is his
// (the line says so, the board does not move); unpinned, the page shows the
// board the request was answered with, without a reload.
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const STAMP = Date.now();
const LIST = `E2E pins ${STAMP}`;
let listId = "";

async function tool(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const res = await request.post("/api/secretary/tools", { data: { name, args } });
  expect(res.ok(), `${name} did not answer`).toBeTruthy();
  return ((await res.json()) as { result?: Record<string, unknown> }).result ?? {};
}
/** The board's sections as the page draws them, top to bottom. */
const board = (page: Page) =>
  page.locator("section[data-section]").evaluateAll((els) => els.map((el) => el.getAttribute("data-section") ?? ""));

test.beforeAll(async ({ request }) => {
  const made = await tool(request, "add_to_list", { list: LIST, items: ["string", "tape"] });
  expect(made.error, "add_to_list refused").toBeUndefined();
  const plan = await tool(request, "get_current_plan", {});
  const res = await request.get("/api/projects");
  const all = ((await res.json()) as { projects: { id: string; name: string }[] }).projects;
  listId = all.find((p) => p.name.toLowerCase() === String(made.list ?? LIST).toLowerCase())?.id ?? "";
  expect(listId, "the list just made is not among the projects").not.toBe("");
  expect((plan.sections as { key: string }[]).map((s) => s.key)).toContain(`project_card:${listId}`);
});
test.afterAll(async ({ request }) => {
  // The list leaves the board, and its pin with it.
  if (listId) await request.delete(`/api/projects/${listId}`);
});

test("a list sent to the top by the real tool is on top, next up is right under it, and it stays after a reload", async ({ page, request }) => {
  await page.goto("/dashboard");
  const before = await board(page);
  const card = `project_card:${listId}`;
  expect(before).toContain(card);
  expect(before[0]).not.toBe(card);

  const moved = await tool(request, "arrange_dashboard", { operations: [{ op: "move_to_top", section: `${LIST} list` }] });
  expect(moved.error, String(moved.error)).toBeUndefined();
  expect(moved.applied).toBe(true);

  for (const visit of ["first open", "after a reload"]) {
    if (visit === "first open") await page.goto("/dashboard");
    else await page.reload();
    await expect(page.locator("section[data-section]").first(), visit).toHaveAttribute("data-section", card);
    const now = await board(page);
    // His list, then everything else exactly as it was, next up first.
    expect(now.slice(0, 2), visit).toEqual([card, "hero_next_up"]);
    expect(now.slice(1), visit).toEqual(before.filter((key) => key !== card));
    // (The tool tidies a list's name: "E2e pins …".)
    await expect(page.locator("section[data-section]").first(), visit).toContainText(new RegExp(LIST, "i"));
    await expect(page.getByText("Arranged by you"), visit).toBeVisible();
    // The list is above next up and the strip on the screen, not only in the markup.
    const top = await page.locator(`section[data-section="${card}"]`).boundingBox();
    const hero = await page.locator('section[data-section="hero_next_up"]').boundingBox();
    const strip = await page.getByTestId("progress-strip").first().boundingBox();
    expect(top, visit).not.toBeNull();
    if (hero) expect(top!.y, visit).toBeLessThanOrEqual(hero.y);
    expect(top!.y + top!.height, visit).toBeLessThanOrEqual(strip!.y);
  }

  // "Put it back" undoes the move and lets the list go: it is back among the cards.
  await page.getByRole("button", { name: "Put it back" }).tap();
  await expect(page.locator("section[data-section]").first()).toHaveAttribute("data-section", "hero_next_up");
  expect(await board(page)).toEqual(before);
  await page.reload();
  expect(await board(page)).toEqual(before);
});

test("the pin button: pinned where it stands the board does not move; unpinned, it is back as it was, and the page shows it without a reload", async ({ page }) => {
  await page.goto("/dashboard");
  const before = await board(page);
  const card = `project_card:${listId}`;
  const section = () => page.locator(`section[data-section="${card}"]`);
  await expect(section()).toBeVisible();
  // The button shows on hover only, in the page's left margin (letting go
  // from a phone is a later task), so it is pressed through its click
  // handler: the page's own code from there on (the request, the board
  // that comes back).
  const press = async (label: string) => {
    // The page marks the pin at once and asks the server; the answer is waited for, so a reload does not cut the request off.
    const answered = page.waitForResponse((res) => res.url().includes("/api/layout") && res.request().method() === "POST");
    await section().locator(`button[aria-label="${label}"]`).dispatchEvent("click");
    const res = await answered;
    expect(res.ok(), `${label}: ${res.status()} ${await res.text()}`).toBeTruthy();
  };
  await press("Pin this section here");
  await expect(section().locator('button[aria-label="Unpin"]')).toBeAttached();
  await expect(page.getByText("Arranged by you")).toBeVisible();
  expect(await board(page)).toEqual(before);
  // It is stored: a reload has the same board, and the list is still his.
  await page.reload();
  await expect(section().locator('button[aria-label="Unpin"]')).toBeAttached();
  await expect(page.getByText("Arranged by you")).toBeVisible();
  expect(await board(page)).toEqual(before);

  // Let go, a list goes back where the data has it, which is where it stood.
  await press("Unpin");
  await expect(section().locator('button[aria-label="Pin this section here"]')).toBeAttached();
  expect(await board(page)).toEqual(before);
  await page.reload();
  await expect(section().locator('button[aria-label="Pin this section here"]')).toBeAttached();
  expect(await board(page)).toEqual(before);
});
