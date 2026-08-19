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
    // truncated mid-tag: incomplete token dropped, no throw
    expect(sanitizeCanvasMarkup(`<div class="a">ok</div><p cla`)).toBe(`<div class="a">ok</div>`);
    // unclosed <script (truncation) never leaks content
    expect(sanitizeCanvasMarkup(`<script>fetch("http://x")`)).not.toContain("fetch");
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
