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

// v1.09 r4 (docs/chat/SPEC.md §1): the thread follows the answer, and only his hands stop it. A stand-in for fetch
// streams each answer piece by piece (rounds too), as the route does. Every animation frame is sampled in the page
// (requestAnimationFrame): where the line being written stands against the composer, where the thread stands, and
// whether it is following. His input is the mouse wheel, in Chromium and in WebKit alike: Playwright cannot send a
// wheel to mobile WebKit, nor drag a touch anywhere, so these run as a 390 × 844 page that is not "mobile" (real
// touch, momentum, VoiceOver and the iOS indicator are seen only on a device, and named in the spec).
test.describe("the thread follows the answer as it is written; only his hands stop it", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: false });
  // CHAT_CPU_THROTTLE=4 slows the page's CPU fourfold (Chromium only, through the DevTools protocol). Off in CI.
  test.beforeEach(async ({ page, browserName }) => {
    const rate = Number(process.env.CHAT_CPU_THROTTLE ?? 0);
    if (rate > 1 && browserName === "chromium") {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    }
  });

  const LONG = Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of the plan says what to do next and why it matters this week. `);
  const SHORT = ["E2E: three short lines. ", "The shed roof first. ", "Then the tax papers."];

  /** One answer: its rounds (each starts the live text over), each round's pieces, and the wait before each piece. */
  type Answer = { rounds: string[][]; delayMs: number };
  async function streamAnswers(page: import("@playwright/test").Page, answers: Answer[]) {
    await page.addInitScript((script: Answer[]) => {
      let n = 0;
      const real = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!/\/api\/chat$/.test(url) || init?.method !== "POST") return real(input, init);
        const body = JSON.parse(String(init.body ?? "{}")) as { turnId?: string };
        const a = script.shift() ?? { rounds: [["Noted."]], delayMs: 0 };
        n++;
        const enc = new TextEncoder();
        const line = (o: unknown) => enc.encode(JSON.stringify(o) + "\n");
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(line({ type: "accepted", turnId: body.turnId, conversationId: "e2e-conv", userMessageId: `e2e-his-${n}` }));
            for (const [round, pieces] of a.rounds.entries()) {
              for (const text of pieces) {
                await wait(a.delayMs);
                c.enqueue(line({ type: "text", round, text }));
              }
            }
            await wait(a.delayMs);
            c.enqueue(line({ type: "done", conversationId: "e2e-conv", userMessageId: `e2e-his-${n}`, assistantMessage: { id: `e2e-reply-${n}`, role: "assistant", content: a.rounds.at(-1)!.join(""), createdAt: new Date().toISOString() }, toasts: [], uiActions: [] }));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
      };
    }, answers);
  }

  type Frame = { t: number; top: number | null; bottom: number | null; composerTop: number; scroll: number; height: number; view: number };
  /** Every animation frame from now: the live answer's box (null once it has landed), the composer, the thread. */
  const watch = (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __frames: Frame[]; __stop: boolean; __wheelAt: number | null };
      w.__frames = [];
      w.__stop = false;
      w.__wheelAt = null;
      document.addEventListener("wheel", () => (w.__wheelAt ??= performance.now()), { capture: true, passive: true });
      const tick = () => {
        const live = document.querySelector("[data-live-answer]");
        const composer = document.querySelector("[data-composer]");
        const el = document.querySelector("[data-thread-scroll]") as HTMLElement | null;
        if (composer && el) {
          const r = live?.getBoundingClientRect();
          w.__frames.push({ t: performance.now(), top: r ? r.top : null, bottom: r ? r.bottom : null, composerTop: composer.getBoundingClientRect().top, scroll: el.scrollTop, height: el.scrollHeight, view: el.clientHeight });
        }
        if (!w.__stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const frames = (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __frames: Frame[]; __stop: boolean };
      w.__stop = true;
      return w.__frames;
    });
  /** The frames from his first wheel event on, and how far the thread was ever moved back down between two of them. */
  const afterWheel = async (page: import("@playwright/test").Page) => {
    const wheelAt = await page.evaluate(() => (window as unknown as { __wheelAt: number | null }).__wheelAt);
    const seen = await frames(page);
    const after = seen.filter((f) => wheelAt !== null && f.t >= wheelAt);
    let pulled = 0;
    for (let i = 1; i < after.length; i++) pulled = Math.max(pulled, after[i].scroll - after[i - 1].scroll);
    return { before: seen.filter((f) => wheelAt === null || f.t < wheelAt).at(-1), after, pulled };
  };
  /** In every frame the answer is being written, its last line stands above the composer. */
  const followed = (seen: Frame[]) => {
    const live = seen.filter((f) => f.bottom !== null);
    return { live: live.length, under: live.filter((f) => f.bottom! > f.composerTop + 1).length };
  };
  const topOf = (page: import("@playwright/test").Page, id: string) => page.evaluate((id) => document.getElementById(id)!.getBoundingClientRect().top, `m-${id}`);
  const thread = (page: import("@playwright/test").Page) => page.locator("[data-thread-scroll]");
  async function open(page: import("@playwright/test").Page) {
    await page.goto("/today");
    await page.getByTestId("chat-launcher").click();
  }
  async function send(page: import("@playwright/test").Page, text: string) {
    await page.getByRole("textbox", { name: "Ask your secretary" }).fill(text);
    await page.getByRole("button", { name: "Send message" }).click();
  }
  /** His hand: the wheel over the thread (up is negative). */
  async function wheel(page: import("@playwright/test").Page, dy: number) {
    const box = (await thread(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, dy);
  }
  const landed = (page: import("@playwright/test").Page, timeout = 15_000) => expect(page.locator("[data-live-answer]")).toHaveCount(0, { timeout });
  /** Until the thread has followed this far down: room for a step up. */
  const followedDown = (page: import("@playwright/test").Page, px: number) =>
    page.waitForFunction((px) => (document.querySelector("[data-thread-scroll]") as HTMLElement).scrollTop >= px, px, { timeout: 15_000 });
  const fillThread = async (page: import("@playwright/test").Page, n: number) => {
    for (let i = 0; i < n; i++) {
      await send(page, `E2E: earlier question ${i + 1}`);
      await expect(page.getByText(`E2E: an earlier answer ${i + 1},`)).toBeVisible();
    }
  };
  const earlier = (n: number): Answer[] => Array.from({ length: n }, (_, i) => ({ rounds: [[`E2E: an earlier answer ${i + 1}, `, "two sentences long. ", "And a third to fill the thread."]], delayMs: 0 }));

  test("a long answer (input: none): every frame's last line above the composer; it lands without moving", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [LONG], delayMs: 120 }]);
    await open(page);
    await watch(page);
    await send(page, "E2E: a long plan please");
    await landed(page);
    const seen = await frames(page);
    const f = followed(seen);
    expect(f.live).toBeGreaterThan(20);
    expect(f.under, `${f.under} of ${f.live} frames had the line being written under the composer`).toBe(0);
    const last = seen.filter((x) => x.top !== null).at(-1)!;
    expect(Math.abs((await topOf(page, "e2e-reply-1")) - last.top!)).toBeLessThanOrEqual(1);
    mkdirSync("screenshots", { recursive: true });
    await page.screenshot({ path: "screenshots/chat-long-landed.png" });
  });

  test("three lines in a thread that scrolls (input: none): followed, and it lands where it was written", async ({ page }) => {
    await streamAnswers(page, [...earlier(6), { rounds: [SHORT], delayMs: 200 }]);
    await open(page);
    await fillThread(page, 6);
    await watch(page);
    await send(page, "E2E: three lines please");
    await landed(page);
    const seen = await frames(page);
    expect(followed(seen).under).toBe(0);
    const last = seen.filter((x) => x.top !== null).at(-1)!;
    expect(Math.abs((await topOf(page, "e2e-reply-7")) - last.top!)).toBeLessThanOrEqual(1);
  });

  test("two rounds, the second shorter (input: none): the round that starts over is followed too", async ({ page }) => {
    const roundZero = Array.from({ length: 6 }, (_, i) => `E2E: round zero, sentence ${i + 1}, long enough to wrap. `);
    await streamAnswers(page, [...earlier(5), { rounds: [roundZero, ["E2E: round one, ", "short."]], delayMs: 120 }]);
    await open(page);
    await fillThread(page, 5);
    await watch(page);
    await send(page, "E2E: two rounds please");
    await landed(page);
    const seen = await frames(page);
    const f = followed(seen);
    expect(f.under, `${f.under} of ${f.live} frames under the composer`).toBe(0);
    // Landed in view: its bottom above the composer.
    const box = await page.evaluate(() => document.getElementById("m-e2e-reply-6")!.getBoundingClientRect().bottom);
    expect(box).toBeLessThanOrEqual(seen.at(-1)!.composerTop + 1);
  });

  test("pieces every 40 ms and one wheel step up (input: wheel): he is never pulled back", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG]], delayMs: 40 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 200);
    await watch(page);
    await wheel(page, -120);
    await landed(page);
    const { before, after, pulled } = await afterWheel(page);
    expect(after.filter((f) => f.bottom !== null).length, "frames written after his wheel").toBeGreaterThan(10);
    expect(pulled, "moved back down between two frames after his wheel").toBeLessThanOrEqual(2);
    expect(before!.scroll - after.at(-1)!.scroll, "and the wheel did move him up").toBeGreaterThanOrEqual(100);
  });

  test("a wheel up while the panel opens (input: wheel): never pulled back, and left where it settled", async ({ page }) => {
    await streamAnswers(page, [...earlier(6), { rounds: [[...LONG, ...LONG]], delayMs: 60 }]);
    await open(page);
    await fillThread(page, 6);
    // Put the panel away to the bar (a tap on its grabber), so the next send opens it again while the answer starts.
    await page.getByRole("button", { name: "Drag down to shrink the conversation" }).click();
    await page.waitForTimeout(600);
    await watch(page);
    await send(page, "E2E: a long plan please");
    // A tenth of a second into the panel's 340 ms: it is still growing when he scrolls up, and after.
    await page.waitForTimeout(100);
    await wheel(page, -700);
    await landed(page);
    const { after, pulled } = await afterWheel(page);
    expect(after.length).toBeGreaterThan(10);
    expect(pulled, "moved back down between two frames after his wheel").toBeLessThanOrEqual(2);
    // He was left above the bottom once the panel had opened: the case is the one it names.
    const last = after.at(-1)!;
    expect(last.height - last.scroll - last.view).toBeGreaterThan(32);
  });

  test("the keyboard opening, as the view growing shorter (input: none): still followed", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [LONG], delayMs: 120 }]);
    await open(page);
    await watch(page);
    await send(page, "E2E: a long plan please");
    await expect(page.locator("[data-live-answer]")).toBeVisible();
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 390, height: 520 });
    await landed(page);
    const seen = await frames(page);
    const f = followed(seen);
    expect(f.under, `${f.under} of ${f.live} frames under the composer`).toBe(0);
  });

  test("a wheel back down to within 32 px while pieces keep coming (input: wheel): following resumes", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG, ...LONG]], delayMs: 80 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 300);
    await wheel(page, -250);
    await page.waitForTimeout(400);
    await wheel(page, 2000);
    await page.waitForTimeout(400);
    await watch(page);
    await landed(page);
    const seen = await frames(page);
    const f = followed(seen);
    expect(f.live).toBeGreaterThan(5);
    expect(f.under, `${f.under} of ${f.live} frames under the composer after he came back`).toBe(0);
  });

  test("a script scroll with no input and no size change (input: none, standing in for the indicator or VoiceOver): following off", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG]], delayMs: 150 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 250);
    // Right after a piece was followed, before the next comes: nothing has changed size since.
    const at = await thread(page).evaluate(
      (el) =>
        new Promise<number>((resolve) => {
          const live = document.querySelector("[data-live-answer]")!;
          const mo = new MutationObserver(() => {
            mo.disconnect();
            requestAnimationFrame(() => {
              el.scrollTop = el.scrollTop - 200;
              resolve(el.scrollTop);
            });
          });
          mo.observe(live, { childList: true, subtree: true, characterData: true });
        })
    );
    await page.waitForTimeout(100);
    await watch(page);
    await landed(page);
    const seen = await frames(page);
    expect(Math.max(...seen.map((f) => f.scroll)) - at).toBeLessThanOrEqual(2);
  });

  test("a clamp (the view grows taller, input: none): following stays on", async ({ page }) => {
    await streamAnswers(page, [...earlier(4), { rounds: [LONG], delayMs: 120 }]);
    await page.setViewportSize({ width: 390, height: 600 });
    await open(page);
    await fillThread(page, 4);
    await watch(page);
    await send(page, "E2E: a long plan please");
    await expect(page.locator("[data-live-answer]")).toBeVisible();
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 390, height: 844 });
    await landed(page);
    const f = followed(await frames(page));
    expect(f.under, `${f.under} of ${f.live} frames under the composer`).toBe(0);
  });

  test("a new send turns following on (input: wheel, then a send)", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG]], delayMs: 60 }, { rounds: [LONG], delayMs: 120 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 200);
    await wheel(page, -300);
    await landed(page);
    await watch(page);
    await send(page, "E2E: and another");
    await landed(page);
    const f = followed(await frames(page));
    expect(f.live).toBeGreaterThan(5);
    expect(f.under, `${f.under} of ${f.live} frames under the composer after his send`).toBe(0);
  });
});
