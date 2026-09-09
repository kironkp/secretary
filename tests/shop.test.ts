// The Shop (self-improvement loop): filing, dedupe, the single-flight lane,
// the approval gate, and the prompts that carry the guardrails. VITEST guards
// mean nothing ever spawns here — status rows are the observable truth.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { capabilityRequests, user } from "@/lib/db/schema";
import {
  approveRequest,
  buildPrompt,
  fileRequest,
  findRequest,
  kickQueue,
  planPrompt,
  rejectRequest,
  reviseRequest,
  shopSlug,
} from "@/lib/shop/shop";
import { anthropicToolDefs, openAIToolDefs, VOICE_TOOL_NAMES } from "@/lib/secretary/tool-schemas";
import { buildInstructions } from "@/lib/secretary/persona";
import { titleSimilarity } from "@/lib/secretary/dedupe";

const U = { id: `test-shop-${crypto.randomUUID()}`, email: `shop-${Date.now()}@shop.test` };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Shop Tester", email: U.email });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("filing and the single-flight lane", () => {
  it("first request goes straight to planning (spawn suppressed under VITEST)", async () => {
    const res = await fileRequest(U.id, "Remember reporting preferences per report", "ctx", undefined, U.id);
    expect(res.deduped).toBe(false);
    expect(res.status).toBe("planning");
  });

  it("a second request queues as filed while the lane is busy", async () => {
    const res = await fileRequest(U.id, "Export tasks to a CSV file", undefined, undefined, U.id);
    expect(res.status).toBe("filed");
    expect(res.queued).toBe(true);
  });

  it("dedupes by normalized need — no twin rows, no re-nag after reject", async () => {
    const dup = await fileRequest(U.id, "  remember REPORTING preferences per report ", undefined, undefined, U.id);
    expect(dup.deduped).toBe(true);

    const csv = await findRequest(U.id, "csv");
    await rejectRequest(U.id, csv!.id);
    const again = await fileRequest(U.id, "Export tasks to a CSV file", undefined, undefined, U.id);
    expect(again.deduped).toBe(true); // rejected twin returned, not re-filed
    expect(again.status).toBe("rejected");
  });
});

describe("the approval gate", () => {
  it("only a planned request can be approved; a busy lane QUEUES instead of bouncing", async () => {
    const req = await findRequest(U.id, "reporting preferences");
    // still "planning" — not approvable
    const early = await approveRequest(U.id, req!.id, U.id);
    expect(early.ok).toBe(false);

    // Second request occupies the lane (planning) → approve queues, never errors.
    await db
      .update(capabilityRequests)
      .set({ status: "planned", plan: "1. Do the thing." })
      .where(eq(capabilityRequests.id, req!.id));
    const res = await approveRequest(U.id, req!.id, U.id);
    expect(res.ok).toBe(true);
    if (res.ok) expect(typeof res.queued).toBe("boolean");
    const after = await findRequest(U.id, "reporting preferences");
    // free lane → atomically claimed to building; busy lane → parked approved
    expect(["approved", "building"]).toContain(after!.status);
  });

  it("kickQueue claims an approved build first when the lane is clear", async () => {
    // Clear OUR lane only. laneScope (the HEAD fix) makes this suite fully
    // isolated — it supersedes the branch's foreign-row workaround for the
    // same bug (the shop's own build holding the global lane mid-suite).
    await db
      .update(capabilityRequests)
      .set({ status: "planned" })
      .where(and(eq(capabilityRequests.userId, U.id), eq(capabilityRequests.status, "planning")));
    await kickQueue(U.id);
    const req = await findRequest(U.id, "reporting preferences");
    expect(req!.status).toBe("building"); // claimed (spawn suppressed under VITEST)
  });

  it("feedback re-enters planning with the old plan + notes in the prompt", async () => {
    const req = await findRequest(U.id, "reporting preferences");
    await db
      .update(capabilityRequests)
      .set({ status: "planned", plan: "old plan v1" })
      .where(eq(capabilityRequests.id, req!.id));
    const res = await reviseRequest(U.id, req!.id, "also cover voice calls", U.id);
    expect(res.ok).toBe(true);
    const after = await findRequest(U.id, "reporting preferences");
    expect(["filed", "planning"]).toContain(after!.status); // kickQueue may claim it
    expect(after!.feedback).toContain("also cover voice calls");

    const prompt = planPrompt(after!);
    expect(prompt).toContain("old plan v1");
    expect(prompt).toContain("also cover voice calls");
    expect(prompt).toContain("REVISE");
  });

  it("fuzzy find matches by need fragment", async () => {
    expect(await findRequest(U.id, "REPORTING")).toBeTruthy();
    expect(await findRequest(U.id, "no such thing")).toBeNull();
  });
});

describe("prompts carry the guardrails", () => {
  it("plan prompt: the need, the law, and no-code orders", () => {
    const p = planPrompt({ need: "Do X", context: "user said Y" });
    expect(p).toContain("Do X");
    expect(p).toContain("user said Y");
    expect(p).toContain("CLAUDE.md");
    expect(p).toContain("Do NOT write the implementation");
  });

  it("build prompt: hard constraints, verification orders, commit discipline", () => {
    const p = buildPrompt({ need: "Do X", plan: "the plan" });
    expect(p).toContain("NEVER touch lib/auth.ts, .env.local");
    expect(p).toContain("npx tsc --noEmit && npm run lint && npm test");
    expect(p).toContain("ADDITIVE ONLY");
    expect(p).toContain("Shop: ");
    expect(p).toContain("the plan");
  });

  it("ultracode leads the build prompt when chosen; absent otherwise", () => {
    expect(buildPrompt({ need: "X", plan: "p", ultracode: true }).startsWith("ultracode\n")).toBe(true);
    expect(buildPrompt({ need: "X", plan: "p" })).not.toContain("ultracode");
  });

  it("approve stores per-request build prefs; bogus values are refused", async () => {
    const req = await findRequest(U.id, "reporting preferences");
    await db
      .update(capabilityRequests)
      .set({ status: "planned" })
      .where(eq(capabilityRequests.id, req!.id));
    const bad = await approveRequest(U.id, req!.id, U.id, { model: "gpt-9" });
    expect(bad.ok).toBe(false);
    const res = await approveRequest(U.id, req!.id, U.id, {
      model: "opus",
      effort: "max",
      ultracode: false,
    });
    expect(res.ok).toBe(true);
    const after = await findRequest(U.id, "reporting preferences");
    expect(after!.buildModel).toBe("opus");
    expect(after!.buildEffort).toBe("max");
    expect(after!.ultracode).toBe(false);
  });

  it("double approval loses: the status-guarded write refuses an already-handled request", async () => {
    const req = await findRequest(U.id, "reporting preferences");
    // previous test left it approved→building (free lane claims immediately)
    const second = await approveRequest(U.id, req!.id, U.id, { model: "sonnet" });
    expect(second.ok).toBe(false);
    const after = await findRequest(U.id, "reporting preferences");
    expect(after!.buildModel).toBe("opus"); // first approval's prefs untouched
  });

  it('""-means-default contract: empty prefs store NULL, and NULL emits no CLI flags', async () => {
    const filed = await fileRequest(U.id, "Colorize the timeline", undefined, undefined, U.id);
    await db
      .update(capabilityRequests)
      .set({ status: "planned" })
      .where(eq(capabilityRequests.id, filed.id));
    const res = await approveRequest(U.id, filed.id, U.id, { model: "", effort: "", ultracode: true });
    expect(res.ok).toBe(true);
    const [row] = await db
      .select()
      .from(capabilityRequests)
      .where(eq(capabilityRequests.id, filed.id));
    expect(row.buildModel).toBeNull();
    expect(row.buildEffort).toBeNull();
    // the runner's flag builder pattern: null → no flag entries
    const flags = [
      ...(row.buildModel ? ["--model", row.buildModel] : []),
      ...(row.buildEffort ? ["--effort", row.buildEffort] : []),
    ];
    expect(flags).toEqual([]);
  });

  it("slug is filesystem/branch-safe", () => {
    expect(shopSlug("Remember: reporting preferences (per report!)")).toBe(
      "remember-reporting-preferences-per-report"
    );
  });
});

describe("the dead-end killer is wired in", () => {
  it("request_capability + review_capability ride voice and both chat providers", () => {
    expect(VOICE_TOOL_NAMES).toContain("request_capability");
    expect(VOICE_TOOL_NAMES).toContain("review_capability");
    expect(openAIToolDefs().some((t) => t.name === "request_capability")).toBe(true);
    expect(anthropicToolDefs().some((t) => t.name === "review_capability")).toBe(true);
  });

  it("the persona forbids dead-ending on a missing tool", () => {
    const instructions = buildInstructions("BRIEFING", { persona: null });
    expect(instructions).toContain("NEVER the end of the sentence");
    expect(instructions).toContain("request_capability");
  });
});

// The circle this prevents: the canvas-checkbox ability was filed FOUR times
// under four phrasings, twice AFTER it had already shipped, because dedupe
// compared exact normalized strings and the model rewords the ask every time.
describe("the shop recognises the same ask worded differently", () => {
  const SHIPPED =
    "Make canvas items clickable so the user can check them off directly on the canvas and have those changes update the underlying tasks and commitments.";
  const REPHRASED =
    "Make checkboxes on the Canvas directly clickable so the user can mark items complete or unchecked from the visual view";

  it("scores a real-world rephrasing above the dedupe threshold", () => {
    expect(titleSimilarity(SHIPPED, REPHRASED)).toBeGreaterThanOrEqual(0.5);
  });

  it("and keeps genuinely different asks well below it", () => {
    for (const other of [
      "Set a push notification reminder at a specific time without creating a new task",
      "Reorder projects in the dashboard, including moving a chosen project to the top",
      "Add spend tracking so I can see where my API money goes",
    ]) {
      expect(titleSimilarity(SHIPPED, other)).toBeLessThan(0.4);
    }
  });

  it("returns the shipped twin instead of filing a second build", async () => {
    // Its own user, so the shared lane and the suite's other rows can't skew it.
    const u = `test-dupe-${crypto.randomUUID()}`;
    await db.insert(user).values({ id: u, name: "Dupe Tester", email: `${u}@shop.test` });
    const first = await fileRequest(u, SHIPPED, undefined, undefined, u);
    await db
      .update(capabilityRequests)
      .set({ status: "shipped" })
      .where(eq(capabilityRequests.id, first.id));

    const second = await fileRequest(u, REPHRASED, undefined, undefined, u);
    expect(second.id).toBe(first.id);
    expect(second.deduped).toBe(true);
    // The signal the tool uses to tell the user it already exists.
    expect(second.alreadyExists).toBe(true);

    const rows = await db
      .select()
      .from(capabilityRequests)
      .where(eq(capabilityRequests.userId, u));
    expect(rows).toHaveLength(1); // no duplicate row was created
    await db.delete(user).where(eq(user.id, u));
  });
});
