// Attachment classification + safe-serving helpers (lib/attachments.ts).
// These rules replaced the upload MIME allowlist, so they are the thing
// standing between "any file type" and a stored same-origin XSS.
import { describe, expect, it } from "vitest";
import {
  classifyAttachment,
  contentDisposition,
  INLINE_MIME,
  safeName,
} from "@/lib/attachments";

describe("classifyAttachment", () => {
  it("classifies the model-readable image types, and nothing else, as image", () => {
    expect(classifyAttachment("image/jpeg", "a.jpg")).toBe("image");
    expect(classifyAttachment("image/png", "a.png")).toBe("image");
    expect(classifyAttachment("image/webp", "a.webp")).toBe("image");
    expect(classifyAttachment("image/gif", "a.gif")).toBe("image");
    // Markup, not a picture — must never become an input_image.
    expect(classifyAttachment("image/svg+xml", "a.svg")).toBe("opaque");
    // Neither provider accepts HEIC; the composer transcodes before upload.
    expect(classifyAttachment("image/heic", "a.heic")).toBe("opaque");
  });

  it("recognises spreadsheets by mime and by extension when the mime is missing", () => {
    const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    expect(classifyAttachment(xlsxMime, "Weekly Status Report.xlsx")).toBe("office");
    // iOS hands back an empty type for some Files-app picks.
    expect(classifyAttachment("", "Weekly Status Report.xlsx")).toBe("office");
    expect(classifyAttachment("application/octet-stream", "notes.docx")).toBe("office");
  });

  it("recognises text by mime, and by extension only when the mime is vague", () => {
    expect(classifyAttachment("text/plain", "a.txt")).toBe("text");
    expect(classifyAttachment("text/csv", "rows.csv")).toBe("text");
    expect(classifyAttachment("application/json", "a.json")).toBe("text");
    expect(classifyAttachment("", "server.log")).toBe("text");
    expect(classifyAttachment("application/octet-stream", "README.md")).toBe("text");
    // A decisive mime is never overridden by a text-looking extension.
    expect(classifyAttachment("application/zip", "archive.md")).toBe("opaque");
  });

  it("handles pdf both ways and falls back to opaque", () => {
    expect(classifyAttachment("application/pdf", "bill.pdf")).toBe("pdf");
    expect(classifyAttachment("", "bill.pdf")).toBe("pdf");
    expect(classifyAttachment("application/zip", "a.zip")).toBe("opaque");
    expect(classifyAttachment("", "backup.dmg")).toBe("opaque");
    expect(classifyAttachment("video/mp4", "clip.mp4")).toBe("opaque");
  });

  it("ignores charset parameters and case", () => {
    expect(classifyAttachment("TEXT/PLAIN; charset=utf-8", "a.txt")).toBe("text");
    expect(classifyAttachment("Image/PNG", "a.png")).toBe("image");
  });

  it("keeps the inline set to raster images plus pdf", () => {
    expect([...INLINE_MIME].sort()).toEqual([
      "application/pdf",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(INLINE_MIME.has("image/svg+xml")).toBe(false);
    expect(INLINE_MIME.has("text/html")).toBe(false);
  });
});

describe("safeName", () => {
  it("strips bidi overrides used to spoof an extension", () => {
    // Renders as "invoiceexe.png" in a download UI without the strip.
    const spoofed = "invoice\u202Egnp.exe";
    expect(safeName(spoofed)).toBe("invoicegnp.exe");
    expect(safeName(spoofed)).not.toContain("\u202E");
  });

  it("strips CR/LF so a filename cannot inject a header or escape a fence", () => {
    expect(safeName("a\r\nb.txt")).toBe("ab.txt");
    expect(safeName("x\u0000y.txt")).toBe("xy.txt");
  });

  it("strips path separators", () => {
    expect(safeName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(safeName("C:\\Users\\me\\a.txt")).toBe("C:_Users_me_a.txt");
  });

  it("never returns empty and caps length", () => {
    expect(safeName("")).toBe("file");
    expect(safeName("\u202E\u202E")).toBe("file");
    expect(safeName("a".repeat(400))).toHaveLength(200);
  });
});

describe("contentDisposition", () => {
  it("emits both the ASCII fallback and the RFC 5987 form", () => {
    const h = contentDisposition("attachment", "Weekly Status Report.xlsx");
    expect(h).toContain('filename="Weekly Status Report.xlsx"');
    expect(h).toContain("filename*=UTF-8''Weekly%20Status%20Report.xlsx");
    expect(h.startsWith("attachment; ")).toBe(true);
  });

  it("keeps a non-ASCII name readable in the encoded form", () => {
    const h = contentDisposition("inline", "réunion.pdf");
    expect(h).toContain("filename*=UTF-8''r%C3%A9union.pdf");
    // The ASCII fallback must not carry raw non-ASCII bytes.
    expect(h).toContain('filename="r_union.pdf"');
  });

  it("cannot be broken out of with quotes, backslashes or newlines", () => {
    const h = contentDisposition("attachment", 'evil".txt\r\nX-Injected: 1');
    expect(h).not.toMatch(/[\r\n]/);
    // Exactly the two quotes that delimit the ASCII filename.
    expect(h.match(/"/g)).toHaveLength(2);
  });

  it("percent-encodes the characters encodeURIComponent leaves raw", () => {
    const h = contentDisposition("attachment", "a'b(c)d*e.txt");
    expect(h).toContain("%27");
    expect(h).toContain("%28");
    expect(h).toContain("%2A");
  });
});
