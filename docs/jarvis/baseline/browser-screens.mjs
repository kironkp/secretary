// Task 1.01: pictures of the four surfaces at a phone, a tablet and a desktop size, from
// a local build. A measurement tool, not product code. Chromium, because that
// is the browser Playwright can launch on this Mac (macOS 12); CI's WebKit
// run is the iPhone-shaped one.
//
//   BASE_URL=http://localhost:3112 STATE=<path>/state.json OUT=<dir> \
//     node docs/jarvis/baseline/browser-screens.mjs
import { mkdirSync } from "node:fs";
import { chromium, devices } from "@playwright/test";

const base = process.env.BASE_URL ?? "http://localhost:3112";
const out = process.env.OUT ?? "screens";
const executablePath =
  process.env.CHROMIUM ??
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1194/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;

const SCREENS = [
  ["workspace", "/workspace"],
  ["dashboard-overview", "/dashboard?view=adaptive"],
  ["dashboard-board", "/dashboard?view=board"],
  ["canvas", "/dashboard?view=canvas"],
];
const SIZES = [
  { name: "393x852", context: { ...devices["iPhone 15"], viewport: { width: 393, height: 852 } }, tall: 2600 },
  { name: "820x1180", context: { ...devices["iPad (gen 7)"], viewport: { width: 820, height: 1180 } }, tall: 2600 },
  { name: "1440x900", context: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, tall: 2600 },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath });
for (const size of SIZES) {
  const context = await browser.newContext({
    ...size.context,
    defaultBrowserType: undefined,
    storageState: process.env.STATE,
    baseURL: base,
  });
  for (const [name, path] of SCREENS) {
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.startsWith("/api/")) requests.push(`${r.method()} ${u.pathname}`);
    });
    const t0 = Date.now();
    // Pages that hold an event stream open never go network-idle.
    await page.goto(path, { waitUntil: "load" });
    await page.waitForTimeout(2500);
    const ms = Date.now() - t0 - 2500;
    await page.screenshot({ path: `${out}/${name}-${size.name}.png` });
    // The shell scrolls inside a fixed-height column, so a full-page shot
    // stops at the fold; a tall viewport shows what is below it.
    await page.setViewportSize({ width: size.context.viewport.width, height: size.tall });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${name}-${size.name.split("x")[0]}-tall.png` });
    console.log(
      JSON.stringify({
        screen: name,
        size: size.name,
        url: new URL(page.url()).pathname + new URL(page.url()).search,
        load_ms: ms,
        api_requests: [...new Set(requests)],
        errors,
      })
    );
    await page.close();
  }
  await context.close();
}
await browser.close();
