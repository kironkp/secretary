// Today and an opened question, in a real browser, on a phone profile
// (docs/understanding/SPEC.md §9). What vitest cannot see: that the hero's
// text is on screen in full, that a tap on an answer reaches the API and
// closes a task, that a past-due title wraps rather than ending in an
// ellipsis, and that every answer is a target a thumb can hit.
//
// The tests are a sequence on one seeded question (e2e/global-setup.ts
// E2E_QUESTION): read it, open it, answer it, then read it again as answered.
// Order is the point: the ones that need the question open come first, and
// the config runs one worker with no retries, so a later test never sees an
// earlier one's state by accident. The question rests on its own task
// ("E2E question task"), which no other spec writes to: the Workspace spec
// closes a task through the API and runs before this file.
import { test, expect, type Page } from "@playwright/test";
import { E2E_QUESTION } from "./global-setup";

const hero = (page: Page) => page.getByTestId("today-hero");
const question = (page: Page) => page.getByTestId("question");

/** The task ids the question rests on, straight from the API: [open, finished]. */
async function evidenceTaskIds(page: Page): Promise<string[]> {
  const res = await page.request.get(`/api/questions/${E2E_QUESTION.id}`);
  expect(res.ok(), `GET /api/questions/${E2E_QUESTION.id} -> ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { evidence: { type: string; id: string }[] };
  return body.evidence.filter((e) => e.type === "task").map((e) => e.id);
}

async function questionStatus(page: Page): Promise<string> {
  const res = await page.request.get(`/api/questions/${E2E_QUESTION.id}`);
  expect(res.ok(), `GET /api/questions/${E2E_QUESTION.id} -> ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { status: string }).status;
}

async function taskStatus(page: Page, id: string): Promise<string> {
  const res = await page.request.get(`/api/tasks/${id}`);
  expect(res.ok(), `GET /api/tasks/${id} -> ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { task: { status: string } };
  return body.task.status;
}

/**
 * "Nothing is cut off" (SPEC §9), measured: the text is the whole string, no
 * ellipsis, no nowrap, no clamp, and the element does not spill past its box.
 */
async function expectShownInFull(page: Page, selector: string, text: string) {
  const el = page.locator(selector).filter({ hasText: text }).first();
  await expect(el).toBeVisible();
  await el.scrollIntoViewIfNeeded();
  const m = await el.evaluate((node) => {
    const s = getComputedStyle(node);
    return {
      innerText: (node as HTMLElement).innerText,
      textOverflow: s.textOverflow,
      whiteSpace: s.whiteSpace,
      lineClamp: s.webkitLineClamp,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    };
  });
  expect(m.innerText).toContain(text);
  expect(m.textOverflow).not.toBe("ellipsis");
  expect(m.whiteSpace).not.toMatch(/nowrap|^pre$/);
  expect(m.lineClamp).not.toMatch(/^\d+$/);
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth + 1);
}

/** Apple's minimum is 44pt; the Canvas shipped an 18px checkbox. */
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

test.describe("before answering", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/today");
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
  });

  test("the root of the app is Today", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/today$/);
  });

  test("the past-due list shows a full title with no ellipsis", async ({ page }) => {
    // Seeded two days past due. It is the user's own (source typed), so it
    // sits in the list proper rather than under the suggestions line.
    const row = page.locator("[data-past-due-row]").filter({ hasText: E2E_QUESTION.openTask });
    await expect(row).toBeVisible();
    await expectShownInFull(page, '[data-past-due-row] [data-field="title"]', E2E_QUESTION.openTask);
    // Days late, as digits (SPEC §7), not "a few days ago".
    await expect(row.locator('[data-field="late"]')).toHaveText(/^\d+ days? late$/);
    // The count excludes suggestions (SPEC §10); nothing suggested is seeded,
    // so it is simply the number of rows listed.
    const listed = await page.locator("[data-past-due-row]").count();
    expect(listed).toBeGreaterThan(0);
  });

  test("the hero shows the question in full with its kind label", async ({ page }) => {
    await expect(hero(page)).toHaveAttribute("data-question-id", E2E_QUESTION.id);
    await expect(hero(page).locator("[data-question-text]")).toHaveText(E2E_QUESTION.question);
    await expect(hero(page)).toContainText("Doesn't add up");
    await expect(hero(page)).toContainText(E2E_QUESTION.context);
    await expectShownInFull(page, "[data-question-text]", E2E_QUESTION.question);

    // Both answers, in the seeded order; the first is the filled one.
    const answers = hero(page).locator("[data-answer]");
    await expect(answers).toHaveCount(2);
    await expect(answers.nth(0)).toHaveText("Close it");
    await expect(answers.nth(1)).toHaveText("Keep it");
    await assertTapTargets(page, ["[data-testid=today-hero] [data-answer]", "[data-past-due-row]"]);
  });

  test("on a phone Today does not scroll sideways", async ({ page }) => {
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("the opened question shows its evidence and what each answer does", async ({ page }) => {
    await page.goto(`/today/${E2E_QUESTION.id}`);
    await expect(question(page)).toHaveAttribute("data-status", /^(open|asked)$/);
    await expect(question(page).locator("[data-question-text]")).toHaveText(E2E_QUESTION.question);
    await expect(question(page)).toContainText("Doesn't add up");

    // The evidence: the open copy and the finished copy, each by its real
    // title and with the label SPEC §9 names for its state.
    const rows = page.locator("[data-evidence]");
    await expect(rows).toHaveCount(2);
    const open = rows.filter({ hasText: E2E_QUESTION.openTask });
    await expect(open.locator("[data-evidence-label]")).toHaveText("Still open");
    const done = rows.filter({ hasText: E2E_QUESTION.finishedTask });
    await expect(done.locator("[data-evidence-label]")).toHaveText(/^Done\b/);
    await expectShownInFull(page, "[data-evidence-text]", E2E_QUESTION.openTask);

    // One line per answer saying what it will write (components/today/copy.ts).
    // The mockup's form: the label in bold, then what it does, no colon.
    await expect(page.locator('[data-answer-effect="close"]')).toHaveText("Close it marks 1 task done");
    await expect(page.locator('[data-answer-effect="keep"]')).toHaveText("Keep it leaves everything as it is");

    await assertTapTargets(page, ["[data-answer]"]);
    // The way back is a real target too. Not getByRole("link", "Today"): the
    // nav tab of the same name comes first in the document.
    const back = page.locator("[data-back]");
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", "/today");
    expect((await back.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test("Write your own opens a field, and Send posts the words", async ({ page }) => {
    // The user's words (2026-09-22): "if there's a yes, no, or multiple
    // choice, there's always an extra option with write your own". The last
    // pill, grey like the way out, and a target a thumb can hit.
    const write = hero(page).locator("[data-write-own]");
    await expect(write).toHaveText("Write your own");
    await assertTapTargets(page, ["[data-testid=today-hero] [data-write-own]"]);

    // The tap swaps the pills for the field, already focused, with a way back.
    await write.click();
    const field = hero(page).locator("[data-own-field]");
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("placeholder", "Your answer");
    await expect(hero(page).locator("[data-answer]")).toHaveCount(0);
    await assertTapTargets(page, ["[data-own-field]", "[data-own-send]", "[data-own-cancel]"]);

    // Cancel brings the pills back, untouched.
    await hero(page).locator("[data-own-cancel]").click();
    await expect(hero(page).locator("[data-answer]")).toHaveCount(2);
    await expect(field).toHaveCount(0);
    await write.click();

    // CI has no model to read the words, so the route is answered here with
    // the body the server sends for a written answer (lib/understanding/
    // answer.ts answerInOwnWords). Nothing reaches the database, and the
    // question stays open for the tests that follow.
    const words = "They are one job; the finished copy is the real one.";
    let posted: unknown = null;
    await page.route(`**/api/questions/${E2E_QUESTION.id}/answer`, async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "resolved",
          projectId: null,
          applied: [{ op: "remember_fact" }],
          failed: [],
          reply: "Noted.",
        }),
      });
    });
    await field.fill(words);
    await hero(page).locator("[data-own-send]").click();

    // The receipt is the server's reply, said back; the field has closed.
    await expect(page.getByText("Got it. Noted.")).toBeVisible();
    expect(posted).toEqual({ text: words, source: "today" });
    await expect(field).toHaveCount(0);
    expect(await questionStatus(page)).toMatch(/^(open|asked)$/);
  });
});

test.describe("answering", () => {
  test("tapping Close it marks the question's task done and the hero moves on", async ({ page }) => {
    const [openId] = await evidenceTaskIds(page);
    expect(openId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await taskStatus(page, openId)).not.toBe("done");

    await page.goto("/today");
    await expect(hero(page)).toHaveAttribute("data-question-id", E2E_QUESTION.id);
    await hero(page).locator('[data-answer="close"]').click();

    // The write went through the task tool, so the task API says done.
    await expect.poll(() => taskStatus(page, openId), { timeout: 10_000 }).toBe("done");

    // The receipt says only what was applied (SPEC §10, the honesty rule).
    await expect(page.getByText("Closed 1 task")).toBeVisible();

    // The question is resolved, so it is no longer the hero and not in the list.
    await expect(page.locator(`[data-question-id="${E2E_QUESTION.id}"]`)).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.locator(`[data-question-row="${E2E_QUESTION.id}"]`)).toHaveCount(0);
  });

  test("a resolved question still opens, and says it was answered", async ({ page }) => {
    // Decision, documented in app/(app)/today/[id]/page.tsx: a resolved
    // question renders marked as resolved rather than 404ing, because the row
    // the user tapped may have been answered by voice a moment earlier.
    await page.goto(`/today/${E2E_QUESTION.id}`);
    await expect(question(page)).toHaveAttribute("data-status", "resolved");
    await expect(page.locator("[data-closed]")).toHaveText("You answered this one already.");
    // No answer to give twice.
    await expect(page.locator("[data-answer]")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to Today" })).toBeVisible();
  });

  test("answering again through the API is refused", async ({ page }) => {
    const res = await page.request.post(`/api/questions/${E2E_QUESTION.id}/answer`, {
      data: { answerId: "keep" },
    });
    expect(res.status()).toBe(409);
  });

  test("a question that is not there is a 404", async ({ page }) => {
    const res = await page.request.get("/api/questions/not-a-question");
    expect(res.status()).toBe(404);
    const html = await page.goto("/today/not-a-question");
    expect(html?.status()).toBe(404);
  });
});
