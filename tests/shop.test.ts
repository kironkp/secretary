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
    expect(after!.status).toBe("approved");
  });

  it("kickQueue claims an approved build first when the lane is clear", async () => {
    // clear the lane (no planning/building anywhere for this run)
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
    expect(p).toContain("Shop: ");
    expect(p).toContain("the plan");
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
