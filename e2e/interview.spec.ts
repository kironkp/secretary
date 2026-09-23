// The Interview, in a real browser, on a phone profile. What vitest cannot
// see: that the question is on screen in full, that the evidence opens on a
// tap, that "Skip for now" moves on without a write, that the tab is where a
// thumb expects it and lit on this page.
//
// This project runs BEFORE the Today specs (playwright.config.ts): it needs
// the seeded question (e2e/global-setup.ts E2E_QUESTION) still open, and it
// never answers it. Answering is Today's test, and two specs answering one
// row would race. Nothing here changes state.
import { test, expect, type Page } from "@playwright/test";
import { E2E_QUESTION } from "./global-setup";

const card = (page: Page) => page.getByTestId("interview");
const tabs = (page: Page) => page.locator('nav[aria-label="Sections"] a');

async function questionStatus(page: Page): Promise<string> {
  const res = await page.request.get(`/api/questions/${E2E_QUESTION.id}`);
  expect(res.ok(), `GET /api/questions/${E2E_QUESTION.id} -> ${res.status()}`).toBeTruthy();
  return ((await res.json()) as { status: string }).status;
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

test.describe("the Interview", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/interview");
    await expect(page.getByRole("heading", { name: "Interview", level: 1 })).toBeVisible();
  });

  test("shows Question 1 of N, the project, and the seeded question in full", async ({ page }) => {
    // The seeded user has one open question, so the count is one of one; a
    // stricter number than that would be a claim about other specs' seeds.
    await expect(page.locator("[data-count-line]")).toHaveText(/^Question 1 of \d+ · E2E Project$/);
    await expect(page.locator("[data-interview-line]")).toHaveText(
      "I ask, you answer, and your data gets sorted."
    );
    await expect(card(page)).toHaveAttribute("data-question-id", E2E_QUESTION.id);
    await expect(card(page)).toContainText("Doesn't add up");
    await expect(card(page).locator("[data-question-text]")).toHaveText(E2E_QUESTION.question);
    await expect(card(page)).toContainText(E2E_QUESTION.context);
    await expectShownInFull(page, "[data-question-text]", E2E_QUESTION.question);

    // Both answers, in the seeded order; the first is the filled one.
    const answers = card(page).locator("[data-answer]");
    await expect(answers).toHaveCount(2);
    await expect(answers.nth(0)).toHaveText("Close it");
    await expect(answers.nth(1)).toHaveText("Keep it");

    // The note is there to type into, and the evidence is closed until asked for.
    await expect(page.getByPlaceholder("Add a note, if you want")).toBeVisible();
    await expect(page.locator("[data-evidence-toggle]")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("[data-evidence]")).toHaveCount(0);

    await assertTapTargets(page, [
      "[data-testid=interview] [data-answer]",
      "[data-evidence-toggle]",
      "[data-skip]",
    ]);

    // The pills are where the thumb is: before the evidence disclosure, so
    // opening the evidence never pushes them down.
    const pill = await card(page).locator("[data-answer]").first().boundingBox();
    const toggle = await page.locator("[data-evidence-toggle]").boundingBox();
    expect(pill).not.toBeNull();
    expect(toggle).not.toBeNull();
    expect(pill!.y).toBeLessThan(toggle!.y);

    // The line at the bottom: a count, and when the projects were last read.
    await expect(page.locator("[data-interview-footer]")).toHaveText(
      /^\d+ answered today · last read .+$/
    );
  });

  test("the evidence opens on a tap and shows both tasks by their real titles", async ({ page }) => {
    await page.locator("[data-evidence-toggle]").click();
    await expect(page.locator("[data-evidence-toggle]")).toHaveAttribute("aria-expanded", "true");
    const rows = page.locator("[data-evidence]");
    await expect(rows).toHaveCount(2);
    const open = rows.filter({ hasText: E2E_QUESTION.openTask });
    await expect(open.locator("[data-evidence-label]")).toHaveText("Still open");
    const done = rows.filter({ hasText: E2E_QUESTION.finishedTask });
    await expect(done.locator("[data-evidence-label]")).toHaveText(/^Done\b/);
    await expectShownInFull(page, "[data-evidence-text]", E2E_QUESTION.openTask);
  });

  test("Skip for now moves on without writing anything", async ({ page }) => {
    const before = await questionStatus(page);
    expect(before).toMatch(/^(open|asked)$/);

    await page.locator("[data-skip]").click();

    // With more than one question waiting the next one is on screen; with
    // one, it is the same question again, at the back of a queue of one. In
    // either case the screen still shows a question or says there is none,
    // and nothing was written about the skipped question: it is exactly as
    // open as it was (the one brought forward is marked surfaced, which is
    // not a status change).
    const shown = page.locator("[data-testid=interview], [data-testid=interview-empty]");
    await expect(shown).toHaveCount(1);
    await expect(page.locator("[data-count-line]")).toHaveText(/^(Question 1 of \d+.*|Nothing waiting)$/);
    expect(await questionStatus(page)).toBe(before);
  });

  test("Write your own asks for the words in the note field, and Enter sends them", async ({ page }) => {
    // The user's words (2026-09-22): "if there's a yes, no, or multiple
    // choice, there's always an extra option with write your own". The last
    // pill, grey like the way out, and a target a thumb can hit.
    const write = card(page).locator("[data-write-own]");
    await expect(write).toHaveText("Write your own");
    await assertTapTargets(page, ["[data-testid=interview] [data-write-own]"]);

    // The card already has the note field, so there is no second field:
    // with nothing typed, the tap asks for the words there.
    const note = page.locator("#interview-note");
    await write.click();
    await expect(note).toBeFocused();
    await expect(note).toHaveAttribute("placeholder", "Your answer");
    await expect(card(page).locator("[data-answer]")).toHaveCount(2);

    // CI has no model to read the words, so the route is answered here with
    // the body the server sends for a written answer (lib/understanding/
    // answer.ts answerInOwnWords). Nothing reaches the database.
    const words = "They are one job.";
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
    await note.fill(words);
    await note.press("Enter");

    // The receipt is the server's reply, said back, on the status line under
    // the card, with the thinking bars under it while the project is re-read.
    // The question is exactly as open as it was: the answer never left the
    // browser, so the queue still leads with it and the card stays.
    await expect(page.getByText("Got it. Noted.")).toBeVisible();
    await expect(page.locator("[data-receipt]")).toHaveText("Got it. Noted.");
    await expect(page.locator("[data-thinking]")).toBeVisible();
    await expect(page.locator("[data-thinking]")).toContainText("Reading E2E Project…");
    expect(posted).toEqual({ text: words, source: "interview" });
    expect(await questionStatus(page)).toMatch(/^(open|asked)$/);
    await expect(card(page)).toHaveAttribute("data-question-id", E2E_QUESTION.id);
  });

  test("the API lists the queue with the seeded question", async ({ page }) => {
    const res = await page.request.get("/api/interview");
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      queue: { id: string; question: string; evidenceView: unknown[] }[];
      total: number;
      answeredToday: number;
      lastRunAt: string | null;
    };
    expect(body.total).toBe(body.queue.length);
    const seeded = body.queue.find((q) => q.id === E2E_QUESTION.id);
    expect(seeded?.question).toBe(E2E_QUESTION.question);
    expect(seeded?.evidenceView).toHaveLength(2);
    expect(typeof body.answeredToday).toBe("number");
    expect(body.lastRunAt === null || typeof body.lastRunAt === "string").toBeTruthy();
  });

  test("the tab bar has Interview second, lit here and not on Today", async ({ page }) => {
    const interview = tabs(page).nth(1);
    await expect(interview).toHaveText("Interview");
    await expect(interview).toHaveAttribute("href", "/interview");
    await expect(interview).toHaveAttribute("aria-current", "page");
    await expect(tabs(page).nth(0)).not.toHaveAttribute("aria-current", "page");

    await page.goto("/today");
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible();
    await expect(tabs(page).nth(1)).not.toHaveAttribute("aria-current", "page");
    await expect(tabs(page).nth(0)).toHaveAttribute("aria-current", "page");
  });

  test("on a phone the Interview does not scroll sideways", async ({ page }) => {
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return el.scrollWidth - el.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
