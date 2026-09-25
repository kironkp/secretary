// Packets (docs/understanding/SPEC.md §6, documents per step): the documents
// a task's process asks for at each step, what has been filed against the
// task, and the one PDF that compiles them — so a CPO's forms are gathered
// here instead of in Adobe.
import { and, asc, eq, inArray } from "drizzle-orm";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "@/lib/db";
import { attachments, pipelineTemplates, taskDocuments, tasks } from "@/lib/db/schema";

/** "STD 65", "std-65" and "Std65" are one document name. */
export const docKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

export type PacketFile = { id: string; attachmentId: string; docType: string; name: string; mime: string; createdAt: string };
export type PacketStep = {
  name: string;
  done: boolean;
  /** Each document the step needs, and the files filed under it. */
  docs: { name: string; files: PacketFile[] }[];
};
export type Packet = {
  taskId: string;
  title: string;
  process: string | null;
  steps: PacketStep[];
  /** Files filed under a name no step asks for. */
  other: PacketFile[];
  missing: { step: string; doc: string }[];
};

type Stage = { name: string; done: boolean };

/**
 * The process a task was placed on: the template whose step names are the
 * task's stage names, in order (apply_pipeline copies them across).
 */
async function processFor(userId: string, stages: Stage[]) {
  if (!stages.length) return null;
  const rows = await db.select().from(pipelineTemplates).where(eq(pipelineTemplates.userId, userId));
  const names = stages.map((s) => docKey(s.name)).join("|");
  return rows.find((t) => (t.steps ?? []).map((s) => docKey(s.name)).join("|") === names) ?? null;
}

export async function getPacket(userId: string, taskId: string): Promise<Packet | null> {
  const [task] = await db
    .select({ id: tasks.id, title: tasks.title, stages: tasks.stages })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)));
  if (!task) return null;
  const stages: Stage[] = Array.isArray(task.stages) ? task.stages : [];
  const template = await processFor(userId, stages);

  const filed = await db
    .select({
      id: taskDocuments.id,
      attachmentId: taskDocuments.attachmentId,
      docType: taskDocuments.docType,
      createdAt: taskDocuments.createdAt,
      name: attachments.name,
      mime: attachments.mime,
    })
    .from(taskDocuments)
    .innerJoin(attachments, eq(attachments.id, taskDocuments.attachmentId))
    .where(and(eq(taskDocuments.userId, userId), eq(taskDocuments.taskId, taskId)))
    .orderBy(asc(taskDocuments.createdAt));
  const files: PacketFile[] = filed.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() }));

  const claimed = new Set<string>();
  const steps: PacketStep[] = stages.map((s, i) => {
    const wants = template?.steps?.[i]?.docs ?? [];
    return {
      name: s.name,
      done: s.done,
      docs: wants.map((doc) => {
        const mine = files.filter((f) => docKey(f.docType) === docKey(doc));
        mine.forEach((f) => claimed.add(f.id));
        return { name: doc, files: mine };
      }),
    };
  });
  const missing = steps.flatMap((s) => s.docs.filter((d) => d.files.length === 0).map((d) => ({ step: s.name, doc: d.name })));
  return {
    taskId: task.id,
    title: task.title,
    process: template?.name ?? null,
    steps,
    other: files.filter((f) => !claimed.has(f.id)),
    missing,
  };
}

/** File an attachment the user owns against a task, under a document name. */
export async function fileDocument(userId: string, taskId: string, attachmentId: string, docType: string) {
  const [att] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.userId, userId), eq(attachments.id, attachmentId)));
  if (!att) return null;
  const [row] = await db
    .insert(taskDocuments)
    .values({ userId, taskId, attachmentId, docType: docType.trim().slice(0, 80) })
    .returning();
  return row;
}

// --------------------------------------------------------------------------
// The compiled PDF
// --------------------------------------------------------------------------

const PAGE = { w: 612, h: 792 }; // US Letter, points
const MARGIN = 54;

/** Latin-1 only: the standard fonts cannot draw anything else. */
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

/**
 * One PDF: a cover page with the checklist, then every PDF and image in
 * process order (step, then the step's own document order, then other files).
 */
export async function compilePacket(userId: string, taskId: string): Promise<Uint8Array | null> {
  const packet = await getPacket(userId, taskId);
  if (!packet) return null;
  const ordered = [...packet.steps.flatMap((s) => s.docs.flatMap((d) => d.files)), ...packet.other];

  const bytes = ordered.length
    ? await db
        .select({ id: attachments.id, data: attachments.data })
        .from(attachments)
        .where(and(eq(attachments.userId, userId), inArray(attachments.id, ordered.map((f) => f.attachmentId))))
    : [];
  const dataOf = new Map(bytes.map((b) => [b.id, b.data as Buffer]));

  const out = await PDFDocument.create();
  out.setTitle(safe(packet.title));
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  // The cover is page one; the files' pages follow it, and the cover's
  // "not included" list is drawn last, once every file has been tried.
  const body: { add: () => Promise<void> }[] = [];
  const skipped: string[] = [];
  for (const f of ordered) {
    const data = dataOf.get(f.attachmentId);
    if (!data) continue;
    const isPdf = f.mime === "application/pdf" || /\.pdf$/i.test(f.name);
    const isPng = f.mime === "image/png";
    const isJpg = f.mime === "image/jpeg" || f.mime === "image/jpg";
    if (isPdf) {
      body.push({
        add: async () => {
          try {
            const src = await PDFDocument.load(data, { ignoreEncryption: true });
            const pages = await out.copyPages(src, src.getPageIndices());
            pages.forEach((p) => out.addPage(p));
          } catch {
            skipped.push(`${f.docType}: ${f.name} (could not be read)`);
          }
        },
      });
    } else if (isPng || isJpg) {
      body.push({
        add: async () => {
          const img = isPng ? await out.embedPng(data) : await out.embedJpg(data);
          const page = out.addPage([PAGE.w, PAGE.h]);
          const scale = Math.min((PAGE.w - 2 * MARGIN) / img.width, (PAGE.h - 2 * MARGIN) / img.height, 1);
          const w = img.width * scale;
          const h = img.height * scale;
          page.drawImage(img, { x: (PAGE.w - w) / 2, y: (PAGE.h - h) / 2, width: w, height: h });
        },
      });
    } else {
      skipped.push(`${f.docType}: ${f.name}`);
    }
  }

  const cover = out.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - MARGIN;
  const line = (text: string, opts: { size?: number; b?: boolean; color?: [number, number, number]; indent?: number } = {}) => {
    const size = opts.size ?? 11;
    if (y < MARGIN + size) return;
    cover.drawText(safe(text).slice(0, 110), {
      x: MARGIN + (opts.indent ?? 0),
      y,
      size,
      font: opts.b ? bold : font,
      color: rgb(...(opts.color ?? [0.1, 0.1, 0.12])),
    });
    y -= size + 7;
  };
  line(packet.title, { size: 18, b: true });
  if (packet.process) line(packet.process, { size: 11, color: [0.4, 0.4, 0.45] });
  y -= 8;
  for (const s of packet.steps) {
    if (!s.docs.length) continue;
    line(s.name, { b: true });
    for (const d of s.docs) {
      const have = d.files.length > 0;
      line(`${have ? "[x]" : "[ ]"}  ${d.name}${have ? "" : "  - missing"}`, {
        indent: 14,
        color: have ? [0.1, 0.45, 0.2] : [0.75, 0.15, 0.1],
      });
    }
    y -= 4;
  }
  if (packet.other.length) {
    line("Other files", { b: true });
    packet.other.forEach((f) => line(`${f.docType}: ${f.name}`, { indent: 14 }));
  }
  for (const b of body) await b.add();
  if (skipped.length) {
    y -= 6;
    line("Not included (not a PDF or image)", { b: true, color: [0.4, 0.4, 0.45] });
    skipped.forEach((s) => line(s, { indent: 14, color: [0.4, 0.4, 0.45] }));
  }
  return out.save();
}
