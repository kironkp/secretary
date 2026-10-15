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

// v1.09 r5 (docs/chat/SPEC.md §1): the thread follows the answer until his hand is on it; the "New reply below" pill
// follows again. A stand-in for fetch streams each answer piece by piece (rounds too), as the route does. Whether the
// answer being written is in view is judged at paint, by an IntersectionObserver (it reports every change, computed
// after the page's ResizeObserver, just before the frame is painted); every animation frame is also sampled in the
// page (requestAnimationFrame, each read once the frame is drawn): where the line being written stands against the
// composer, where the thread stands and whether the pill shows, for the checks that he is never pulled back and that
// the answer lands without moving. His input: the mouse wheel, a mouse button and a key in Chromium and WebKit (a
// 390 × 844 page that is not "mobile": Playwright sends no wheel to mobile WebKit), and real touches in Chromium
// (through the DevTools protocol; Playwright has no touch input for WebKit). iOS momentum, VoiceOver and the iOS
// indicator are seen only on a device, and named in the spec.
test.describe("the thread follows the answer until his hand is on it; the pill follows again", () => {
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

  type Frame = { t: number; top: number | null; bottom: number | null; composerTop: number; scroll: number; height: number; view: number; pill: boolean };
  /** Every animation frame from now: the live answer's box (null once it has landed), the composer, the thread. Each
   *  frame's requestAnimationFrame callback posts a read that runs once that frame is drawn: the callbacks run before
   *  the frame's layout and its ResizeObserver callbacks (which keep the bottom in view when the thread changes size),
   *  so a read inside one sees, while the panel animates shorter, a state the screen never shows. */
  const watch = (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __frames: Frame[]; __stop: boolean; __handAt: number | null; __handTop: number | null; __taps: number[] };
      w.__frames = [];
      w.__stop = false;
      w.__handAt = null;
      w.__handTop = null;
      w.__taps = [];
      // His first hand on the thread (a wheel, a mouse or pen down, a touch, a scroll key with no field focused): when,
      // and where the thread stood (the event comes before the scroll it makes).
      const hand = (e: Event) => {
        if (w.__handAt !== null) return;
        const el = document.querySelector("[data-thread-scroll]") as HTMLElement | null;
        if (!el) return;
        if (e.type === "keydown" ? document.activeElement?.matches("input, textarea, select, [contenteditable]") : !el.contains(e.target as Node)) return;
        w.__handAt = performance.now();
        w.__handTop = el.scrollTop;
      };
      for (const type of ["wheel", "pointerdown", "touchstart", "keydown"]) document.addEventListener(type, hand, { capture: true, passive: true });
      // Each tap on the pill: when.
      document.addEventListener("click", (e) => (e.target as Element).closest?.("[data-new-reply-pill]") && w.__taps.push(performance.now()), { capture: true });
      // At paint: whether the answer being written is wholly in the thread's view. An IntersectionObserver's
      // intersections are computed after the frame's ResizeObserver callbacks, just before it is painted; its root is
      // the thread with the top pushed far up, so only the thread's bottom edge (the composer's top) can cut it off.
      const ww = w as unknown as { __out: { t: number; ratio: number }[] };
      ww.__out = [];
      const ios = new Map<Element, IntersectionObserver>();
      let seenLive: Element | null = null;
      const look = () => {
        const live = document.querySelector("[data-live-answer]");
        const root = live?.closest("[data-thread-scroll]");
        if (!live || !root || live === seenLive) return;
        seenLive = live;
        let io = ios.get(root);
        if (!io) {
          io = new IntersectionObserver(
            (entries) =>
              entries.forEach((e) => {
                // A removed answer (it landed) reports an empty box: not a paint of it.
                if (e.boundingClientRect.height > 0 && e.intersectionRatio < 1) ww.__out.push({ t: e.time, ratio: e.intersectionRatio });
              }),
            { root, rootMargin: "100000px 0px 0px 0px", threshold: [1] }
          );
          ios.set(root, io);
        }
        io.observe(live);
      };
      new MutationObserver(look).observe(document.body, { childList: true, subtree: true });
      look();
      const drawn = new MessageChannel();
      drawn.port1.onmessage = () => {
        const live = document.querySelector("[data-live-answer]");
        const composer = document.querySelector("[data-composer]");
        const el = document.querySelector("[data-thread-scroll]") as HTMLElement | null;
        if (composer && el) {
          const r = live?.getBoundingClientRect();
          w.__frames.push({ t: performance.now(), top: r ? r.top : null, bottom: r ? r.bottom : null, composerTop: composer.getBoundingClientRect().top, scroll: el.scrollTop, height: el.scrollHeight, view: el.clientHeight, pill: !!document.querySelector("[data-new-reply-pill]") });
        }
      };
      const tick = () => {
        if (w.__stop) return;
        drawn.port2.postMessage(0);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const frames = (page: import("@playwright/test").Page) =>
    page.evaluate(() => {
      const w = window as unknown as { __frames: Frame[]; __stop: boolean };
      w.__stop = true;
      return w.__frames;
    });
  /** The frames from his first hand on the thread until his first tap on the pill (or the end), where the thread stood
   *  at that hand, how far it was ever moved back down between two of them, and the frames from the tap on. */
  const afterHand = async (page: import("@playwright/test").Page) => {
    const { handAt, handTop, taps } = await page.evaluate(() => {
      const w = window as unknown as { __handAt: number | null; __handTop: number | null; __taps: number[] };
      return { handAt: w.__handAt, handTop: w.__handTop, taps: w.__taps };
    });
    expect(handAt, "his hand reached the page").not.toBeNull();
    const seen = await frames(page);
    const tapAt = taps.find((t) => t > handAt!) ?? Infinity;
    const after = seen.filter((f) => f.t >= handAt! && f.t < tapAt);
    let pulled = 0;
    for (let i = 1; i < after.length; i++) pulled = Math.max(pulled, after[i].scroll - after[i - 1].scroll);
    return { handTop: handTop!, after, pulled, tapAt, seen };
  };
  /** The answer being written, two ways: at paint, how many times it was not wholly in the thread's view (the check);
   *  and in the frames read once drawn, how many had its last line under the composer (shown beside it). */
  const followed = async (page: import("@playwright/test").Page, seen: Frame[], since = 0) => {
    // Intersection reports are delivered as tasks after the paint: let the last ones in.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
    const out = (await page.evaluate(() => (window as unknown as { __out: { t: number; ratio: number }[] }).__out)).filter((o) => o.t >= since);
    const live = seen.filter((f) => f.bottom !== null && f.t >= since);
    const r = { live: live.length, out: out.length, drawnUnder: live.filter((f) => f.bottom! > f.composerTop + 1).length };
    console.log(`[follow] ${test.info().title}: at paint ${r.out} not wholly in view; read once drawn ${r.drawnUnder} of ${r.live} under`);
    return r;
  };
  const inViewMessage = (f: { live: number; out: number; drawnUnder: number }) =>
    `${f.out} paints with the answer being written not wholly in view (read once drawn: ${f.drawnUnder} of ${f.live} frames under)`;
  const topOf = (page: import("@playwright/test").Page, id: string) => page.evaluate((id) => document.getElementById(id)!.getBoundingClientRect().top, `m-${id}`);
  const thread = (page: import("@playwright/test").Page) => page.locator("[data-thread-scroll]");
  const pill = (page: import("@playwright/test").Page) => page.locator("[data-new-reply-pill]");
  /** How far the thread stands above its bottom. */
  const gap = (page: import("@playwright/test").Page) => thread(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
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
  /** The n-th answer of the page has landed: saved, and nothing left being written. (Not "no live answer": that is
   *  true before the first piece too.) */
  const landed = async (page: import("@playwright/test").Page, n: number) => {
    await expect(page.locator(`#m-e2e-reply-${n}`)).toBeAttached({ timeout: 20_000 });
    await expect(page.locator("[data-live-answer]")).toHaveCount(0);
  };
  /** Until the thread has followed this far down: room for a step up. A precondition, read every 50 ms; not how the
   *  follow is measured. (Not waitForFunction: Playwright's WebKit on this Mac evaluates it as a string, which the
   *  app's script policy refuses.) */
  const followedDown = (page: import("@playwright/test").Page, px: number) =>
    expect
      .poll(() => thread(page).evaluate((el) => el.scrollTop), { timeout: 15_000, intervals: [50] })
      .toBeGreaterThanOrEqual(px);
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
    await landed(page, 1);
    const seen = await frames(page);
    const f = await followed(page, seen);
    expect(f.live).toBeGreaterThan(20);
    expect(f.out, inViewMessage(f)).toBe(0);
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
    await landed(page, 7);
    const seen = await frames(page);
    const f = await followed(page, seen);
    expect(f.out, inViewMessage(f)).toBe(0);
    const last = seen.filter((x) => x.top !== null).at(-1)!;
    expect(Math.abs((await topOf(page, "e2e-reply-7")) - last.top!)).toBeLessThanOrEqual(1);
  });

  test("two rounds, the second shorter (input: none): the round that starts over is followed too", async ({ page }) => {
    // Round 1 is half as long as round 0, and still more than the thread shows below where round 0 ended: when it
    // starts over, the thread shrinks (the browser pulls its position down) and then grows again past the composer.
    const roundZero = Array.from({ length: 12 }, (_, i) => `E2E: round zero, sentence ${i + 1}, long enough to wrap. `);
    const roundOne = Array.from({ length: 6 }, (_, i) => `E2E: round one, sentence ${i + 1}, shorter but it wraps. `);
    await streamAnswers(page, [...earlier(5), { rounds: [roundZero, roundOne], delayMs: 120 }]);
    await open(page);
    await fillThread(page, 5);
    await watch(page);
    await send(page, "E2E: two rounds please");
    await landed(page, 6);
    const seen = await frames(page);
    const f = await followed(page, seen);
    expect(f.out, inViewMessage(f)).toBe(0);
    // Landed in view: its bottom above the composer.
    const box = await page.evaluate(() => document.getElementById("m-e2e-reply-6")!.getBoundingClientRect().bottom);
    expect(box).toBeLessThanOrEqual(seen.at(-1)!.composerTop + 1);
  });

  test("pieces every 40 ms and one wheel step up (input: wheel): off for the turn, never pulled back; the pill follows again", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG, ...LONG]], delayMs: 40 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 200);
    await watch(page);
    await wheel(page, -120);
    await expect(pill(page)).toBeVisible();
    await page.waitForTimeout(300);
    await pill(page).click();
    await landed(page, 1);
    const { handTop, after, pulled, tapAt, seen } = await afterHand(page);
    expect(after.filter((f) => f.bottom !== null).length, "frames written between his wheel and the pill").toBeGreaterThan(5);
    expect(pulled, "moved back down between two frames before the pill").toBeLessThanOrEqual(2);
    expect(handTop - after.at(-1)!.scroll, "and the wheel did move him up").toBeGreaterThanOrEqual(100);
    // From the tap on: followed again, every paint.
    const f = await followed(page, seen, tapAt);
    expect(f.live, "frames written after the tap").toBeGreaterThan(5);
    expect(f.out, inViewMessage(f)).toBe(0);
  });

  test("a wheel up while the panel opens (input: wheel): off, never pulled back, the pill shows", async ({ page }) => {
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
    await expect(pill(page)).toBeVisible();
    await landed(page, 7);
    const { after, pulled } = await afterHand(page);
    expect(after.length).toBeGreaterThan(10);
    expect(pulled, "moved back down between two frames after his wheel").toBeLessThanOrEqual(2);
  });

  test("the keyboard opening, as the view growing shorter (input: none): still followed", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [LONG], delayMs: 120 }]);
    await open(page);
    await watch(page);
    await send(page, "E2E: a long plan please");
    await expect(page.locator("[data-live-answer]")).toBeVisible();
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 390, height: 520 });
    await landed(page, 1);
    const seen = await frames(page);
    const f = await followed(page, seen);
    expect(f.out, inViewMessage(f)).toBe(0);
    expect(seen.some((x) => x.pill), "no pill while following").toBe(false);
  });

  test("a wheel back to the bottom does not turn it on: off is one way for the turn (input: wheel)", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG, ...LONG]], delayMs: 80 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 300);
    await watch(page);
    await wheel(page, -250);
    await page.waitForTimeout(300);
    await wheel(page, 5000);
    await page.waitForTimeout(150);
    // At the bottom he put himself at, the next pieces are written below him: not followed, and the pill shows.
    await expect(pill(page)).toBeVisible();
    await landed(page, 1);
    const { after } = await afterHand(page);
    expect(after.at(-1)!.height - after.at(-1)!.scroll - after.at(-1)!.view, "left above what was written after").toBeGreaterThan(32);
  });

  test("a scroll with no input while pieces come every 40 ms (input: none, standing in for VoiceOver or the indicator): off each time, never pulled back", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG, ...LONG, ...LONG, ...LONG, ...LONG]], delayMs: 40 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 300);
    await watch(page);
    // Five times in one answer: the thread scrolled up 150 px by script (no input), the first right after a piece is
    // drawn, the others at a moment of their own; 250 ms later the pill is tapped, which follows again.
    const trials = await thread(page).evaluate(async (el) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const out: { at: number; top: number; tapAt: number; pill: boolean }[] = [];
      for (let k = 0; k < 5; k++) {
        if (k === 0) {
          await new Promise((r) => {
            const mo = new MutationObserver(() => {
              mo.disconnect();
              requestAnimationFrame(r);
            });
            mo.observe(document.querySelector("[data-live-answer]")!, { childList: true, subtree: true, characterData: true });
          });
        } else await wait(10 + Math.random() * 60);
        el.scrollTop = el.scrollTop - 150;
        const at = performance.now();
        const top = el.scrollTop;
        await wait(250);
        const p = document.querySelector("[data-new-reply-pill]") as HTMLElement | null;
        const tapAt = performance.now();
        p?.click();
        out.push({ at, top, tapAt, pill: !!p });
        await wait(150);
      }
      return out;
    });
    await landed(page, 1);
    const seen = await frames(page);
    for (const [k, t] of trials.entries()) {
      const between = seen.filter((f) => f.t >= t.at && f.t < t.tapAt);
      expect(between.length, `trial ${k + 1}: frames before the pill`).toBeGreaterThan(3);
      expect(Math.max(...between.map((f) => f.scroll)) - t.top, `trial ${k + 1}: pulled back`).toBeLessThanOrEqual(2);
      expect(t.pill, `trial ${k + 1}: the pill showed`).toBe(true);
    }
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
    await landed(page, 5);
    const f = await followed(page, await frames(page));
    expect(f.out, inViewMessage(f)).toBe(0);
  });

  test("a new send turns following on (input: wheel, then a send)", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG]], delayMs: 60 }, { rounds: [LONG], delayMs: 120 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 200);
    await wheel(page, -300);
    await landed(page, 1);
    await watch(page);
    await send(page, "E2E: and another");
    await landed(page, 2);
    const f = await followed(page, await frames(page));
    expect(f.live).toBeGreaterThan(5);
    expect(f.out, inViewMessage(f)).toBe(0);
  });

  test("a scroll key with no field focused (input: the PageUp key): off for the turn, never pulled back, the pill shows", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG, ...LONG]], delayMs: 60 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 200);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await watch(page);
    await page.keyboard.press("PageUp");
    await expect(pill(page)).toBeVisible();
    await landed(page, 1);
    const { after, pulled } = await afterHand(page);
    expect(after.filter((f) => f.bottom !== null).length, "frames written after the key").toBeGreaterThan(5);
    expect(pulled, "moved back down between two frames after the key").toBeLessThanOrEqual(2);
  });

  test("a mouse button held on the answer through its landing (input: mouse): off, never pulled back, the pill shows", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG]], delayMs: 60 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 200);
    await watch(page);
    const box = (await page.locator("[data-live-answer]").boundingBox())!;
    await page.mouse.move(box.x + 20, box.y + box.height - 20);
    await page.mouse.down();
    await landed(page, 1); // the answer it was pressed on is gone
    await page.mouse.up();
    await page.waitForTimeout(300);
    await expect(pill(page)).toBeVisible();
    const { after, pulled } = await afterHand(page);
    expect(after.length).toBeGreaterThan(10);
    expect(pulled, "moved back down between two frames after the press").toBeLessThanOrEqual(2);
  });

  test("the pill: 44 px or more, clear of the composer, only when needed; a tap brings the bottom into view and follows again (input: wheel, then a tap)", async ({ page }) => {
    await streamAnswers(page, [{ rounds: [[...LONG, ...LONG]], delayMs: 250 }]);
    await open(page);
    await send(page, "E2E: a long plan please");
    await followedDown(page, 150);
    await watch(page);
    await expect(pill(page), "following: no pill").toHaveCount(0);
    await wheel(page, -150);
    await expect(pill(page), "off, and the next piece below him").toBeVisible();
    const p = (await pill(page).boundingBox())!;
    const t = (await thread(page).boundingBox())!;
    const composer = (await page.locator("[data-composer]").boundingBox())!;
    expect(p.height, "its height").toBeGreaterThanOrEqual(44);
    expect(p.y + p.height, "clear of the composer").toBeLessThanOrEqual(composer.y - 4);
    expect(Math.abs(p.x + p.width / 2 - (t.x + t.width / 2)), "centred over the thread").toBeLessThanOrEqual(1);
    mkdirSync("screenshots", { recursive: true });
    await page.screenshot({ path: "screenshots/chat-new-reply-pill.png" });
    // He scrolls to the bottom himself: in view, so no pill (still off: the next piece is written below him again).
    await wheel(page, 5000);
    await expect(pill(page)).toBeVisible({ timeout: 2_000 });
    await pill(page).click();
    await expect.poll(() => gap(page), { timeout: 2_000 }).toBeLessThanOrEqual(1);
    await expect(pill(page)).toHaveCount(0);
    await landed(page, 1);
    const { seen, tapAt } = await afterHand(page);
    const self = seen.filter((f) => f.t < tapAt && f.height - f.scroll - f.view <= 1 && !f.pill);
    expect(self.length, "at the bottom by his own wheel, no pill").toBeGreaterThan(0);
    const f = await followed(page, seen, tapAt);
    expect(f.out, inViewMessage(f)).toBe(0);
  });

  test.describe("by touch (Chromium: real touches through the DevTools protocol)", () => {
    test.use({ hasTouch: true, isMobile: true });
    test("a finger held on the answer through its landing, then a drag up: never pulled down; the pill follows again (input: touch)", async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "Playwright sends touch input to Chromium only");
      await streamAnswers(page, [{ rounds: [[...LONG, ...LONG]], delayMs: 80 }]);
      await open(page);
      await send(page, "E2E: a long plan please");
      await followedDown(page, 300);
      const cdp = await page.context().newCDPSession(page);
      const touch = (type: "touchStart" | "touchMove" | "touchEnd", y = 0) =>
        cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: 195, y }] });
      await watch(page);
      // The finger comes down on the answer being written and stays there while it lands (the node it touched goes).
      const box = (await page.locator("[data-live-answer]").boundingBox())!;
      await touch("touchStart", Math.round(box.y + box.height - 30));
      await landed(page, 1);
      await page.waitForTimeout(200);
      await touch("touchEnd");
      // Then a slow drag down the screen (he scrolls up), held still, lifted.
      const t = (await thread(page).boundingBox())!;
      const y0 = Math.round(t.y + 80);
      await touch("touchStart", y0);
      for (let k = 1; k <= 14; k++) await touch("touchMove", y0 + Math.round((240 * k) / 14));
      await page.waitForTimeout(100);
      await touch("touchEnd");
      const stopped = await thread(page).evaluate((el) => el.scrollTop);
      await page.waitForTimeout(1_000);
      expect((await thread(page).evaluate((el) => el.scrollTop)) - stopped, "left where he stopped").toBeLessThanOrEqual(2);
      await expect(pill(page)).toBeVisible();
      await pill(page).tap();
      await expect.poll(() => gap(page), { timeout: 2_000 }).toBeLessThanOrEqual(1);
      const { pulled } = await afterHand(page);
      expect(pulled, "moved back down between two frames before the pill").toBeLessThanOrEqual(2);
    });
  });
});
