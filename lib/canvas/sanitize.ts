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
  "class", "style", "data-expand", "data-link", "data-check", "colspan", "rowspan",
  // SVG geometry + paint
  "viewbox", "xmlns", "width", "height", "x", "y", "x1", "y1", "x2", "y2",
  "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "stroke", "stroke-width",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity",
  "fill-opacity", "font-size", "font-weight", "font-family", "text-anchor",
  "dominant-baseline", "transform", "offset", "stop-color", "stop-opacity",
  "gradientunits", "id",
]);

/** style values may not smuggle loads, behavior, or an escape from their own box.
 *
 *  The escape clause matters because this sanitizer also guards the one path
 *  that renders model markup INLINE in the app document (approved slow-loop
 *  templates): there, `position:fixed;inset:0` is an app-covering overlay.
 *  A CSS backslash can spell any function name (`\75 rl(`), so a raw backslash
 *  is rejected outright — neither painter prompt ever emits one. */
function safeStyle(value: string): string | null {
  if (value.includes("\\")) return null;
  const lower = value.toLowerCase();
  if (lower.includes("url(") || lower.includes("expression") || lower.includes("@import"))
    return null;
  if (lower.includes("image-set(") || lower.includes("-webkit-image-set(")) return null;
  // Comments can hide the keyword from a naive scan: position:/*x*/fixed.
  const flat = lower.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
  if (/position:(fixed|sticky|absolute)/.test(flat)) return null;
  return value;
}

/** Class names the SHELL owns: it injects .cv-box, and toggles .cv-done /
 *  .cv-expanded / .cv-checkable as state. Model markup may never carry them —
 *  a painted `<span class="cv-box">` would satisfy the host's "already has a
 *  checkbox" guard and become the completion target, i.e. a checkbox the model
 *  drew and controls. */
const HOST_CLASSES = new Set(["cv-box", "cv-checkable", "cv-done", "cv-expanded"]);

/**
 * Class names are namespaced, not free text.
 *
 * Model markup is normally rendered inside the sandboxed canvas iframe, where
 * an arbitrary class is inert — no app stylesheet is loaded there. But the same
 * sanitizer guards the ONE path that renders model-authored markup inline in
 * the main document (approved slow-loop templates on the dashboard), where
 * Tailwind's full utility set IS live. There, `class="fixed inset-0 z-50"`
 * would be an app-covering overlay with no style attribute at all — a layout
 * escape hatch that never goes through safeStyle.
 *
 * Neither painter prompt asks the model to use classes (both compose with
 * inline styles), so restricting to the shell's own namespaces costs nothing
 * and closes the hole everywhere at once.
 */
const CLASS_TOKEN = /^(?:cv|sl)-[a-zA-Z0-9_-]+$/;
function safeClass(value: string): string | null {
  const kept = value
    .split(/\s+/)
    .filter((t) => t && CLASS_TOKEN.test(t) && !HOST_CLASSES.has(t));
  return kept.length ? kept.join(" ") : null;
}

// SVG geometry cannot host the shell's checkbox: an HTML <span> created inside
// an SVG subtree is in the wrong namespace and simply never renders. A
// data-check there would be a tap target with no visible checkbox and, since
// completion now requires the checkbox, no way to complete at all. Drop it at
// the gate so every surviving data-check is guaranteed a real checkbox.
const SVG_TAGS = new Set([
  "svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path",
  "text", "tspan", "defs", "lineargradient", "stop",
]);

function sanitizeAttrs(rawAttrs: string, tag: string): string {
  let out = "";
  // attr="v" | attr='v' | attr=v | bare attr
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawAttrs))) {
    const name = m[1].toLowerCase();
    if (name.startsWith("on")) continue; // event handlers, always
    if (!ALLOWED_ATTRS.has(name)) continue;
    if (name === "data-check" && SVG_TAGS.has(tag)) continue;
    let value = m[3] ?? m[4] ?? (m[2] && !m[2].startsWith('"') && !m[2].startsWith("'") ? m[2] : "");
    if (name === "style") {
      const safe = safeStyle(value);
      if (safe === null) continue;
      value = safe;
    }
    if (name === "class") {
      const safe = safeClass(value);
      if (safe === null) continue;
      value = safe;
    }
    // id-shaped values only: data-check reaches the task API (SPEC §7.6), and
    // a bare/garbage value must never survive to the shell's click handler.
    if ((name === "id" || name === "data-check") && !/^[-a-zA-Z0-9_]+$/.test(value)) continue;
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
      return `<${tag}${sanitizeAttrs(attrs, tag)}${selfClose ? " /" : ""}>`;
    }
  );
}

/**
 * The srcdoc for the sandboxed iframe. CSP: nothing loads, nothing runs,
 * inline styles only. The <style> block carries the app's design tokens so
 * painted inline styles can reference var(--…).
 */
/** Theme enums → CSS variables. The shell compiles them; the model only ever
 *  picks an enum value, so "make the font bigger" is data, not authored style.
 *  Painted markup already styles with var(--…), so a theme change reaches it
 *  without touching a single byte of model output. */
export type CanvasThemeVars = {
  scale?: number;
  density?: "tight" | "normal" | "roomy";
  font?: "system" | "serif" | "mono" | "condensed";
  accent?: "default" | "grape" | "ok" | "warn" | "danger";
  radius?: "sharp" | "soft" | "round";
};

const FONT_STACKS: Record<string, string> = {
  system: "system-ui,-apple-system,sans-serif",
  serif: "ui-serif,Georgia,'Times New Roman',serif",
  mono: "ui-monospace,SFMono-Regular,Menlo,monospace",
  condensed: "'Avenir Next Condensed','Helvetica Neue',system-ui,sans-serif",
};
const DENSITY_SPACE: Record<string, string> = { tight: "10px", normal: "16px", roomy: "24px" };
const RADIUS: Record<string, string> = { sharp: "2px", soft: "14px", round: "22px" };

function themeVars(theme: CanvasThemeVars = {}): string {
  const scale = Math.max(0.75, Math.min(2, theme.scale ?? 1));
  const base = 14 * scale;
  const step = (n: number) => `${Math.round(base * Math.pow(1.25, n) * 100) / 100}px`;
  const accent = theme.accent && theme.accent !== "default" ? `var(--${theme.accent})` : null;
  return [
    `--font-ui:${FONT_STACKS[theme.font ?? "system"] ?? FONT_STACKS.system}`,
    `--space:${DENSITY_SPACE[theme.density ?? "normal"] ?? DENSITY_SPACE.normal}`,
    `--radius:${RADIUS[theme.radius ?? "soft"] ?? RADIUS.soft}`,
    `--s0:${step(-1)}`,
    `--s1:${step(0)}`,
    `--s2:${step(1)}`,
    `--s3:${step(2)}`,
    `--s4:${step(3)}`,
    `--fs:${step(0)}`,
    ...(accent ? [`--accent:${accent}`] : []),
  ].join(";");
}

export function buildCanvasSrcDoc(
  sanitizedMarkup: string,
  opts: { dark?: boolean; theme?: CanvasThemeVars; block?: boolean } = {}
): string {
  // Mirrors app/globals.css exactly — these drifted, so a painted canvas used
  // slightly different blues and greens from the app around it.
  const tokens = opts.dark
    ? ":root{--bg:#0f1115;--surface:#171a21;--surface-2:#1e222b;--card:#232834;--edge:#2e3442;--ink:#e8eaf0;--muted:#9aa3b5;--faint:#6b7386;--accent:#7aa2ff;--ok:#4ade80;--warn:#fbbf24;--danger:#f87171;--grape:#c084fc}"
    : ":root{--bg:#f6f7f9;--surface:#ffffff;--surface-2:#eef0f4;--card:#ffffff;--edge:#e4e7ee;--ink:#171a21;--muted:#5a6375;--faint:#8b93a5;--accent:#4a6fe8;--ok:#15803d;--warn:#b45309;--danger:#dc2626;--grape:#7e22ce}";
  return [
    "<!doctype html><html><head>",
    '<meta charset="utf-8">',
    // Belt and braces: the sandbox attribute already blocks scripts; this CSP
    // blocks every load and execution channel inside the document itself.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; form-action 'none'">`,
    "<style>",
    tokens,
    // Theme vars ride the same :root the tokens do, so painted markup that
    // already uses var(--…) picks them up with no repaint.
    `:root{${themeVars(opts.theme)}}`,
    // A per-block frame is transparent and unpadded: the SHELL owns the gap
    // between blocks and the page background, because it owns the layout.
    opts.block
      ? "html,body{margin:0;padding:0;background:transparent;color:var(--ink);font-family:var(--font-ui);font-size:var(--fs);line-height:1.5}"
      : "html,body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-family:var(--font-ui);font-size:var(--fs);line-height:1.5}",
    "[data-expand]{cursor:pointer}",
    "[data-link]{cursor:pointer;text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:2px}",
    "[data-check]{cursor:pointer}",
    ".cv-done{text-decoration:line-through;opacity:.55;transition:opacity .2s}",
    ".cv-expanded{outline:2px solid var(--accent);outline-offset:4px;border-radius:8px}",
    // Shell-owned checkbox (SPEC §7.6): the HOST injects .cv-box into every
    // [data-check] and owns its state. The model never draws it, so it can't
    // be faked, and "put checkboxes on those" needs no repaint.
    // border-box so the gutter eats into the element's own width rather than
    // widening it out of a flex/grid track. The 30px is a floor: the host also
    // sets padding-left inline, because painted cards carry their own inline
    // padding, which would otherwise beat this rule and leave the box sitting
    // on top of the card's text.
    ".cv-checkable{position:relative;box-sizing:border-box;padding-left:30px}",
    ".cv-box{position:absolute;left:8px;top:calc(50% - 9px);width:18px;height:18px;" +
      "border:1.5px solid var(--muted);border-radius:5px;background:var(--surface);" +
      "cursor:pointer;box-sizing:border-box;transition:background .15s,border-color .15s}",
    ".cv-box::after{content:'';position:absolute;left:5px;top:1.5px;width:5px;height:10px;" +
      "border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);opacity:0;transition:opacity .15s}",
    '.cv-box[aria-checked="true"]{background:var(--ok);border-color:var(--ok)}',
    '.cv-box[aria-checked="true"]::after{opacity:1}',
    // Accessibility settings win over motion, inside the canvas too.
    "@media (prefers-reduced-motion: reduce){*{animation-duration:.01ms !important;" +
      "animation-iteration-count:1 !important;transition-duration:.01ms !important;" +
      "scroll-behavior:auto !important}}",
    "</style></head><body>",
    sanitizedMarkup,
    "</body></html>",
  ].join("");
}

/** The exact sandbox attribute the host iframe must carry (asserted in tests).
 *  allow-same-origin (host attaches shell behaviors from outside) but NO
 *  allow-scripts — nothing inside the document can ever execute. */
export const CANVAS_SANDBOX = "allow-same-origin";
