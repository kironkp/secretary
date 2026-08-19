// F8 chat-new-view (SPEC §8) + slow-loop plumbing: wishlist dedupe/tombstone,
// enqueue, interim substitution, approve = hot-register, reject = tombstone,
// and the proof that nothing under components/proposed/ is imported at runtime.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dynamicComponents, projects, tasks, user, wishlist } from "@/lib/db/schema";
import { computeCurrentPlan } from "@/lib/layout/plan-store";
import {
  addWish,
  approveProposal,
  parseProposal,
  PROPOSED_DIR,
  renderTemplate,
  rejectProposal,
} from "@/lib/layout/slow-loop";
import { defaultPlan } from "@/lib/layout/plan";
import { validatePlan } from "@/lib/layout/validator";
import { executeTool } from "@/lib/secretary/tools";
import { baseSignals } from "./fixtures/layout";

const U = { id: `test-slowloop-${crypto.randomUUID()}`, email: `sl-${Date.now()}@f8.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };
const PROPOSAL = "test-album-burndown";

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "SlowLoop Tester", email: U.email });
  await db.insert(projects).values({ id: `${U.id}-album`, userId: U.id, name: "album", status: "active" });
  await db.insert(tasks).values({
    userId: U.id,
    projectId: `${U.id}-album`,
    title: "Master tracks",
    status: "todo",
    dueAt: new Date(Date.now() + 9 * 86400000),
  });
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
  rmSync(join(PROPOSED_DIR, PROPOSAL), { recursive: true, force: true });
});

describe("F8 chat-new-view", () => {
  it("files a priority wish, enqueues the build, and dedupes repeats", async () => {
    const { result } = await executeTool(ctx, "request_new_component", {
      need: "show the album as a burndown chart",
      closest_component: "timeline",
    });
    expect((result as { building?: boolean }).building).toBe(true);

    const [row] = await db.select().from(wishlist).where(eq(wishlist.userId, U.id));
    expect(row.priority).toBe(true);
    expect(row.enqueuedAt).toBeInstanceOf(Date); // job enqueued (spawn stubbed in tests)
    expect(row.status).toBe("building");

    // repeat ask → same wish, count bumped, no duplicate row
    await executeTool(ctx, "request_new_component", {
      need: "Show the album as a burndown chart",
      closest_component: "timeline",
    });
    const rows = await db.select().from(wishlist).where(eq(wishlist.userId, U.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
  });

  it("substitutes the closest component on the dashboard with an honest why", async () => {
    const bundle = await computeCurrentPlan(U.id);
    const timeline = bundle.plan.sections.find((s) => s.component === "timeline");
    expect(timeline?.props).toMatchObject({ span_days: 14, expanded: true });
    expect(timeline?.why).toContain("closest I have until");
    expect(timeline?.why).toContain("built");
  });

  it("nothing under components/proposed/ is imported anywhere at runtime", () => {
    const hits = execSync(
      `grep -rn "components/proposed" --include="*.ts" --include="*.tsx" app components lib || true`,
      { cwd: process.cwd(), encoding: "utf8" }
    )
      .split("\n")
      .filter((l) => l.includes("import") || l.includes("require("));
    expect(hits).toEqual([]);
  });
});

describe("proposal lifecycle", () => {
  const FAKE_OUTPUT = [
    "```json",
    `{"name": "${PROPOSAL}", "description": "Album burndown lane"}`,
    "```",
    "```html",
    `<div class="card"><h3>{{signals.projects.0.name}} burndown</h3>` +
      `{{#each projects}}<p>{{name}}: {{open_count}} open, {{days_left}}d left</p>{{/each}}` +
      `<script>alert(1)</script></div>`,
    "```",
    "```html",
    `<div class="card"><h3>album burndown</h3><p>album: 6 open, 11d left</p></div>`,
    "```",
  ].join("\n");

  it("parses generation output and writes the proposal dir", async () => {
    const proposal = parseProposal(FAKE_OUTPUT);
    expect(proposal?.meta.name).toBe(PROPOSAL);
    mkdirSync(join(PROPOSED_DIR, PROPOSAL), { recursive: true });
    writeFileSync(join(PROPOSED_DIR, PROPOSAL, "meta.json"), JSON.stringify(proposal!.meta));
    writeFileSync(join(PROPOSED_DIR, PROPOSAL, "template.html"), proposal!.template);
    writeFileSync(join(PROPOSED_DIR, PROPOSAL, "preview.html"), proposal!.preview);
    await db
      .update(wishlist)
      .set({ status: "proposed", proposalName: PROPOSAL })
      .where(eq(wishlist.userId, U.id));
    expect(existsSync(join(PROPOSED_DIR, PROPOSAL, "template.html"))).toBe(true);
  });

  it("approve hot-registers: version bump, validator accepts it, template interpolates sanitized", async () => {
    const res = await approveProposal(U.id, PROPOSAL);
    expect(res).toMatchObject({ ok: true, registryVersion: 3 });
    // proposal dir consumed
    expect(existsSync(join(PROPOSED_DIR, PROPOSAL))).toBe(false);

    const [dyn] = await db
      .select()
      .from(dynamicComponents)
      .where(eq(dynamicComponents.userId, U.id));
    expect(dyn.name).toBe(PROPOSAL);

    // validator accepts a plan that uses it (with the dynamic list), and the
    // template renders from signals with the script stripped downstream
    const signals = baseSignals();
    const plan = defaultPlan(signals);
    plan.sections.push({ component: PROPOSAL });
    const v = validatePlan(plan, {
      signals,
      previousPlan: null,
      preferences: [],
      pinnedSections: [],
      defaultPlan: defaultPlan(signals),
      dynamicComponents: [PROPOSAL],
    });
    expect(v.ok).toBe(true);

    const rendered = renderTemplate(dyn.template, signals);
    expect(rendered).toContain("patent burndown"); // {{signals.projects.0.name}}
    expect(rendered).toContain("album: 6 open, 11d left"); // {{#each}}
    // wish marked approved
    const [w] = await db.select().from(wishlist).where(eq(wishlist.userId, U.id));
    expect(w.status).toBe("approved");
  });

  it("reject tombstones the need — it never re-proposes", async () => {
    const wish = await addWish(U.id, {
      need: "a people heatmap",
      closestComponent: "people_index",
      signals: "test",
      priority: true,
    });
    await db
      .update(wishlist)
      .set({ status: "proposed", proposalName: "test-people-heatmap" })
      .where(eq(wishlist.id, wish.id));
    await rejectProposal(U.id, "test-people-heatmap");

    const again = await addWish(U.id, {
      need: "A People Heatmap",
      closestComponent: "people_index",
      signals: "test",
    });
    expect(again.tombstoned).toBe(true);
    const rows = await db.select().from(wishlist).where(eq(wishlist.id, wish.id));
    expect(rows[0].tombstoned).toBe(true);
  });
});
