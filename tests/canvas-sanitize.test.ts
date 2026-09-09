// F9 canvas-sanitize (SPEC §8): the sanitizer strips every execution and
// network channel; the iframe doc carries the sandbox + CSP; a snapshot is
// saved with brief + timestamp; nothing in the output can start a request.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { canvasSnapshots, user } from "@/lib/db/schema";
import { paintCanvas } from "@/lib/canvas/painter";
import {
  buildCanvasSrcDoc,
  CANVAS_SANDBOX,
  sanitizeCanvasMarkup,
} from "@/lib/canvas/sanitize";

const F9_PAYLOAD = [
  `<div class="card"><h2>Album</h2>`,
  `<script>alert(1)</script>`,
  `<p onclick="steal()">progress: 40%</p>`,
  `<form action="/api/tasks" method="post"><input name="x"></form>`,
  `<img src="http://evil.example/x.png">`,
  `<span style="background:url(http://evil.example/c.css)">tracked</span>`,
  `<a href="https://evil.example">click</a>`,
  `<svg viewBox="0 0 100 40"><rect x="0" y="0" width="40" height="10" fill="var(--accent)"/></svg>`,
  `</div>`,
].join("\n");

describe("F9 sanitizer", () => {
  const out = sanitizeCanvasMarkup(F9_PAYLOAD);

  it("strips script, inline handlers, forms, and external images", () => {
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<input");
    expect(out).not.toContain("<img");
  });

  it("leaves no network-capable syntax at all (static no-egress guarantee)", () => {
    expect(out).not.toMatch(/src\s*=/i);
    expect(out).not.toMatch(/href\s*=/i);
    expect(out).not.toContain("url(");
    expect(out).not.toContain("http://");
    expect(out).not.toContain("https://");
  });

  it("keeps the safe content and the SVG drawing", () => {
    expect(out).toContain("<h2>Album</h2>");
    expect(out).toContain("progress: 40%");
    expect(out).toContain("<svg");
    expect(out).toContain('fill="var(--accent)"');
    expect(out).toContain("tracked"); // text survives; its style attribute did not
    expect(out).not.toContain("background:url");
  });

  it("keeps shell primitives and tolerates streaming truncation", () => {
    expect(sanitizeCanvasMarkup(`<div data-expand data-link="proj-1">x</div>`)).toContain(
      'data-link="proj-1"'
    );
    expect(
      sanitizeCanvasMarkup(`<li data-check="4f9d2c10-93ab-4bfb-8c0e-1234567890ab">flyers</li>`)
    ).toContain('data-check="4f9d2c10-93ab-4bfb-8c0e-1234567890ab"');
    // truncated mid-tag: incomplete token dropped, no throw
    expect(sanitizeCanvasMarkup(`<div class="cv-a">ok</div><p cla`)).toBe(
      `<div class="cv-a">ok</div>`
    );
    // unclosed <script (truncation) never leaks content
    expect(sanitizeCanvasMarkup(`<script>fetch("http://x")`)).not.toContain("fetch");
  });

  // The sanitizer also guards the ONE path that renders model markup inline in
  // the main document (approved slow-loop templates), where Tailwind is live.
  // A free-form class there is an app-covering overlay with no style attribute.
  it("namespaces class so it cannot reach app-level utility styles", () => {
    const overlay = sanitizeCanvasMarkup(`<div class="fixed inset-0 z-50 bg-white">x</div>`);
    expect(overlay).toBe("<div>x</div>");
    expect(overlay).not.toContain("fixed");
    expect(overlay).not.toContain("inset-0");

    // namespaced classes survive, alongside dropped tokens
    expect(sanitizeCanvasMarkup(`<div class="cv-chart">x</div>`)).toContain('class="cv-chart"');
    expect(sanitizeCanvasMarkup(`<div class="sl-row">x</div>`)).toContain('class="sl-row"');
    expect(sanitizeCanvasMarkup(`<div class="cv-chart fixed">x</div>`)).not.toContain("fixed");

    // a class that merely starts with the namespace text isn't a free pass
    expect(sanitizeCanvasMarkup(`<div class="cvfixed">x</div>`)).toBe("<div>x</div>");
  });

  // The shell injects .cv-box and toggles .cv-done/.cv-expanded as state. A
  // model that could paint them would own the checkbox contract: a fake box
  // satisfies the host's "already has one" guard and becomes the tap target.
  it("reserves the shell's own state classes", () => {
    for (const c of ["cv-box", "cv-checkable", "cv-done", "cv-expanded"]) {
      expect(sanitizeCanvasMarkup(`<div class="${c}">x</div>`)).toBe("<div>x</div>");
    }
    // and cannot be smuggled alongside a legitimate one
    expect(sanitizeCanvasMarkup(`<div class="cv-chart cv-box">x</div>`)).toBe(
      '<div class="cv-chart">x</div>'
    );
  });

  it("keeps markup inside its own box on the inline render path", () => {
    // The dashboard renders approved templates through this same sanitizer,
    // inline in the app document, where these are app-covering overlays.
    for (const s of [
      "position:fixed;inset:0",
      "POSITION : FIXED;inset:0",
      "position:/*x*/fixed;inset:0",
      "position:absolute;top:0",
      "position:sticky;top:0",
    ]) {
      expect(sanitizeCanvasMarkup(`<div style="${s}">x</div>`)).toBe("<div>x</div>");
    }
    // a backslash can spell any function name (\75 rl() → url()
    expect(sanitizeCanvasMarkup(`<div style="background:\\75 rl(http://x)">x</div>`)).toBe(
      "<div>x</div>"
    );
    expect(sanitizeCanvasMarkup(`<div style="background:image-set('http://x')">x</div>`)).toBe(
      "<div>x</div>"
    );
    // ordinary painted styles are untouched
    expect(sanitizeCanvasMarkup(`<div style="color:var(--ink);padding:16px">x</div>`)).toContain(
      "padding:16px"
    );
  });

  // Completion now requires the shell's checkbox, and an HTML element created
  // inside an SVG subtree never renders — so a data-check there would be a tap
  // target that can never be completed. Drop it at the gate instead.
  it("does not let data-check land on SVG geometry", () => {
    const id = "4f9d2c10-93ab-4bfb-8c0e-1234567890ab";
    expect(sanitizeCanvasMarkup(`<rect data-check="${id}" />`)).not.toContain("data-check");
    expect(sanitizeCanvasMarkup(`<g data-check="${id}"></g>`)).not.toContain("data-check");
    // still fine on real HTML rows and cards
    expect(sanitizeCanvasMarkup(`<li data-check="${id}">x</li>`)).toContain("data-check");
    expect(sanitizeCanvasMarkup(`<tr data-check="${id}"></tr>`)).toContain("data-check");
  });
});

describe("F9 iframe document", () => {
  it("carries the lockdown CSP and the sandbox attribute is script-free", () => {
    const doc = buildCanvasSrcDoc("<p>hi</p>");
    expect(doc).toContain(`default-src 'none'`);
    expect(doc).toContain(`script-src 'none'`);
    expect(doc).toContain(`form-action 'none'`);
    expect(CANVAS_SANDBOX).not.toContain("allow-scripts");
  });
});

describe("data-check tap-to-complete (SPEC §7.6)", () => {
  it("strips malformed data-check values — only id-shaped survives", () => {
    // must never reach the shell's click handler → the task API
    expect(sanitizeCanvasMarkup(`<li data-check="a b">x</li>`)).not.toContain("data-check");
    expect(sanitizeCanvasMarkup(`<li data-check="x&quot;y">x</li>`)).not.toContain("data-check");
    expect(sanitizeCanvasMarkup(`<li data-check="../etc">x</li>`)).not.toContain("data-check");
    expect(sanitizeCanvasMarkup(`<li data-check>x</li>`)).not.toContain("data-check");
    expect(sanitizeCanvasMarkup(`<li data-check="">x</li>`)).not.toContain("data-check");
  });

  it("iframe doc styles the tap affordance and the cross-off", () => {
    const doc = buildCanvasSrcDoc("<p>hi</p>");
    expect(doc).toContain("[data-check]{cursor:pointer}");
    expect(doc).toContain(".cv-done{");
    expect(doc).toContain("line-through");
  });
});

describe("F9 snapshot persistence (integration)", () => {
  const U = { id: `test-canvas-${crypto.randomUUID()}`, email: `canvas-${Date.now()}@f9.test` };

  beforeAll(async () => {
    await db.insert(user).values({ id: U.id, name: "Canvas Tester", email: U.email });
  });
  afterAll(async () => {
    await db.delete(user).where(eq(user.id, U.id));
  });

  it("streams a paint into a sanitized snapshot with brief + timestamp", async () => {
    async function* fakeStream() {
      yield `<div class="card"><h2>Week`;
      yield `<div class="card"><h2>Week</h2><script>alert(1)</script><p>3 open</p></div>`;
    }
    const { snapshotId, markup } = await paintCanvas(U.id, "paint my week", {
      stream: fakeStream,
    });
    expect(markup).toContain("<h2>Week</h2>");
    expect(markup).not.toContain("script");
    const [row] = await db
      .select()
      .from(canvasSnapshots)
      .where(eq(canvasSnapshots.id, snapshotId));
    expect(row.brief).toBe("paint my week");
    expect(row.painting).toBe(false);
    expect(row.markup).toBe(markup);
    expect(row.createdAt).toBeInstanceOf(Date);
  });
});
