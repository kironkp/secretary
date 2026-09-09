// Slow loop (SPEC §7, v1.3): wishlist accumulation → brief assembly →
// generation job → proposal in components/proposed/<name>/ → human approval →
// hot-registration as a declarative template. The runtime NEVER executes
// generated code — approved components are templates interpolated + sanitized
// at render time, exactly like canvas markup.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dynamicComponents, wishlist } from "@/lib/db/schema";
import { REGISTRY_VERSION } from "./registry";
import type { Signals } from "./signals";

export const PROPOSED_DIR = join(process.cwd(), "components/proposed");
const NIGHTLY_THRESHOLD = 3; // occurrences before the nightly job builds it

const normalize = (need: string) => need.trim().toLowerCase().replace(/\s+/g, " ");
export const slugify = (need: string) =>
  normalize(need)
    .replace(/[^a-z0-9- ]/g, "")
    .split(/[\s]+/)
    .slice(0, 5)
    .join("-")
    .replace(/-+/g, "-");

/** Add (or bump) a wish. Dedupe by normalized need; tombstones never revive. */
export async function addWish(
  userId: string,
  wish: { need: string; closestComponent: string; signals: string; priority?: boolean }
): Promise<{ id: string; count: number; tombstoned: boolean }> {
  const rows = await db.select().from(wishlist).where(eq(wishlist.userId, userId));
  const existing = rows.find((r) => normalize(r.need) === normalize(wish.need));
  if (existing) {
    if (existing.tombstoned) return { id: existing.id, count: existing.count, tombstoned: true };
    const [updated] = await db
      .update(wishlist)
      .set({
        count: existing.count + 1,
        priority: existing.priority || Boolean(wish.priority),
        updatedAt: new Date(),
      })
      .where(eq(wishlist.id, existing.id))
      .returning();
    return { id: updated.id, count: updated.count, tombstoned: false };
  }
  const [row] = await db
    .insert(wishlist)
    .values({
      userId,
      need: wish.need,
      closestComponent: wish.closestComponent,
      signals: wish.signals,
      priority: Boolean(wish.priority),
    })
    .returning();
  return { id: row.id, count: row.count, tombstoned: false };
}

export async function openPriorityWishes(userId: string) {
  return db
    .select()
    .from(wishlist)
    .where(
      and(
        eq(wishlist.userId, userId),
        eq(wishlist.tombstoned, false),
        eq(wishlist.priority, true),
        sql`${wishlist.status} IN ('open', 'building', 'proposed')`
      )
    );
}

/** Current registry version: base + approved dynamic components. */
export async function currentRegistryVersion(userId: string): Promise<number> {
  const [row] = await db
    .select({ v: dynamicComponents.registryVersion })
    .from(dynamicComponents)
    .where(eq(dynamicComponents.userId, userId))
    .orderBy(desc(dynamicComponents.registryVersion))
    .limit(1);
  return row?.v ?? REGISTRY_VERSION;
}

export async function listDynamicComponents(userId: string) {
  return db.select().from(dynamicComponents).where(eq(dynamicComponents.userId, userId));
}

/**
 * Enqueue the generation job for a wish. In tests (VITEST) or when disabled,
 * only the enqueue marker is written — nothing spawns.
 */
export async function enqueueBuild(userId: string, wishId: string): Promise<void> {
  await db
    .update(wishlist)
    .set({ status: "building", enqueuedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(wishlist.id, wishId), eq(wishlist.userId, userId)));
  if (process.env.VITEST || process.env.SLOW_LOOP_DISABLED === "true") return;
  const child = spawn("npx", ["tsx", "scripts/slow-loop.ts", "--wish", wishId], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

/** Wishes the nightly job should build: >= 3 occurrences or priority, still open. */
export async function nightlyCandidates(userId: string) {
  const rows = await db
    .select()
    .from(wishlist)
    .where(
      and(eq(wishlist.userId, userId), eq(wishlist.tombstoned, false), eq(wishlist.status, "open"))
    );
  return rows.filter((r) => r.priority || r.count >= NIGHTLY_THRESHOLD);
}

/**
 * Brief assembly (SPEC §7): wishlist entries + design tokens + one existing
 * component's template vocabulary + the authoring contract.
 */
export function assembleBrief(wish: {
  need: string;
  closestComponent: string;
  signals: string;
  count: number;
}): string {
  const slug = slugify(wish.need);
  return [
    `# Build brief: ${slug}`,
    "",
    `## The need (requested ${wish.count}×)`,
    wish.need,
    `Closest existing component: ${wish.closestComponent}. Signals context when wished: ${wish.signals}`,
    "",
    "## What you produce",
    "Respond with EXACTLY three fenced blocks, nothing else:",
    "1. ```json — meta: {\"name\": \"<kebab-case>\", \"description\": \"<one line>\"}",
    "2. ```html — the TEMPLATE (see contract)",
    "3. ```html — a PREVIEW: the template with realistic hardcoded values",
    "",
    "## Template contract (this is a declarative component, NOT code)",
    "- Allowed tags/attrs: the canvas vocabulary — div/span/p/h1-h4/table/ul/svg",
    "  primitives; style/data-expand/data-link + SVG geometry attrs.",
    "- Do NOT use `class`: the sanitizer keeps only cv-/sl- prefixed tokens and",
    "  drops the rest. Style everything with the style attribute.",
    "  NO scripts, NO event handlers, NO src/href/url(), no external anything.",
    "- Interpolation slots — ONLY these paths exist; anything else renders '—':",
    "  {{project.name}} {{project.deadline}} {{project.days_left}}",
    "  {{project.open_count}} {{project.done_count}} {{project.total_count}}",
    "  ('project' = the most urgent project). Loops: {{#each projects}} …",
    "  {{/each}} with {{name}} {{deadline}} {{days_left}} {{open_count}}",
    "  {{done_count}} {{total_count}} inside. {{context.date}} {{context.weekday}}.",
    "  Do NOT compute with slots inside CSS calc() — emit plain values only.",
    "- Style with CSS variables: var(--bg) var(--card) var(--edge) var(--ink)",
    "  var(--muted) var(--accent) var(--ok) var(--warn) var(--danger).",
    "  Cards: background var(--card), 1px solid var(--edge), radius 12-16px.",
    "- Born visual (SPEC §7.6): zero interactivity beyond data-expand/data-link.",
    "- Every number must trace to a signals path — no invented values.",
  ].join("\n");
}

/** Parse the generation output's three fenced blocks. */
export function parseProposal(output: string): {
  meta: { name: string; description: string };
  template: string;
  preview: string;
} | null {
  const blocks = [...output.matchAll(/```(?:json|html)?\s*\n([\s\S]*?)```/g)].map((m) =>
    m[1].trim()
  );
  if (blocks.length < 3) return null;
  try {
    const meta = JSON.parse(blocks[0]) as { name?: string; description?: string };
    if (!meta.name || !meta.description) return null;
    return {
      meta: { name: slugify(meta.name), description: meta.description },
      template: blocks[1],
      preview: blocks[2],
    };
  } catch {
    return null;
  }
}

export function writeProposal(
  proposal: { meta: { name: string; description: string }; template: string; preview: string },
  brief: string
): string {
  const dir = join(PROPOSED_DIR, proposal.meta.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify(proposal.meta, null, 2));
  writeFileSync(join(dir, "template.html"), proposal.template);
  writeFileSync(join(dir, "preview.html"), proposal.preview);
  writeFileSync(join(dir, "brief.md"), brief);
  return dir;
}

export function readProposal(name: string) {
  const dir = join(PROPOSED_DIR, name);
  if (!existsSync(join(dir, "meta.json"))) return null;
  return {
    meta: JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
      name: string;
      description: string;
    },
    template: readFileSync(join(dir, "template.html"), "utf8"),
    preview: existsSync(join(dir, "preview.html"))
      ? readFileSync(join(dir, "preview.html"), "utf8")
      : "",
  };
}

export function listProposalDirs(): string[] {
  if (!existsSync(PROPOSED_DIR)) return [];
  return readdirSync(PROPOSED_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * Approve: hot-register as a dynamic component (registry version bump, no
 * restart), mark the wish, remove the proposal dir. Never imports anything.
 */
export async function approveProposal(
  userId: string,
  name: string
): Promise<{ ok: true; registryVersion: number } | { ok: false; error: string }> {
  const proposal = readProposal(name);
  if (!proposal) return { ok: false, error: `No proposal "${name}"` };
  const version = (await currentRegistryVersion(userId)) + 1;
  await db.insert(dynamicComponents).values({
    userId,
    name: proposal.meta.name,
    description: proposal.meta.description,
    template: proposal.template,
    registryVersion: version,
  });
  await db
    .update(wishlist)
    .set({ status: "approved", updatedAt: new Date() })
    .where(and(eq(wishlist.userId, userId), eq(wishlist.proposalName, name)));
  rmSync(join(PROPOSED_DIR, name), { recursive: true, force: true });
  return { ok: true, registryVersion: version };
}

/** Reject: tombstone the need (never re-proposed), delete the proposal. */
export async function rejectProposal(userId: string, name: string): Promise<boolean> {
  await db
    .update(wishlist)
    .set({ status: "rejected", tombstoned: true, updatedAt: new Date() })
    .where(and(eq(wishlist.userId, userId), eq(wishlist.proposalName, name)));
  rmSync(join(PROPOSED_DIR, name), { recursive: true, force: true });
  return true;
}

/** {{signals.path}} + {{#each list}} interpolation. Values HTML-escaped; the
 *  result still passes through the canvas sanitizer before rendering.
 *  Convention: `project` = the most urgent project (soonest deadline), and
 *  every project carries a derived `total_count`. */
export function renderTemplate(template: string, signals: Signals): string {
  const enriched = signals.projects.map((p) => ({ ...p, total_count: p.open_count + p.done_count }));
  const urgent = enriched.toSorted(
    (a, b) => (a.days_left ?? Number.MAX_SAFE_INTEGER) - (b.days_left ?? Number.MAX_SAFE_INTEGER)
  )[0];
  const scope = { ...signals, projects: enriched, project: urgent };
  return renderTemplateScope(template, scope);
}

function renderTemplateScope(template: string, signals: unknown): string {
  const esc = (v: unknown) =>
    String(v ?? "—").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const lookup = (obj: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((acc, key) => {
      if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
      return undefined;
    }, obj);

  const renderScope = (tpl: string, scope: unknown): string =>
    tpl
      .replace(/\{\{#each\s+([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_m, path, body) => {
        const list = lookup(scope, String(path).replace(/^signals\./, ""));
        if (!Array.isArray(list)) return "";
        return list.map((item) => renderScope(body, item)).join("");
      })
      .replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_m, path) => {
        const clean = String(path).replace(/^signals\./, "");
        const value = lookup(scope, clean);
        return value === undefined || value === null || (typeof value === "number" && Number.isNaN(value))
          ? "—"
          : esc(value);
      });

  return renderScope(template, signals);
}
