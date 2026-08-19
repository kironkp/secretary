// Canvas sanitizer (SPEC §7.6): the ONLY gate between model-written markup and
// the sandboxed iframe. Allowlist tokenizer — anything not explicitly allowed
// is dropped, and there is no way to express a network request in the output:
// no src, no href, no url(), no forms, no scripts, no event handlers. Defense
// in depth: the iframe additionally has sandbox (scripts can't run) and a CSP
// of default-src 'none'.
//
// Deliberately conservative: images are not allowed at all (the painter draws
// with HTML/SVG), and truncated trailing tags (streaming) are dropped whole.

const ALLOWED_TAGS = new Set([
  "div", "span", "p", "h1", "h2", "h3", "h4", "strong", "em", "b", "i", "u", "s",
  "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "section", "article", "header", "footer", "main", "aside", "figure", "figcaption",
  "small", "sub", "sup", "br", "hr", "blockquote", "pre", "code",
  // SVG drawing vocabulary
  "svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path",
  "text", "tspan", "defs", "lineargradient", "stop", "title",
]);

// Void elements that never take a closing tag.
const VOID_TAGS = new Set(["br", "hr", "stop"]);

// Tags whose entire content must be discarded, not just the tags.
const DROP_CONTENT_TAGS = new Set(["script", "style", "iframe", "object", "embed", "noscript"]);

const ALLOWED_ATTRS = new Set([
  "class", "style", "data-expand", "data-link", "colspan", "rowspan",
  // SVG geometry + paint
  "viewbox", "xmlns", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "stroke", "stroke-width",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity",
  "fill-opacity", "font-size", "font-weight", "font-family", "text-anchor",
  "dominant-baseline", "transform", "offset", "stop-color", "stop-opacity",
  "gradientunits", "id",
]);

/** style values may not smuggle loads or behavior */
function safeStyle(value: string): string | null {
  const lower = value.toLowerCase();
  if (lower.includes("url(") || lower.includes("expression") || lower.includes("@import"))
    return null;
  return value;
}

function sanitizeAttrs(rawAttrs: string): string {
  let out = "";
  // attr="v" | attr='v' | attr=v | bare attr
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawAttrs))) {
    const name = m[1].toLowerCase();
    if (name.startsWith("on")) continue; // event handlers, always
    if (!ALLOWED_ATTRS.has(name)) continue;
    let value = m[3] ?? m[4] ?? (m[2] && !m[2].startsWith('"') && !m[2].startsWith("'") ? m[2] : "");
    if (name === "style") {
      const safe = safeStyle(value);
      if (safe === null) continue;
      value = safe;
    }
    if (name === "id" && !/^[-a-zA-Z0-9_]+$/.test(value)) continue;
    out += ` ${name}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"`;
  }
  return out;
}

/**
 * Sanitize a model-painted fragment. Pure; tolerant of truncated input
 * (streaming): an unterminated trailing tag is dropped.
 */
export function sanitizeCanvasMarkup(input: string): string {
  let html = input;
  // Model wrappers: strip markdown fences if the whole thing arrived fenced.
  html = html.replace(/^\s*```(?:html)?\s*/i, "").replace(/\s*```\s*$/, "");
  // Drop dangerous containers WITH their content (script/style/iframe/…).
  for (const tag of DROP_CONTENT_TAGS) {
    html = html.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), "");
    // Unclosed (streaming truncation): everything after the tag is its body —
    // drop it all rather than letting script text degrade into visible text.
    html = html.replace(new RegExp(`<${tag}\\b[\\s\\S]*$`, "gi"), "");
  }
  // Drop comments, CDATA, doctypes, processing instructions.
  html = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<![^>]*>/g, "").replace(/<\?[^>]*>/g, "");
  // Truncated trailing tag (streaming): drop the incomplete token.
  html = html.replace(/<[^>]*$/, "");

  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (whole, name: string, attrs: string) => {
      const tag = name.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return "";
      if (whole.startsWith("</")) return `</${tag}>`;
      const selfClose = VOID_TAGS.has(tag) || /\/\s*$/.test(attrs);
      return `<${tag}${sanitizeAttrs(attrs)}${selfClose ? " /" : ""}>`;
    }
  );
}

/**
 * The srcdoc for the sandboxed iframe. CSP: nothing loads, nothing runs,
 * inline styles only. The <style> block carries the app's design tokens so
 * painted inline styles can reference var(--…).
 */
export function buildCanvasSrcDoc(sanitizedMarkup: string, opts: { dark?: boolean } = {}): string {
  const tokens = opts.dark
    ? ":root{--bg:#0b1220;--card:#131c2b;--edge:rgba(255,255,255,.1);--ink:#eef2f8;--muted:#a9b6c9;--accent:#5b8def;--ok:#0ca30c;--warn:#fab219;--danger:#d03b3b}"
    : ":root{--bg:#f7f8fa;--card:#ffffff;--edge:#e4e7ec;--ink:#111827;--muted:#6b7280;--accent:#4f6ef7;--ok:#0f9d58;--warn:#c77d0a;--danger:#c0392b}";
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    // Belt and braces: the sandbox attribute already blocks scripts; this CSP
    // blocks every load and execution channel inside the document itself.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'">`,
    "<style>",
    tokens,
    "html,body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5}",
    "[data-expand]{cursor:pointer}",
    "[data-link]{cursor:pointer;text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:2px}",
    ".cv-expanded{outline:2px solid var(--accent);outline-offset:4px;border-radius:8px}",
    "</style></head><body>",
    sanitizedMarkup,
    "</body></html>",
  ].join("");
}

/** The exact sandbox attribute the host iframe must carry (asserted in tests).
 *  allow-same-origin (host attaches shell behaviors from outside) but NO
 *  allow-scripts — nothing inside the document can ever execute. */
export const CANVAS_SANDBOX = "allow-same-origin";
