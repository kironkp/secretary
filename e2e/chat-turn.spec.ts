// v1.09 (docs/chat/SPEC.md §3), in a real browser on the phone profile: an
// answer cut off is not "Not delivered". The page asks again for the same
// turn, marked resume, and shows the saved answer; only his tap asks without
// the mark. The network is page.route, so no model is reached. What vitest
// cannot see: the page's own fetch, what it sends, and the answer drawn in the
// thread.
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
async function say(page: import("@playwright/test").Page, text: string) {
  await page.goto("/today");
  await page.getByLabel("Ask your secretary").fill(text);
  await page.getByLabel("Send message").click();
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
  expect(asks.length).toBe(2);
  await retry.click();
  await expect(page.getByText("E2E: answered on the tap.")).toBeVisible();
  await expect(retry).toHaveCount(0);
  expect(asks.map((a) => [a.turnId === asks[0].turnId, a.resume ?? false])).toEqual([[true, false], [true, true], [true, false]]);
});
