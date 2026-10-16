// A task reads like a reminder (v1.10, docs/tasks/SPEC.md §2.4): the task screen at 390 wide against the approved
// 1-task.html, its top half. Computed styles per role against the spec's values table, the order of what is on it,
// 44 x 44 hit boxes, dark at 4.5:1, no priority anywhere he sees, "More" collapsed on every open, the done circle
// (once for a recurring task), an old "Suggested:" note shown without its prefix. Made-up tasks, made through the
// tool route a call uses; screenshots in screenshots/ (the CI artifact).
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
const DIR = "screenshots";

async function tool(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const res = await request.post("/api/secretary/tools", { data: { name, args } });
  expect(res.ok(), `${name} answered`).toBe(true);
  return ((await res.json()) as { result: Record<string, unknown> }).result;
}
const taskOf = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`/api/tasks/${id}`)).json()) as { task: Record<string, unknown> }).task;
const patch = (request: APIRequestContext, id: string, data: Record<string, unknown>) => request.patch(`/api/tasks/${id}`, { data });
async function openTask(page: Page, id: string) {
  await page.goto("/today");
  await page.waitForLoadState("load");
  await expect(async () => {
    await page.evaluate((taskId) => window.dispatchEvent(new CustomEvent("secretary:open-detail", { detail: { kind: "task", id: taskId } })), id);
    await expect(page.locator("[data-task-screen]")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.locator("[data-task-title]")).toBeVisible();
}
const stamp = () => Date.now().toString(36);
const inDays = (n: number, hour = 9) => {
  const d = new Date(Date.now() + n * 86_400_000);
  d.setHours(hour, 0, 0, 0);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00:00`;
};

/** The shed task of the mockup, made up: a note, a due date, a reminder, a project. */
async function shedTask(request: APIRequestContext) {
  const made = await tool(request, "create_task", {
    title: `Order the shed roof panels ${stamp()}`,
    notes: "Corrugated, 8 ft long. Ask if they deliver to the side gate.",
    due_at: inDays(2),
    project: `Garden shed ${stamp()}`,
  });
  const id = String(made.task_id);
  await patch(request, id, { reminders: [new Date(Date.now() + 86_400_000).toISOString()] });
  return id;
}

test("the screen against 1-task.html: each role's values (light)", async ({ page, request }) => {
  const id = await shedTask(request);
  await openTask(page, id);
  const v = await page.evaluate(() => {
    const q = (s: string) => document.querySelector(s) as HTMLElement | null;
    const cs = (s: string) => {
      const el = q(s);
      return el ? getComputedStyle(el) : null;
    };
    const box = (s: string) => {
      const r = q(s)?.getBoundingClientRect();
      return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    const rows = [...document.querySelectorAll("[data-task-row]")].map((r) => {
      const s = getComputedStyle(r);
      const icon = r.querySelector("[data-row-icon]")!.getBoundingClientRect();
      return {
        row: r.getAttribute("data-task-row"),
        h: Math.round(r.getBoundingClientRect().height),
        pad: [s.paddingLeft, s.paddingRight],
        gap: s.columnGap,
        border: s.borderTopWidth === "0px" ? null : `${s.borderTopWidth} ${s.borderTopColor}`,
        icon: { w: Math.round(icon.width), h: Math.round(icon.height) },
        label: { size: getComputedStyle(r.querySelector("[data-row-label]")!).fontSize, color: getComputedStyle(r.querySelector("[data-row-label]")!).color },
        value: { size: getComputedStyle(r.querySelector("[data-row-value]")!).fontSize, color: getComputedStyle(r.querySelector("[data-row-value]")!).color },
      };
    });
    return {
      ground: cs("[data-task-screen]")?.backgroundColor,
      header: { h: box("[data-task-header]")?.h, pad: [cs("[data-task-header]")?.paddingLeft, cs("[data-task-header]")?.paddingRight] },
      heading: { size: cs("[data-task-header-title]")?.fontSize, weight: cs("[data-task-header-title]")?.fontWeight, color: cs("[data-task-header-title]")?.color },
      done: { ...box("[data-task-done]"), size: cs("[data-task-done]")?.fontSize, weight: cs("[data-task-done]")?.fontWeight, color: cs("[data-task-done]")?.color },
      titleCard: { bg: cs("[data-task-card='title']")?.backgroundColor, radius: cs("[data-task-card='title']")?.borderTopLeftRadius, pad: cs("[data-task-card='title']")?.padding, box: box("[data-task-card='title']") },
      rowsCard: { bg: cs("[data-task-card='rows']")?.backgroundColor, radius: cs("[data-task-card='rows']")?.borderTopLeftRadius, box: box("[data-task-card='rows']") },
      circle: { box: box("[data-task-circle]"), glyph: box("[data-task-circle] svg"), stroke: cs("[data-task-circle] svg")?.stroke },
      title: { size: cs("[data-task-title-text]")?.fontSize, line: cs("[data-task-title-text]")?.lineHeight, weight: cs("[data-task-title-text]")?.fontWeight, color: cs("[data-task-title-text]")?.color, box: box("[data-task-title-text]") },
      note: { size: cs("[data-task-note-text]")?.fontSize, line: cs("[data-task-note-text]")?.lineHeight, color: cs("[data-task-note-text]")?.color, box: box("[data-task-note-text]") },
      rows,
      dot: box("[data-task-row='project'] [data-project-dot]"),
      chevron: box("[data-task-row='project'] [data-row-chevron]"),
    };
  });
  expect(v.ground).toBe("rgb(242, 242, 247)");
  expect(v.header).toEqual({ h: 56, pad: ["16px", "8px"] });
  expect(v.heading).toEqual({ size: "17px", weight: "600", color: "rgb(28, 28, 30)" });
  expect(v.done).toMatchObject({ size: "17px", weight: "600", color: "rgb(58, 91, 208)", h: 44 });
  expect(v.done.w).toBeGreaterThanOrEqual(64);
  expect(v.titleCard).toMatchObject({ bg: "rgb(255, 255, 255)", radius: "12px", pad: "6px 16px 16px 6px" });
  expect(v.titleCard.box!.x, "16 px gutter").toBe(16);
  expect(v.titleCard.box!.w, "the width less the two gutters (the iPhone profile is 393 wide)").toBe(page.viewportSize()!.width - 32);
  expect(v.rowsCard).toMatchObject({ bg: "rgb(255, 255, 255)", radius: "12px" });
  expect(v.rowsCard.box!.y - (v.titleCard.box!.y + v.titleCard.box!.h), "cards 16 apart").toBe(16);
  expect(v.circle.box).toMatchObject({ w: 44, h: 44, x: 16 + 6, y: v.titleCard.box!.y + 6 });
  expect(v.circle.glyph).toMatchObject({ w: 24, h: 24 });
  expect(v.circle.stroke).toBe("rgb(110, 110, 115)");
  expect(v.title).toMatchObject({ size: "20px", line: "24px", weight: "600", color: "rgb(28, 28, 30)" });
  // The title sits level with the circle, as in the mockup (padding-top 10 in a card padded 6 at the top).
  expect(v.title.box!.y - v.titleCard.box!.y).toBe(16);
  expect(v.title.box!.x - v.titleCard.box!.x, "after the 44 circle and the gap of 2").toBe(6 + 44 + 2);
  expect(v.note).toMatchObject({ size: "16px", line: "22px", color: "rgb(110, 110, 115)" });
  expect(v.rows.map((r) => r.row)).toEqual(["due", "remind", "project"]);
  v.rows.forEach((r, i) => {
    expect(r.h, `${r.row} at least 48 tall`).toBeGreaterThanOrEqual(48);
    expect(r.pad, r.row!).toEqual(["16px", "16px"]);
    expect(r.gap, r.row!).toBe("12px");
    expect(r.icon, r.row!).toEqual({ w: 22, h: 22 });
    expect(r.label, r.row!).toEqual({ size: "16px", color: "rgb(28, 28, 30)" });
    expect(r.value, r.row!).toEqual({ size: "16px", color: "rgb(110, 110, 115)" });
    expect(r.border, `${r.row}: a separator above every row but the first`).toBe(i === 0 ? null : "1px rgba(60, 60, 67, 0.18)");
  });
  expect(v.dot).toMatchObject({ w: 12, h: 12 });
  expect(v.chevron).toMatchObject({ w: 16, h: 16 });
  await page.screenshot({ path: `${DIR}/task-390.png` });
});

test("what is on it, in order: Task and Done; the circle, title and note; Due, Remind me, Project; More last", async ({ page, request }) => {
  const id = await shedTask(request);
  await openTask(page, id);
  const order = await page.locator("[data-task-screen] [data-order]").evaluateAll((els) => els.map((e) => e.getAttribute("data-order")));
  expect(order).toEqual(["header", "circle", "title", "note", "due", "remind", "project", "more"]);
  await expect(page.locator("[data-task-header-title]")).toHaveText("Task");
  await expect(page.locator("[data-task-row='due'] [data-row-label]")).toHaveText("Due");
  await expect(page.locator("[data-task-row='remind'] [data-row-label]")).toHaveText("Remind me");
  await expect(page.locator("[data-task-row='project'] [data-row-label]")).toHaveText("Project");
  // No "Notes" label: the note is plain text under the title.
  await expect(page.locator("[data-task-screen]")).not.toContainText("Notes");
});

test("every touch target is a 44 x 44 hit box", async ({ page, request }) => {
  const id = await shedTask(request);
  await openTask(page, id);
  const boxes = await page.locator("[data-task-screen] button, [data-task-screen] [role='button'], [data-task-screen] input").evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => {
        const r = e.getBoundingClientRect();
        // An input drawn over a row takes the row's taps: its hit box is the row's.
        return { what: e.getAttribute("aria-label") ?? e.textContent?.trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height) };
      })
  );
  expect(boxes.length).toBeGreaterThan(5);
  for (const b of boxes) {
    expect(b.w, `${b.what} wide`).toBeGreaterThanOrEqual(44);
    expect(b.h, `${b.what} tall`).toBeGreaterThanOrEqual(44);
  }
});

test("dark: the same roles on the dark tokens, text at 4.5:1", async ({ page, request, baseURL }) => {
  await page.context().addCookies([{ name: "theme", value: "dark", url: baseURL! }]);
  const id = await shedTask(request);
  await openTask(page, id);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  const ratios = await page.evaluate(() => {
    const rgb = (s: string) => (s.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (fg: string, bg: string) => {
      const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    };
    const color = (s: string) => getComputedStyle(document.querySelector(s)!).color;
    const ground = getComputedStyle(document.querySelector("[data-task-screen]")!).backgroundColor;
    const card = getComputedStyle(document.querySelector("[data-task-card='title']")!).backgroundColor;
    return {
      heading: ratio(color("[data-task-header-title]"), ground),
      done: ratio(color("[data-task-done]"), ground),
      title: ratio(color("[data-task-title-text]"), card),
      note: ratio(color("[data-task-note-text]"), card),
      label: ratio(color("[data-task-row='due'] [data-row-label]"), card),
      value: ratio(color("[data-task-row='due'] [data-row-value]"), card),
      ground,
      card,
    };
  });
  expect(ratios.ground).not.toBe("rgb(242, 242, 247)");
  for (const [what, r] of Object.entries(ratios)) if (typeof r === "number") expect(r, what).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: `${DIR}/task-390-dark.png` });
  await page.context().clearCookies({ name: "theme" });
});

test("no priority: not in the view or the editor for a priority-3 task, and an editor save leaves it 3", async ({ page, request }) => {
  const id = await shedTask(request);
  expect((await patch(request, id, { priority: 3 })).ok()).toBe(true);
  await openTask(page, id);
  await page.locator("[data-task-more]").click();
  await expect(page.locator("[data-task-screen]")).not.toContainText(/priority|high/i);
  await page.locator("[data-task-title]").click();
  await expect(page.getByRole("heading", { name: "Edit task" })).toBeVisible();
  await expect(page.getByText("Priority", { exact: true })).toHaveCount(0);
  const sent: string[] = [];
  page.on("request", (r) => r.method() === "PATCH" && r.url().includes(`/api/tasks/${id}`) && sent.push(r.postData() ?? ""));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit task" })).toBeHidden();
  expect(sent.length).toBe(1);
  expect(JSON.parse(sent[0])).not.toHaveProperty("priority");
  expect((await taskOf(request, id)).priority).toBe(3);
});

test("More is collapsed on every open, and holds Status, Stages, the packet, Heard, From and History in that order", async ({ page, request }) => {
  const made = await tool(request, "create_task", { title: `Draft the shed plan ${stamp()}`, stages: ["Measure", "Sketch"] });
  const id = String(made.task_id);
  await tool(request, "update_task", { task: id, status: "in_progress" });
  await openTask(page, id);
  const more = page.locator("[data-task-more]");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("[data-task-more-body]")).toHaveCount(0);
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const parts = await page.locator("[data-task-more-body] [data-more-part]").evaluateAll((els) => els.map((e) => e.getAttribute("data-more-part")));
  expect(parts.filter((p) => p !== "packet")).toEqual(["status", "stages", "heard", "from", "history"]);
  // Closed with Done and opened again on the same page: collapsed again.
  await page.locator("[data-task-done]").click();
  await expect(page.locator("[data-task-screen]")).toHaveCount(0);
  await page.evaluate((taskId) => window.dispatchEvent(new CustomEvent("secretary:open-detail", { detail: { kind: "task", id: taskId } })), id);
  await expect(page.locator("[data-task-more]")).toHaveAttribute("aria-expanded", "false");
});

test("the circle completes a task the way complete_task does; a done task that doesn't recur reopens", async ({ page, request }) => {
  const made = await tool(request, "create_task", { title: `Sweep the porch ${stamp()}` });
  const id = String(made.task_id);
  await openTask(page, id);
  await page.getByRole("button", { name: "Mark done" }).click();
  await expect(page.getByRole("button", { name: "Mark not done" })).toBeVisible();
  const done = await (await request.get(`/api/tasks/${id}`)).json();
  expect(done.task.status).toBe("done");
  // The checkin complete_task writes, with where it came from, as the route has always said it.
  expect(done.history.map((h: { note: string }) => h.note)).toContain("Marked done from task");
  await page.getByRole("button", { name: "Mark not done" }).click();
  await expect(page.getByRole("button", { name: "Mark done" })).toBeVisible();
  const open = await taskOf(request, id);
  expect(open.status).toBe("todo");
  expect(open.completedAt, "reopened, it is not done any more").toBeNull();
});

test("a recurring task: the circle makes its next copy once, and done it is not a button", async ({ page, request }) => {
  const title = `Water the seedlings ${stamp()}`;
  const made = await tool(request, "create_task", { title, due_at: inDays(1), recurrence: "weekly" });
  const id = String(made.task_id);
  await openTask(page, id);
  await page.getByRole("button", { name: "Mark done" }).click();
  await expect(page.locator("[data-task-circle][data-done='true']")).toBeVisible();
  await expect(page.getByRole("button", { name: /Mark (not )?done/ })).toHaveCount(0);
  const open = ((await tool(request, "get_tasks", { status: "todo" })) as unknown as { title: string }[]).filter((t) => t.title === title);
  expect(open.length, "one next copy").toBe(1);
});

test("an old 'Suggested:' note is shown without the prefix and stored unchanged", async ({ page, request }) => {
  const made = await tool(request, "create_task", { title: `Clean the gutters ${stamp()}` });
  const id = String(made.task_id);
  expect((await patch(request, id, { notes: "Suggested: leaves are piling up before the rain." })).ok()).toBe(true);
  await openTask(page, id);
  await expect(page.locator("[data-task-note-text]")).toHaveText("leaves are piling up before the rain.");
  expect((await taskOf(request, id)).notes).toBe("Suggested: leaves are piling up before the rain.");
});

test("wider than a phone: the same content in a dialog at most 420 wide", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const id = await shedTask(request);
  await openTask(page, id);
  const w = await page.locator("[data-task-screen]").evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeLessThanOrEqual(420);
  await expect(page.locator("[data-task-row]")).toHaveCount(3);
});

// The Reviewer, on the old dialog: its row labels were #8e8e93 on white (3.26:1), and its Due field ran past the
// row's edge at 390. On this screen, with More open: every piece of text at 4.5:1 or better, light and dark, and
// nothing past its card's edges.
for (const theme of ["light", "dark"] as const) {
  test(`${theme}: every piece of text on it, More open, at 4.5:1 or better`, async ({ page, request, baseURL }) => {
    if (theme === "dark") await page.context().addCookies([{ name: "theme", value: "dark", url: baseURL! }]);
    const made = await tool(request, "create_task", { title: `Draft the shed plan ${stamp()}`, notes: "Two pages.", stages: ["Measure", "Sketch"], due_at: inDays(3) });
    const id = String(made.task_id);
    await tool(request, "update_task", { task: id, status: "in_progress" });
    await openTask(page, id);
    await page.locator("[data-task-more]").click();
    await expect(page.locator("[data-task-more-body]")).toBeVisible();
    const low = await page.locator("[data-task-screen]").evaluate((screen) => {
      const rgba = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => {
        const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (fg: number[], bg: number[]) => {
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
      };
      /** The colour behind an element: the nearest ancestor (or itself) with a background that is not see-through. */
      const behind = (el: Element) => {
        for (let e: Element | null = el; e; e = e.parentElement) {
          const c = rgba(getComputedStyle(e).backgroundColor);
          if (c.length >= 3 && (c[3] ?? 1) > 0.5) return c;
        }
        return [255, 255, 255];
      };
      const out: string[] = [];
      for (const el of screen.querySelectorAll("*")) {
        const own = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
        const r = el.getBoundingClientRect();
        if (!own || r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden" || getComputedStyle(el).opacity === "0") continue;
        const x = ratio(rgba(getComputedStyle(el).color), behind(el));
        if (x < 4.5) out.push(`${(el.textContent ?? "").trim().slice(0, 24)}: ${x.toFixed(2)}`);
      }
      return out;
    });
    expect(low, "text under 4.5:1").toEqual([]);
    if (theme === "dark") await page.context().clearCookies({ name: "theme" });
  });
}

test("nothing runs past its card's edges at phone width, More open, with long words in it", async ({ page, request }) => {
  const made = await tool(request, "create_task", {
    title: `Order the corrugated roof panels for the garden shed and the lean-to ${stamp()}`,
    notes: "Corrugated, 8 ft long. Ask if they deliver to the side gate, and whether they take the old ones away.",
    due_at: inDays(2, 17),
    project: `The garden shed and the fence along the back ${stamp()}`,
  });
  const id = String(made.task_id);
  await patch(request, id, { reminders: [new Date(Date.now() + 86_400_000).toISOString(), new Date(Date.now() + 2 * 86_400_000).toISOString()] });
  await openTask(page, id);
  await page.locator("[data-task-more]").click();
  const past = await page.locator("[data-task-card]").evaluateAll((cards) =>
    cards.flatMap((card) => {
      const c = card.getBoundingClientRect();
      return [...card.querySelectorAll("*")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > c.right + 0.5 || r.left < c.left - 0.5);
        })
        .map((el) => `${card.getAttribute("data-task-card")}: ${el.tagName} ${(el.textContent ?? "").trim().slice(0, 20)}`);
    })
  );
  expect(past).toEqual([]);
  const width = page.viewportSize()!.width;
  const screenWide = await page.locator("[data-task-screen]").evaluate((el) => el.scrollWidth);
  expect(screenWide, "no sideways scroll").toBeLessThanOrEqual(width);
});
