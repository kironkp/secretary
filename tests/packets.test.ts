// Packets (docs/understanding/SPEC.md §6, documents per step): Kiron,
// 2026-09-25 — "for each CPO… upload the documents… this is what I'm missing
// for each step… compile it in here instead of doing it in Adobe."
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { db } from "@/lib/db";
import { attachments, pipelineTemplates, user } from "@/lib/db/schema";
import { compilePacket, docKey, getPacket } from "@/lib/secretary/packets";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-packet-${crypto.randomUUID()}`, email: `packet-${Date.now()}@p7.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };
const STEPS = ["Get vendor quotes", "Fill out the Advantage form", "Pay with the Cal card", "Reconcile on Advantage"];
let taskId = "";

/** A real one-page PDF, and a real 1x1 PNG. */
async function onePagePdf(): Promise<Buffer> {
  const d = await PDFDocument.create();
  d.addPage([300, 300]);
  return Buffer.from(await d.save());
}
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
async function upload(name: string, mime: string, data: Buffer) {
  const [row] = await db.insert(attachments).values({ userId: U.id, name, mime, data }).returning({ id: attachments.id });
  return row.id;
}

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Packet Tester", email: U.email, timezone: ctx.timezone });
  await executeTool(ctx, "save_pipeline_template", {
    name: "CPO purchase cycle",
    steps: STEPS.map((name, i) => ({ name, blocked_by: i === 0 ? null : i - 1 })),
  });
  const created = await executeTool(ctx, "create_task", { title: "CPO 2110 lenses" });
  taskId = (created.result as { task_id?: string; id?: string }).task_id ?? (created.result as { id: string }).id;
  await executeTool(ctx, "apply_pipeline", { task: taskId, template: "CPO purchase cycle" });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("packets", () => {
  it("document names match loosely", () => {
    expect(docKey("STD 65")).toBe(docKey("std-65"));
    expect(docKey("Seller's permit")).toBe(docKey("sellers permit"));
  });

  it("set_step_documents gives a step its documents, and the task shows them missing", async () => {
    await executeTool(ctx, "set_step_documents", { process: "CPO purchase", step: 2, documents: ["STD 65", "Seller's permit"] });
    await executeTool(ctx, "set_step_documents", { process: "CPO purchase cycle", step: 4, documents: ["ADM 2029"] });
    const status = (await executeTool(ctx, "packet_status", { task: taskId })).result as {
      process: string;
      steps: { step: string; have: string[]; missing: string[] }[];
    };
    expect(status.process).toBe("CPO purchase cycle");
    expect(status.steps).toEqual([
      { step: "Fill out the Advantage form", have: [], missing: ["STD 65", "Seller's permit"] },
      { step: "Reconcile on Advantage", have: [], missing: ["ADM 2029"] },
    ]);
  });

  it("file_document files the latest upload under a name, matched loosely", async () => {
    await upload("std65.pdf", "application/pdf", await onePagePdf());
    const r = (await executeTool(ctx, "file_document", { task: "2110", doc_type: "std-65" })).result as {
      filed: boolean;
      still_missing: string[];
    };
    expect(r.filed).toBe(true);
    expect(r.still_missing).toEqual(["Seller's permit (Fill out the Advantage form)", "ADM 2029 (Reconcile on Advantage)"]);
  });

  it("compiles one PDF: a cover, then each PDF's pages and each image as a page; others named, not included", async () => {
    const png = await upload("permit.png", "image/png", PNG);
    await executeTool(ctx, "file_document", { task: taskId, doc_type: "Seller's permit", attachment: png });
    const xlsx = await upload("budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Buffer.from("x"));
    await executeTool(ctx, "file_document", { task: taskId, doc_type: "Budget sheet", attachment: xlsx });
    const packet = await getPacket(U.id, taskId);
    expect(packet!.other.map((f) => f.docType)).toEqual(["Budget sheet"]);
    const pdf = await compilePacket(U.id, taskId);
    const doc = await PDFDocument.load(pdf!);
    expect(doc.getPageCount()).toBe(3); // cover + STD 65's page + the permit image
  });

  it("saving the process again keeps each step's documents", async () => {
    await executeTool(ctx, "save_pipeline_template", {
      name: "CPO purchase cycle",
      steps: STEPS.map((name, i) => ({ name, blocked_by: i === 0 ? null : i - 1 })),
    });
    const [tpl] = await db.select().from(pipelineTemplates).where(eq(pipelineTemplates.userId, U.id));
    expect(tpl.steps[1].docs).toEqual(["STD 65", "Seller's permit"]);
    expect(tpl.steps[3].docs).toEqual(["ADM 2029"]);
  });
});
