// A real touch on an element's centre, once nothing is scrolling (SEC-A009).
// Taps within 150 ms of a scroll are scroll-stops the app deliberately
// ignores (isMomentumTap in components/dashboard/shared.tsx), and
// locator.tap() scrolls the element into view itself just before touching,
// so it is swallowed; at the scroll area's edge the fixed tab bar covers it.
// touchscreen.tap() never scrolls; the element is centred first.
import type { Locator, Page } from "@playwright/test";

export async function touch(page: Page, target: Locator) {
  await target.evaluate((el) => el.scrollIntoView({ block: "center", inline: "center" }));
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let quiet = setTimeout(done, 300);
        function bump() {
          clearTimeout(quiet);
          quiet = setTimeout(done, 300);
        }
        function done() {
          window.removeEventListener("scroll", bump, true);
          resolve();
        }
        window.addEventListener("scroll", bump, true);
      })
  );
  const box = await target.boundingBox();
  if (!box) throw new Error("nothing to touch: the element has no box");
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}
