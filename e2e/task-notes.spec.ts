// A model write never loses his notes (v1.17, docs/tasks/SPEC.md §1.5, §1.6), at 390 wide. He types a note in the
// editor (or in the view's note); while it is open a chat turn adds a line (the real /api/chat, answered by the
// model stand-in, e2e/model-standin.mjs, which calls amend_task) and a call adds one (the real tool route a call
// uses); he saves. Everything is kept, his text first. And a blocked task shows what it is waiting on.
import { existsSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function tool(request: APIRequestContext, name: string, args: Record<string, unknown>) {
  const res = await request.post("/api/secretary/tools", { data: { name, args } });
  expect(res.ok(), `${name} answered`).toBe(true);
  return ((await res.json()) as { result: Record<string, unknown> }).result;
}
const notesOf = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`/api/tasks/${id}`)).json()) as { task: { notes: string | null } }).task.notes;
async function openTask(page: Page, id: string) {
  await page.goto("/today");
  await page.waitForLoadState("load");
  // The dialog listens once the page has hydrated; until then the event goes nowhere, so it is sent until it opens.
  await expect(async () => {
    await page.evaluate((taskId) => window.dispatchEvent(new CustomEvent("secretary:open-detail", { detail: { kind: "task", id: taskId } })), id);
    await expect(page.getByRole("button", { name: "Edit task" })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}
/** A chat turn on the stand-in that adds a line to the task's note, through the real chat route. */
async function chatAdds(request: APIRequestContext, id: string, line: string) {
  const res = await request.post("/api/chat", { data: { message: `Add to the note of task ${id}: ${line}` } });
  expect(res.ok(), "the chat turn answered").toBe(true);
  expect(await notesOf(request, id), "the chat turn's line is on the task").toContain(line);
}

// The chat turns run on a Claude model, which the server sends to the stand-in; back to the default after. First:
// the app server must be one this run started (playwright.config.ts marks it). Locally Playwright reuses a server
// already on the port, and that one's chat could reach a real model: then nothing here runs (v1.10).
test.beforeAll(async ({ request }) => {
  expect(
    existsSync(`e2e/.runs/${process.env.E2E_RUN_ID}`),
    "the app server was started by this run, not reused (a reused one's chat turn could reach a real model)"
  ).toBe(true);
  expect((await request.post("/api/persona", { data: { chatModel: "claude-sonnet-5" } })).ok()).toBe(true);
});
test.afterAll(async ({ request }) => {
  await request.post("/api/persona", { data: { chatModel: "gpt-5.5" } });
});

const HIS = "Corrugated, 8 ft long.\nGate code: 4412\nÉtagère — café.";

test("the editor: what a chat turn and a call added while it was open is kept after his text", async ({ page, request }) => {
  const made = await tool(request, "create_task", { title: `Order the roof panels ${Date.now()}` });
  const id = String(made.task_id);
  await openTask(page, id);
  await page.getByRole("button", { name: "Edit task" }).click();
  const notes = page.getByPlaceholder("Anything worth remembering about this…");
  await notes.fill(HIS);

  await chatAdds(request, id, "Chat: ask about delivery.");
  await tool(request, "amend_task", { task: id, note: "Voice: the van is free Friday." });

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit task" })).toBeHidden();
  expect(await notesOf(request, id)).toBe(`${HIS}\nChat: ask about delivery.\nVoice: the van is free Friday.`);
  await expect(page.getByText("Voice: the van is free Friday.")).toBeVisible();
});

test("the view's own note: a line a call added while he typed is kept after his text", async ({ page, request }) => {
  const made = await tool(request, "create_task", { title: `Paint the shed door ${Date.now()}` });
  const id = String(made.task_id);
  await tool(request, "amend_task", { task: id, note: "Use the green from the porch." });
  await openTask(page, id);
  await page.getByTitle("Edit notes").click();
  const box = page.getByPlaceholder("Type a note…");
  await box.fill("Two coats.\nSand it first.");

  await tool(request, "amend_task", { task: id, note: "Voice: the brush is in the shed." });

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(box).toBeHidden();
  expect(await notesOf(request, id)).toBe("Two coats.\nSand it first.\nVoice: the brush is in the shed.");
});

test("a blocked task shows what it is waiting on, and its note is untouched", async ({ page, request }) => {
  const made = await tool(request, "create_task", { title: `Move the compost bin ${Date.now()}`, notes: "By the back fence." });
  const id = String(made.task_id);
  await tool(request, "log_status", { task: id, signal: "blocked", note: "the neighbour's answer" });
  await openTask(page, id);
  await expect(page.getByText("Waiting on", { exact: true })).toBeVisible();
  await expect(page.getByText("the neighbour's answer")).toBeVisible();
  expect(await notesOf(request, id)).toBe("By the back fence.");
});

// v1.10: two things 1.17 did right that nothing caught a version breaking (the Reviewer's probe).
test("the editor: a line he deletes stays gone, and a line a call adds while it is open stays", async ({ page, request }) => {
  const made = await tool(request, "create_task", { title: `Hang the shed door ${Date.now()}`, notes: "Measure the gap.\nBuy screws.\nCall the yard." });
  const id = String(made.task_id);
  await openTask(page, id);
  await page.getByRole("button", { name: "Edit task" }).click();
  await page.getByPlaceholder("Anything worth remembering about this…").fill("Measure the gap.\nCall the yard.");
  await tool(request, "amend_task", { task: id, note: "Voice: the van is free Friday." });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit task" })).toBeHidden();
  expect(await notesOf(request, id)).toBe("Measure the gap.\nCall the yard.\nVoice: the van is free Friday.");
});

test("\"Waiting on\" shows only while the task is blocked", async ({ page, request }) => {
  const made = await tool(request, "create_task", { title: `Move the compost bin ${Date.now()}` });
  const id = String(made.task_id);
  await tool(request, "log_status", { task: id, signal: "blocked", note: "the neighbour's answer" });
  await openTask(page, id);
  await expect(page.getByText("Waiting on", { exact: true })).toBeVisible();
  // Taken off blocked by the route, which keeps the reason it had: it is not waiting on it now.
  expect((await request.patch(`/api/tasks/${id}`, { data: { status: "todo" } })).ok()).toBe(true);
  expect(((await (await request.get(`/api/tasks/${id}`)).json()) as { task: { blockedReason: string | null } }).task.blockedReason).toBe(
    "the neighbour's answer"
  );
  await openTask(page, id);
  await expect(page.getByText("Waiting on", { exact: true })).toHaveCount(0);
});

// v1.10 r2, the Reviewer's verdict on e1da4b0.
test("Done with a note draft open saves it, and a line a call added meanwhile is kept after it", async ({ page, request }) => {
  const made = await tool(request, "create_task", { title: `Paint the shed door ${Date.now()}`, notes: "Sand it first." });
  const id = String(made.task_id);
  await openTask(page, id);
  await page.getByTitle("Edit notes").click();
  await page.getByPlaceholder("Type a note…").fill("Two coats.\nSand it first.");
  await tool(request, "amend_task", { task: id, note: "Voice: the brush is in the shed." });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("[data-task-screen]")).toHaveCount(0);
  expect(await notesOf(request, id)).toBe("Two coats.\nSand it first.\nVoice: the brush is in the shed.");
});

test("a labelled note from a chat turn (the real chat route, a live turn) is not saved", async ({ request }) => {
  const made = await tool(request, "create_task", { title: `Paint the fence ${Date.now()}`, notes: "Two coats." });
  const id = String(made.task_id);
  const res = await request.post("/api/chat", { data: { message: `Add to the note of task ${id}: Owner: Sam` } });
  expect(res.ok(), "the chat turn answered").toBe(true);
  expect(await notesOf(request, id)).toBe("Two coats.");
  // The same route with a plain line: it lands, so the turn above did reach the tool.
  await chatAdds(request, id, "They deliver on Fridays.");
  expect(await notesOf(request, id)).toBe("Two coats.\nThey deliver on Fridays.");
});
