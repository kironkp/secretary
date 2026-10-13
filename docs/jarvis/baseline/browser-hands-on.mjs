// Task 1.01: hands on the Workspace. A measurement tool, not product code.
// Chromium (the browser Playwright can launch on this Mac). On the phone and
// tablet profiles every gesture is real touch input sent through the browser's
// own input pipeline (CDP Input.dispatchTouchEvent), not page.mouse and not
// synthetic DOM events; the desktop profile uses the mouse. Each gesture is
// tried ONCE; what is printed is that first try.
//
//   BASE_URL=http://localhost:3112 STATE=<path>/state.json OUT=<dir> \
//     DATABASE_URL=postgresql://postgres:postgres@localhost:5441/secretary \
//     PROFILE=phone|tablet|desktop node docs/jarvis/baseline/browser-hands-on.mjs
import { mkdirSync } from "node:fs";
import { chromium, devices } from "@playwright/test";
import pg from "pg";

const base = process.env.BASE_URL ?? "http://localhost:3112";
const out = process.env.OUT ?? "hands-on";
const profile = process.env.PROFILE ?? "phone";
const dbUrl = process.env.DATABASE_URL ?? "";
if (!["localhost", "127.0.0.1"].includes(new URL(dbUrl).hostname)) throw new Error("local databases only");
const executablePath =
  process.env.CHROMIUM ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
const DEVICES = {
  phone: { ...devices["iPhone 15"], viewport: { width: 393, height: 852 } },
  tablet: { ...devices["iPad (gen 7)"], viewport: { width: 820, height: 1180 } },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
};
const device = DEVICES[profile];
const byTouch = profile !== "desktop";

mkdirSync(out, { recursive: true });
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const usageRows = async () => (await db.query("select count(*)::int as n from usage")).rows[0].n;
const taskStatus = async (id) => (await db.query("select status from tasks where id = $1", [id])).rows[0]?.status;

const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ ...device, defaultBrowserType: undefined, storageState: process.env.STATE, baseURL: base });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

// Everything the page asks for, so a model call would show.
let requests = [];
page.on("request", (r) => {
  const u = new URL(r.url());
  if (u.origin !== base) requests.push(`${r.method()} ${u.origin}${u.pathname}`);
  else if (u.pathname.startsWith("/api/")) requests.push(`${r.method()} ${u.pathname}`);
});
const takeRequests = () => {
  const seen = requests;
  requests = [];
  return seen;
};
const allRequests = new Set();
const step = (name, result) => {
  for (const r of result.requests ?? []) allRequests.add(r);
  console.log(JSON.stringify({ profile, input: byTouch ? "touch" : "mouse", step: name, ...result }));
};
const shot = (name) => page.screenshot({ path: `${out}/${profile}-${name}.png` });
const board = async () => (await page.request.get("/api/workspace")).json();
const stored = async () =>
  Object.fromEntries((await board()).widgets.map((w) => [w.id, { x: w.x, y: w.y, w: w.w, h: w.h, collapsed: !!w.collapsed }]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const center = async (selector) => {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  if (!b) throw new Error(`no box for ${selector}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
const touch = (type, x, y) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y) }] });
async function drag(from, dx, dy) {
  if (byTouch) {
    await touch("touchStart", from.x, from.y);
    for (let i = 1; i <= 10; i++) {
      await touch("touchMove", from.x + (dx * i) / 10, from.y + (dy * i) / 10);
      await page.waitForTimeout(30);
    }
    await touch("touchEnd");
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
    await page.mouse.up();
  }
  await page.waitForTimeout(900);
}
async function tap(x, y) {
  if (byTouch) {
    await touch("touchStart", x, y);
    await page.waitForTimeout(40);
    await touch("touchEnd");
  } else await page.mouse.click(x, y);
  await page.waitForTimeout(1200);
}
/** Widgets as drawn: where each sits, and how many pairs cover one another. */
async function layout() {
  const boxes = await page.locator("[data-widget]").evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect();
      return { id: e.getAttribute("data-widget"), left: Math.round(r.left), top: Math.round(r.top + window.scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    })
  );
  let overlapping = 0;
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.left < b.left + b.w - 1 && b.left < a.left + a.w - 1 && a.top < b.top + b.h - 1 && b.top < a.top + a.h - 1) overlapping++;
    }
  return {
    one_column: new Set(boxes.map((b) => `${b.left}/${b.w}`)).size === 1,
    order_top_to_bottom: [...boxes].sort((a, b) => a.top - b.top).map((b) => b.id),
    overlapping_pairs: overlapping,
  };
}

const usageBefore = await usageRows();
await page.goto("/workspace", { waitUntil: "load" });
await page.waitForTimeout(2000);
const start = await stored();
step("load", {
  viewport: device.viewport,
  widgets: Object.keys(start).length,
  drag_handles: await page.locator("[data-drag-handle]").count(),
  resize_handles: await page.locator("[data-resize-handle]").count(),
  says_drag_to_arrange: (await page.getByText("Drag to arrange").count()) > 0,
  ...(await layout()),
  requests: takeRequests(),
});
await shot("0-loaded");

const ids = Object.keys(start);
const target = ids.includes("due-today") ? "due-today" : ids[0];
// A widget with room to grow to the right, so a resize can change the width too.
const roomy = ids.find((id) => !start[id].collapsed && start[id].x + start[id].w <= 10) ?? target;

// Drag a widget by its handle, 200 px down.
{
  const before = await stored();
  const topOf = async () => (await page.locator(`[data-widget="${target}"]`).boundingBox()).y + (await page.evaluate(() => window.scrollY));
  const top = await topOf();
  takeRequests();
  await drag(await center(`[data-drag-handle="${target}"]`), 0, 200);
  const after = await stored();
  step("drag", {
    widget: target,
    stored_before: before[target],
    stored_after: after[target],
    moved_on_screen_px: Math.round((await topOf()) - top),
    saved: !same(before[target], after[target]),
    requests: takeRequests(),
  });
  await shot("1-after-drag");
}

// Resize a widget by its corner grip, 130 px right and down; then Undo.
if ((await page.locator("[data-resize-handle]").count()) === 0) {
  step("resize", { possible: false, why: "no resize grip is drawn at this width" });
} else {
  const before = await stored();
  takeRequests();
  await drag(await center(`[data-resize-handle="${roomy}"]`), 130, 130);
  const after = await stored();
  step("resize", {
    widget: roomy,
    stored_before: before[roomy],
    stored_after: after[roomy],
    saved: !same(before[roomy], after[roomy]),
    requests: takeRequests(),
  });
  await shot("2-after-resize");

  const undo = await center('button:has-text("Undo")');
  await tap(undo.x, undo.y);
  const undone = await stored();
  step("undo", {
    widget: roomy,
    after_undo: undone[roomy],
    resize_undone: same(undone[roomy], before[roomy]),
    whole_board_back_to_before_resize: same(undone, before),
    requests: takeRequests(),
  });
  await shot("3-after-undo");
}

// Tap a widget: it should take the focus ring, and the board should remember it.
{
  const focused = (await board()).focusId;
  const other = ids.find((id) => id !== focused && !start[id].collapsed) ?? target;
  takeRequests();
  const title = page.locator(`[data-widget="${other}"] h2`);
  await title.scrollIntoViewIfNeeded();
  const b = await title.boundingBox();
  await tap(b.x + b.width / 2, b.y + b.height / 2);
  step("tap_to_focus", {
    widget: other,
    ring_on_screen: (await page.locator(`[data-widget="${other}"]`).getAttribute("data-focused")) === "true",
    stored_focus: (await board()).focusId,
    requests: takeRequests(),
  });
}

// Tick: recorded as not built. One tap on a task's circle, to show what a user gets.
{
  const row = page.locator(".wk-body li[data-check]").first();
  if (await row.count()) {
    await row.scrollIntoViewIfNeeded();
    const id = await row.getAttribute("data-check");
    const box = await row.boundingBox();
    const before = await taskStatus(id);
    takeRequests();
    await tap(box.x + 11, box.y + Math.min(22, box.height / 2));
    step("tick_not_built", {
      circle_px: await row.evaluate((el) => `${getComputedStyle(el, "::after").width} x ${getComputedStyle(el, "::after").height}`),
      task_status_before: before,
      task_status_after: await taskStatus(id),
      requests: takeRequests(),
    });
  }
}

// Collapse a widget with its own button.
{
  const before = await stored();
  takeRequests();
  const c = await center(`[data-collapse="${target}"]`);
  await tap(c.x, c.y);
  const after = await stored();
  step("collapse", { widget: target, collapsed_before: before[target].collapsed, collapsed_after: after[target].collapsed, requests: takeRequests() });
  await shot("4-after-collapse");
}

// Reload: what stayed.
{
  const before = await board();
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(2000);
  const after = await board();
  const geometry = (b) => b.widgets.map((w) => [w.id, w.x, w.y, w.w, w.h, !!w.collapsed]);
  step("reload", {
    geometry_kept: same(geometry(before), geometry(after)),
    focus_kept: before.focusId === after.focusId,
    [target]: (await stored())[target],
    ...(await layout()),
    requests: takeRequests(),
  });
  await shot("5-after-reload");
}

step("model_calls", {
  usage_rows_before: usageBefore,
  usage_rows_after: await usageRows(),
  every_request_seen: [...allRequests].sort(),
});
// Open the widget again so the next profile starts with it expanded.
await page.request.post("/api/workspace", { data: { operations: [{ op: "expand", id: target }] } });
await browser.close();
await db.end();
