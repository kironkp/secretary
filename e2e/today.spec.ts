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
/** The thinking strip above the card (components/today/thinking-strip.tsx) and its main line. */
const strip = (page: Page) => page.locator("[data-thinking-strip]");
const stripLine = (page: Page) => strip(page).locator("[data-line]");

/** What GET /api/understanding/progress says when nothing is under way and the model is fine. */
const PROVIDER_OK = {
  ok: true,
  line: null,
  action: null,
  anthropic: { state: "ok", until: null, connected: false },
  openai: { state: "ok", until: null, connected: false },
};
const FINISHED = new Date(Date.now() - 12 * 60_000).toISOString();
const PROGRESS_IDLE = {
  active: [],
  recent: [],
  lastRun: {
    projectName: "E2E Project",
    status: "ok",
    line: "Read E2E Project",
    detail: "nothing new to ask",
    finishedAt: FINISHED,
  },
  provider: PROVIDER_OK,
};

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

  test("the thinking strip sits above the hero and says where the reading stands", async ({ page }) => {
    // The user's words: "an interface above the questions that shows what
    // the agent is thinking". One quiet card, with a phase the tests and
    // the walk script can read, and its main line the one live region.
    await expect(strip(page)).toBeVisible();
    await expect(strip(page)).toHaveAttribute("data-phase", /^(idle|active|failed|paused)$/);
    await expect(stripLine(page)).toHaveAttribute("role", "status");
    await expect(stripLine(page)).toHaveAttribute("aria-live", "polite");
    const s = await strip(page).boundingBox();
    const h = await hero(page).boundingBox();
    expect(s).not.toBeNull();
    expect(h).not.toBeNull();
    expect(s!.y + s!.height).toBeLessThanOrEqual(h!.y);
    // Idle, it is a slim card: two lines, never a second hero. (Paused or
    // failed it carries the way out as a third line, so only idle is measured.)
    if ((await strip(page).getAttribute("data-phase")) === "idle") {
      expect(s!.height).toBeLessThanOrEqual(72);
    }
    // No text is cut off in it, whatever the line says.
    const text = (await stripLine(page).getAttribute("data-line")) ?? "";
    if (text) await expectShownInFull(page, "[data-thinking-strip] [data-line]", text);
  });

  test("the strip narrates the answer, then a reading that failed, with the way to fix it", async ({ page }) => {
    // The route is answered here (nothing reaches the database, and the
    // seeded question stays open for the tap test) and the progress
    // endpoint is scripted: idle before the tap, the project being read
    // after the reply, then a reading that failed for want of credits, the
    // outage this build has to make visible and self-serviceable.
    let answeredAt = 0;
    await page.route("**/api/understanding/progress", async (route) => {
      let body: unknown = PROGRESS_IDLE;
      if (answeredAt) {
        const since = Date.now() - answeredAt;
        body =
          since < 2_500
            ? {
                ...PROGRESS_IDLE,
                active: [
                  {
                    projectId: "e2e",
                    projectName: "E2E Project",
                    phase: "gathering",
                    line: "Reading E2E Project",
                    detail: "43 tasks, 12 messages, 3 memories",
                    startedAt: new Date(answeredAt).toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                ],
              }
            : {
                active: [],
                recent: [
                  {
                    projectId: "e2e",
                    projectName: "E2E Project",
                    status: "failed",
                    line: "Could not read E2E Project",
                    detail: "the model has no credits",
                    reason: "no-credits",
                    finishedAt: new Date(answeredAt + 2_500).toISOString(),
                  },
                ],
                lastRun: {
                  projectName: "E2E Project",
                  status: "failed",
                  line: "Could not read E2E Project",
                  detail: "the model has no credits",
                  finishedAt: new Date(answeredAt + 2_500).toISOString(),
                },
                provider: {
                  ok: false,
                  line: "Reading is paused: the model has no credits.",
                  action: "Add credits, raise the limit, or connect your own key in Settings.",
                  anthropic: { state: "no-credits", until: null, connected: false },
                  openai: { state: "no-credits", until: null, connected: false },
                },
              };
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.route(`**/api/questions/${E2E_QUESTION.id}/answer`, async (route) => {
      answeredAt = Date.now();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "resolved",
          projectId: null,
          applied: [{ op: "complete_task" }, { op: "resolve" }],
          failed: [],
        }),
      });
    });
    await page.goto("/today");

    // Idle: the last run, and how long ago, in the faint detail line.
    await expect(strip(page)).toHaveAttribute("data-phase", "idle");
    await expect(stripLine(page)).toHaveAttribute("data-line", "Read E2E Project");
    await expect(strip(page).locator("[data-detail]")).toHaveAttribute("data-detail", "nothing new to ask, 12 min ago");

    // The tap: acknowledged in the strip at once, then the receipt's words,
    // then what the server is doing, each for a beat.
    await hero(page).locator('[data-answer="close"]').click();
    await expect(stripLine(page)).toHaveAttribute("data-line", "Applying your answer");
    await expect(strip(page)).toHaveAttribute("data-phase", "active");
    await expect(stripLine(page)).toHaveAttribute("data-line", "Closed 1 task");
    await expect(page.locator("[data-receipt]")).toHaveText("Closed 1 task");
    await expect(stripLine(page)).toHaveAttribute("data-line", "Reading E2E Project");
    await expect(strip(page).locator("[data-detail]")).toHaveAttribute("data-detail", "43 tasks, 12 messages, 3 memories");
    // Never blocked: the pills are live under it.
    await expect(hero(page).locator("[data-answer]").first()).toBeEnabled();

    // The reading failed: the strip says so in the warn tone, why, and what
    // to do about it, as a link to the Model row in Settings.
    await expect(strip(page)).toHaveAttribute("data-phase", "failed");
    await expect(stripLine(page)).toHaveAttribute("data-line", "Could not read E2E Project");
    await expect(strip(page).locator("[data-detail]")).toHaveAttribute("data-detail", "the model has no credits");
    const fix = strip(page).locator("[data-action]");
    await expect(fix).toHaveText("Add credits, raise the limit, or connect your own key in Settings.");
    await expect(fix).toHaveAttribute("href", "/settings#understanding");
    expect((await fix.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expectShownInFull(page, "[data-thinking-strip] [data-line]", "Could not read E2E Project");
    // The bars are still: nothing is under way.
    expect(await strip(page).locator(".thinking-live").count()).toBe(0);
    // The answer never left the browser.
    expect(await questionStatus(page)).toMatch(/^(open|asked)$/);
  });

  test("with reduced motion the strip's bars and lines do not animate", async ({ page }) => {
    // Motion carries the meaning here, so the setting calms it rather than
    // hiding it: the words stay, the bars stand still, the line simply changes.
    await page.goto("/today?thinking=open");
    await expect(strip(page)).toHaveAttribute("data-phase", "active");
    const bar = strip(page).locator(".thinking-bar").first();
    expect(await bar.evaluate((el) => getComputedStyle(el).animationName)).toBe("thinking-bob");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/today?thinking=open");
    await expect(strip(page)).toHaveAttribute("data-phase", "active");
    await expect(stripLine(page)).toHaveAttribute("data-line", "Reading Caltrans");
    expect(await strip(page).locator(".thinking-bar").first().evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
    const running = await strip(page).evaluate((el) =>
      Array.from(el.querySelectorAll("*")).filter((n) => {
        const s = getComputedStyle(n);
        return s.animationName !== "none" && parseFloat(s.animationDuration) > 0.01;
      }).length
    );
    expect(running).toBe(0);
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

    // The pills are where the thumb is: right after the reasoning, above the
    // evidence, and inside the first screen without a scroll.
    const pill = await page.locator("[data-answer]").first().boundingBox();
    const evidence = await page.locator("[data-evidence-list]").boundingBox();
    expect(pill).not.toBeNull();
    expect(evidence).not.toBeNull();
    expect(pill!.y).toBeLessThan(evidence!.y);
    const viewport = page.viewportSize();
    expect(pill!.y + pill!.height).toBeLessThanOrEqual(viewport?.height ?? 659);

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

    // Escape is the keyboard's Cancel: back to the pills.
    await field.press("Escape");
    await expect(hero(page).locator("[data-answer]")).toHaveCount(2);
    await expect(field).toHaveCount(0);
    await write.click();
    await expect(field).toBeFocused();

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

  test("a pill is a button: focused, Enter answers it", async ({ page }) => {
    // The route is answered here, as above: CI has no model, and the one
    // seeded question must still be open for the tap test that follows. What
    // is real is the keyboard: focus lands on the pill, Enter presses it, the
    // pill lights, the receipt and the strip's line follow.
    let posted: unknown = null;
    await page.route(`**/api/questions/${E2E_QUESTION.id}/answer`, async (route) => {
      posted = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "resolved",
          projectId: null,
          applied: [{ op: "complete_task" }, { op: "resolve" }],
          failed: [],
        }),
      });
    });
    const close = hero(page).locator('[data-answer="close"]');
    await close.focus();
    await expect(close).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(close).toHaveAttribute("data-selected", "true");
    await expect(page.locator("[data-receipt]")).toHaveText("Closed 1 task");
    expect(posted).toEqual({ answerId: "close" });
    // The strip above is live with the receipt's words until the server
    // says what it is doing with the answer.
    await expect(strip(page)).toHaveAttribute("data-phase", "active");
    await expect(stripLine(page)).toHaveAttribute("data-line", "Closed 1 task");
    // The answer never left the browser.
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

    // The reply is held for a beat so "Applying your answer" is on screen
    // long enough to be read; the request still reaches the server and writes.
    await page.route(`**/api/questions/${E2E_QUESTION.id}/answer`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    // The clock for "acknowledged at once": the first press event to the
    // first paint of the strip's "Applying your answer", measured in the
    // page so the harness's own round trips do not count. __stay proves
    // the page was never navigated.
    await page.evaluate(() => {
      const w = window as unknown as {
        __stay: number;
        __tap: number | null;
        __ack: number | null;
        __ackText: string | null;
      };
      w.__stay = 1;
      w.__tap = null;
      w.__ack = null;
      w.__ackText = null;
      const first = () => {
        if (w.__tap === null) w.__tap = performance.now();
      };
      for (const type of ["pointerdown", "mousedown", "touchstart"]) {
        document.addEventListener(type, first, { capture: true, once: true });
      }
      new MutationObserver(() => {
        if (w.__ack !== null) return;
        const line = document.querySelector("[data-thinking-strip] [data-line]")?.getAttribute("data-line") ?? "";
        if (line.startsWith("Applying")) {
          w.__ack = performance.now();
          w.__ackText = line;
        }
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-line"] });
    });

    const close = hero(page).locator('[data-answer="close"]');
    await close.click();

    // Acknowledged at once: the pill lit and the strip saying "Applying your
    // answer", within 200 ms of the press, before the server has said anything.
    await expect(stripLine(page)).toHaveAttribute("data-line", "Applying your answer");
    await expect(strip(page)).toHaveAttribute("data-phase", "active");
    await expect(close).toHaveAttribute("data-selected", "true");
    const ack = await page.evaluate(() => {
      const w = window as unknown as { __tap: number | null; __ack: number | null; __ackText: string | null };
      return { ms: w.__tap !== null && w.__ack !== null ? w.__ack - w.__tap : null, text: w.__ackText };
    });
    expect(ack.text).toMatch(/^Applying/);
    expect(ack.ms).not.toBeNull();
    expect(ack.ms as number).toBeLessThan(200);

    // The write went through the task tool, so the task API says done.
    await expect.poll(() => taskStatus(page, openId), { timeout: 10_000 }).toBe("done");

    // The receipt says only what was applied (SPEC §10, the honesty rule):
    // under the card once the reply has landed, and on the strip for a beat.
    const receipt = page.locator("[data-receipt]");
    await expect(receipt).toHaveText("Closed 1 task");
    await expect(stripLine(page)).toHaveAttribute("data-line", "Closed 1 task");
    // The project is being re-read: the strip is live, whatever it says next.
    await expect(strip(page)).toHaveAttribute("data-phase", "active");

    // The question is resolved, so it is no longer the hero and not in the list.
    await expect(page.locator(`[data-question-id="${E2E_QUESTION.id}"]`)).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.locator(`[data-question-row="${E2E_QUESTION.id}"]`)).toHaveCount(0);

    // The card moved on in place: the slot holds the next question or the
    // empty state, never this one, and the page was not navigated or rebuilt.
    const slot = page.locator("[data-testid=today-hero], [data-testid=today-hero-empty]");
    await expect(slot).toHaveCount(1);
    await expect(slot).not.toHaveAttribute("data-question-id", E2E_QUESTION.id);
    expect(await page.evaluate(() => (window as unknown as { __stay: number }).__stay)).toBe(1);
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
