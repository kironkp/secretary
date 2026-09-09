// The attachment serving route is the security boundary now that any file type
// can be uploaded: only raster images and PDFs come back renderable, and
// everything else must be opaque bytes the browser will never parse as a
// document. This test exists so widening the upload path can never quietly
// widen what gets served inline.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

const U = { id: `att-serve-${crypto.randomUUID()}`, email: `att-${crypto.randomUUID()}@test.local` };

// The route only needs an authenticated owner; auth itself is covered elsewhere.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    requireSession: async () => ({ id: U.id, email: U.email, name: "Att Tester", timezone: "UTC" }),
  };
});

const { db } = await import("@/lib/db");
const { attachments, user } = await import("@/lib/db/schema");
const { GET } = await import("@/app/api/attachments/[id]/route");

async function store(mime: string, name: string, body = "x") {
  const [row] = await db
    .insert(attachments)
    .values({ userId: U.id, mime, name, data: Buffer.from(body) })
    .returning({ id: attachments.id });
  return row.id;
}

const fetchAttachment = (id: string, query = "") =>
  GET(new Request(`http://localhost/api/attachments/${id}${query}`), {
    params: Promise.resolve({ id }),
  });

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Att Tester", email: U.email });
});

afterAll(async () => {
  await db.delete(attachments).where(eq(attachments.userId, U.id));
  await db.delete(user).where(eq(user.id, U.id));
});

describe("serving attachments", () => {
  it("serves a raster image inline under its own type", async () => {
    const res = await fetchAttachment(await store("image/png", "shot.png"));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves a pdf inline so preview keeps working", async () => {
    const res = await fetchAttachment(await store("application/pdf", "bill.pdf"));
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("inline");
  });

  it("never serves html as a document — this is the stored-XSS fence", async () => {
    const id = await store("text/html", "evil.html", "<script>alert(document.cookie)</script>");
    const res = await fetchAttachment(id);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("never serves svg as a document either", async () => {
    const res = await fetchAttachment(await store("image/svg+xml", "evil.svg", "<svg/>"));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("downloads a spreadsheet under its real filename", async () => {
    const xlsx = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const res = await fetchAttachment(await store(xlsx, "Weekly Status Report.xlsx"));
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain('filename="Weekly Status Report.xlsx"');
    expect(cd).toContain("filename*=UTF-8''Weekly%20Status%20Report.xlsx");
  });

  it("honours ?download=1 on an otherwise previewable type", async () => {
    const id = await store("image/png", "shot.png");
    expect((await fetchAttachment(id, "?download=1")).headers.get("content-disposition")).toContain(
      "attachment"
    );
  });

  it("returns the bytes unchanged", async () => {
    const res = await fetchAttachment(await store("text/plain", "a.txt", "hello world"));
    expect(await res.text()).toBe("hello world");
  });

  it("404s for an id the user does not own", async () => {
    const [other] = await db
      .insert(user)
      .values({
        id: `att-other-${crypto.randomUUID()}`,
        name: "Someone Else",
        email: `other-${crypto.randomUUID()}@test.local`,
      })
      .returning({ id: user.id });
    const [row] = await db
      .insert(attachments)
      .values({ userId: other.id, mime: "image/png", name: "theirs.png", data: Buffer.from("x") })
      .returning({ id: attachments.id });

    expect((await fetchAttachment(row.id)).status).toBe(404);

    await db.delete(attachments).where(eq(attachments.userId, other.id));
    await db.delete(user).where(eq(user.id, other.id));
  });
});
