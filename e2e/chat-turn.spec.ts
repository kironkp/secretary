// v1.09 (docs/chat/SPEC.md §3), in a real browser on the phone profile: an
// answer cut off is not "Not delivered". The page asks again for the same
// turn, marked resume, and shows the saved answer; only his tap asks without
// the mark. The network is page.route, so no model is reached. What vitest
// cannot see: the page's own fetch, what it sends, and the answer drawn in the
// thread.
import { mkdirSync } from "node:fs";
import { test, expect, type Route } from "@playwright/test";

type Ask = { turnId?: string; resume?: boolean; accept: string | null };
const ndjson = (lines: Record<string, unknown>[]) => ({
  status: 200,
  headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  body: lines.map((l) => JSON.stringify(l) + "\n").join(""),
});
const accepted = (turnId?: string) => ({ type: "accepted", turnId, conversationId: "e2e-conv", userMessageId: "e2e-his" });
const done = (content: string) => ({
  type: "done",
  conversationId: "e2e-conv",
  userMessageId: "e2e-his",
  assistantMessage: { id: "e2e-reply", role: "assistant", content, createdAt: new Date().toISOString() },
  toasts: [],
  uiActions: [],
});
/** Each ask the page makes to /api/chat, answered by the next of these. */
async function network(page: import("@playwright/test").Page, answers: ((route: Route, ask: Ask) => Promise<void>)[]) {
  const asks: Ask[] = [];
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON() as { turnId?: string; resume?: boolean };
    const ask = { turnId: body.turnId, resume: body.resume, accept: route.request().headers()["accept"] ?? null };
    asks.push(ask);
    const next = answers.shift();
    if (!next) return route.abort();
    await next(route, ask);
  });
  return asks;
}
/** Opens the chat from its launcher (it starts closed) and sends a message. */
async function say(page: import("@playwright/test").Page, text: string) {
  await page.goto("/today");
  await page.getByTestId("chat-launcher").click();
  const field = page.getByRole("textbox", { name: "Ask your secretary" });
  await field.fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
}

test("an answer cut off after its first pieces comes back by a resume, and the page shows it", async ({ page }) => {
  const asks = await network(page, [
    // The stream stops before its last line: what a dropped connection looks like.
    (route, ask) => route.fulfill(ndjson([accepted(ask.turnId), { type: "text", round: 0, text: "E2E: half an" }])),
    (route, ask) => route.fulfill(ndjson([accepted(ask.turnId), done("E2E: the saved answer.")])),
  ]);
  await say(page, "E2E: plan my week");
  await expect(page.getByText("E2E: the saved answer.")).toBeVisible();
  await expect(page.getByText(/Not delivered/)).toHaveCount(0);
  expect(asks.length).toBe(2);
  expect(asks[0]).toMatchObject({ accept: "application/x-ndjson" });
  expect(asks[0].resume).toBeUndefined();
  expect(asks[0].turnId).toMatch(/^[0-9a-f]{32}$/);
  expect(asks[1]).toMatchObject({ turnId: asks[0].turnId, resume: true });
});

test("the router's own 503 page is a drop: the resume brings the answer", async ({ page }) => {
  const asks = await network(page, [
    (route) => route.fulfill({ status: 503, contentType: "text/html", body: "<html><body>Application error</body></html>" }),
    (route, ask) => route.fulfill(ndjson([accepted(ask.turnId), done("E2E: after the router's page.")])),
  ]);
  await say(page, "E2E: what is open?");
  await expect(page.getByText("E2E: after the router's page.")).toBeVisible();
  expect(asks.map((a) => a.resume ?? false)).toEqual([false, true]);
});

test("a resume that brings back Not delivered stops there; his tap asks again for the same turn, without the mark", async ({ page }) => {
  const asks = await network(page, [
    (route) => route.abort("connectionreset"),
    (route) => route.fulfill(ndjson([{ type: "error", error: "Not delivered" }])),
    (route, ask) => route.fulfill(ndjson([accepted(ask.turnId), done("E2E: answered on the tap.")])),
  ]);
  await say(page, "E2E: remind me tomorrow");
  const retry = page.getByRole("button", { name: /Not delivered — tap to retry/ });
  await expect(retry).toBeVisible();
  // A 44 px tall target: with v1.09 it is the only way he runs a turn again.
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(asks.length).toBe(2);
  await retry.click();
  await expect(page.getByText("E2E: answered on the tap.")).toBeVisible();
  await expect(retry).toHaveCount(0);
  expect(asks.map((a) => [a.turnId === asks[0].turnId, a.resume ?? false])).toEqual([[true, false], [true, true], [true, false]]);
});

// v1.09 r2: the thread follows the answer as it is written. A stand-in for fetch streams each answer piece by
// piece, as the route does; every animation frame while it streams is measured at 390 wide: the bottom of the
// line being written stands above the composer, and the answer's top does not move when it lands.
test.describe("the thread follows the answer as it is written", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  const LONG = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of the plan says what to do next and why it matters this week. `);
  const SHORT = ["E2E: three short lines. ", "The shed roof first. ", "Then the tax papers."];

  type Answer = { pieces: string[]; delayMs: number };
  async function streamAnswers(page: import("@playwright/test").Page, answers: Answer[]) {
    await page.addInitScript((script: Answer[]) => {
      let n = 0;
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!/\/api\/chat$/.test(url) || init?.method !== "POST") return real(input, init);
        const body = JSON.parse(String(init.body ?? "{}")) as { turnId?: string };
        const a = script.shift() ?? { pieces: ["Noted."], delayMs: 0 };
        n++;
        const enc = new TextEncoder();
        const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(line({ type: "accepted", turnId: body.turnId, conversationId: "e2e-conv", userMessageId: `e2e-his-${n}` }));
            for (const text of a.pieces) {
              await wait(a.delayMs);
              c.enqueue(line({ type: "text", round: 0, text }));
            }
            await wait(a.delayMs);
            c.enqueue(line({ type: "done", conversationId: "e2e-conv", userMessageId: `e2e-his-${n}`, assistantMessage: { id: `e2e-reply-${n}`, role: "assistant", content: a.pieces.join(""), createdAt: new Date().toISOString() }, toasts: [], uiActions: [] }));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
      };
    }, answers);
  }
  /** Measures every animation frame while an answer is being written. */
  const watch = (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __frames: { top: number; bottom: number; composerTop: number }[]; __stop: boolean };
      w.__frames = [];
      w.__stop = false;
      const tick = () => {
        const live = document.querySelector("[data-live-answer]");
        const composer = document.querySelector("[data-composer]");
        if (live && composer) {
          const r = live.getBoundingClientRect();
          w.__frames.push({ top: r.top, bottom: r.bottom, composerTop: composer.getBoundingClientRect().top });
        }
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const frames = (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __frames: { top: number; bottom: number; composerTop: number }[]; __stop: boolean };
      w.__stop = true;
      return w.__frames;
    });
  const topOf = (page: import("@playwright/test").Page, id: string) => page.evaluate((id) => document.getElementById(id)!.getBoundingClientRect().top, `m-${id}`);
  async function open(page: import("@playwright/test").Page) {
    await page.goto("/today");
    await page.getByTestId("chat-launcher").click();
  }
  async function send(page: import("@playwright/test").Page, text: string) {
    await page.getByRole("textbox", { name: "Ask your secretary" }).fill(text);
    await page.getByRole("button", { name: "Send message" }).click();
  }

  test("a long answer: in every frame its last line is above the composer, and its top does not move when it lands", async ({ page }) => {
    await streamAnswers(page, [{ pieces: LONG, delayMs: 120 }]);
    await open(page);
    await watch(page);
    await send(page, "E2E: a long plan please");
    await expect(page.locator("[data-live-answer]")).toBeVisible();
    await expect(page.locator("[data-live-answer]")).toHaveCount(0, { timeout: 15_000 });
    const seen = await frames(page);
    expect(seen.length).toBeGreaterThan(10);
    const under = seen.filter((f) => f.bottom > f.composerTop + 1);
    expect(under, `${under.length} of ${seen.length} frames had the line being written under the composer`).toEqual([]);
    const landedAt = await topOf(page, "e2e-reply-1");
    expect(Math.abs(landedAt - seen.at(-1)!.top)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(600);
    expect(Math.abs((await topOf(page, "e2e-reply-1")) - landedAt)).toBeLessThanOrEqual(1);
    mkdirSync("screenshots", { recursive: true });
    await page.screenshot({ path: "screenshots/chat-long-landed.png" });
  });

  test("scrolled up while it is written, he is left there", async ({ page }) => {
    await streamAnswers(page, [{ pieces: LONG, delayMs: 150 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await expect(page.locator("[data-live-answer]")).toBeVisible();
    await page.waitForTimeout(900);
    const at = await page.evaluate(() => {
      const el = document.querySelector("[data-thread-scroll]") as HTMLElement;
      el.scrollTop = Math.max(0, el.scrollTop - 200);
      return el.scrollTop;
    });
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => (document.querySelector("[data-thread-scroll]") as HTMLElement).scrollTop);
    expect(Math.abs(after - at)).toBeLessThanOrEqual(2);
  });

  test("a three-line answer in a thread that scrolls: followed, and it lands where it was written", async ({ page }) => {
    const earlier: Answer[] = Array.from({ length: 6 }, (_, i) => ({ pieces: [`E2E: an earlier answer ${i + 1}, `, "two sentences long. ", "And a third to fill the thread."], delayMs: 0 }));
    await streamAnswers(page, [...earlier, { pieces: SHORT, delayMs: 200 }]);
    await open(page);
    for (let i = 0; i < earlier.length; i++) {
      await send(page, `E2E: earlier question ${i + 1}`);
      await expect(page.getByText(`E2E: an earlier answer ${i + 1},`)).toBeVisible();
    }
    expect(await page.evaluate(() => { const el = document.querySelector("[data-thread-scroll]") as HTMLElement; return el.scrollHeight > el.clientHeight; })).toBe(true);
    await watch(page);
    await send(page, "E2E: three lines please");
    await expect(page.locator("[data-live-answer]")).toBeVisible();
    await expect(page.locator("[data-live-answer]")).toHaveCount(0, { timeout: 10_000 });
    const seen = await frames(page);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.filter((f) => f.bottom > f.composerTop + 1)).toEqual([]);
    const landedAt = await topOf(page, `e2e-reply-${earlier.length + 1}`);
    expect(Math.abs(landedAt - seen.at(-1)!.top)).toBeLessThanOrEqual(1);
    await page.waitForTimeout(600);
    expect(Math.abs((await topOf(page, `e2e-reply-${earlier.length + 1}`)) - landedAt)).toBeLessThanOrEqual(1);
  });
});
