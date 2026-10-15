// A model write never loses his notes (v1.17, docs/tasks/SPEC.md §1.5, §1.6), at 390 wide. He types a note in the
// editor (or in the view's note); while it is open a chat turn adds a line (the real /api/chat, answered by the
// model stand-in, e2e/model-standin.mjs, which calls amend_task) and a call adds one (the real tool route a call
// uses); he saves. Everything is kept, his text first. And a blocked task shows what it is waiting on.
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

// The chat turns run on a Claude model, which the server sends to the stand-in; back to the default after.
test.beforeAll(async ({ request }) => {
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
