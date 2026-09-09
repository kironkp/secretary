// Attachment classification and safe-serving helpers.
//
// One rule holds the whole file together: attachment bytes are UNTRUSTED user
// content served from our own authenticated origin. Only the raster types the
// browser hands to an image decoder (plus PDF, whose viewer is out-of-process)
// may be served inline with their own mime; everything else goes back as
// opaque bytes with Content-Disposition: attachment, so an uploaded .html or
// .svg can never become a same-origin document and run script under the
// session cookie. The upload allowlist used to be what prevented that — this
// module is what replaces it now that any file type may be stored.
//
// Pure, no I/O, so the rules are unit-testable in one place.

/** What the model can do with a file — computed from (mime, name), never stored.
 *  A column would go stale the moment the classifier learns a new type; the row
 *  already has both inputs, and nothing queries attachments by kind. */
export type AttachmentKind = "image" | "pdf" | "text" | "office" | "opaque";

/** Raster images both providers accept, verbatim. NOT image/* — svg is markup
 *  and heic isn't accepted by either API (the composer transcodes it first). */
export const MODEL_IMAGE_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** Served back with their own mime and rendered in place. Everything absent
 *  from this set becomes application/octet-stream + attachment. */
export const INLINE_MIME = new Set([...MODEL_IMAGE_MIME, "application/pdf"]);

const TEXT_MIME = new Set([
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/sql",
]);

// Extensions only consulted when the mime is absent or useless — iOS hands
// back an empty type for some Files-app picks.
const TEXT_EXT = new Set(
  ("txt md markdown csv tsv log json jsonl ndjson yaml yml toml ini cfg conf xml html htm " +
   "ics vcf srt vtt sql sh bash zsh py js jsx ts tsx css scss go rb rs java kt swift c h " +
   "cpp hpp cs php pl r m env").split(" ")
);

const OFFICE_EXT = new Set("doc docx xls xlsx ppt pptx rtf odt ods odp".split(" "));

const OFFICE_MIME = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/rtf",
]);

/** No mime at all, or the generic one browsers fall back to. */
function mimeIsVague(mime: string): boolean {
  return !mime || mime === "application/octet-stream" || mime === "application/x-unknown";
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Mime is decisive when it says anything useful; the extension is a fallback. */
export function classifyAttachment(mime: string, name: string): AttachmentKind {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  const ext = extensionOf(name || "");

  if (MODEL_IMAGE_MIME.has(m)) return "image";
  if (m === "application/pdf") return "pdf";

  if (!mimeIsVague(m)) {
    if (m.startsWith("text/")) return "text";
    if (TEXT_MIME.has(m)) return "text";
    if (m.startsWith("application/vnd.openxmlformats-officedocument.")) return "office";
    if (m.startsWith("application/vnd.oasis.opendocument.")) return "office";
    if (OFFICE_MIME.has(m)) return "office";
    // A decisive mime we don't recognise (image/svg+xml, video/*, application/zip)
    // is opaque — never guessed into a readable kind from its extension.
    return "opaque";
  }

  if (ext === "pdf") return "pdf";
  if (OFFICE_EXT.has(ext)) return "office";
  if (TEXT_EXT.has(ext)) return "text";
  return "opaque";
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidi overrides: "invoice\u202Egnp.exe" renders as "invoiceexe.png".
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

/** Store-time filename hygiene: no control characters (header injection), no
 *  bidi overrides (extension spoofing), no path separators. */
export function safeName(raw: string): string {
  const cleaned = (raw || "file")
    .replace(CONTROL, "")
    .replace(BIDI, "")
    .replace(/[/\\]/g, "_")
    .trim();
  return (cleaned || "file").slice(0, 200);
}

/**
 * RFC 6266: an ASCII quoted-string fallback plus the RFC 5987 UTF-8 form.
 * Browsers don't percent-decode the plain `filename=` token, so a name sent
 * only in encoded form lands on disk as "Weekly%20Status%20Report.xlsx".
 */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const clean = safeName(name);
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // encodeURIComponent leaves ' ( ) * raw, and none of those are attr-char.
  const utf8 = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Bytes we'll store. Larger than what we'll send to a model — see MAX_SEND_BYTES. */
export const MAX_STORE_BYTES = 25 * 1024 * 1024;
/** Per-file ceiling on what gets base64'd into a model request. Above this the
 *  file is stored and the model is told it exists but wasn't readable. */
export const MAX_SEND_BYTES = 8 * 1024 * 1024;
/** Per-turn ceiling across all attachments — Anthropic caps the whole request
 *  at 32 MB and base64 inflates by a third. */
export const MAX_TURN_SEND_BYTES = 12 * 1024 * 1024;
