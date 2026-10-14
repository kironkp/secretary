// docs/spend/SPEC.md §1.1 (v1.04): every recorder that talks to Claude
// reports what was written to the prompt cache, from the usage the API
// returns to the row in `usage`. Through the real entry points: the chat
// route, the understanding run's own Claude call, a run that fails after
// answering, and the one-sentence read. Claude is a fake that reports usage
// the way Anthropic documents it; nothing leaves the machine.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; timezone: string } }));
/** What the fake Claude reports for its next answers, by the API it is asked through. */
const claude = vi.hoisted(() => ({
  usage: { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 24_000, cache_read_input_tokens: 3_000 },
  text: "Noted.",
  parsed: null as unknown,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return { ...real, requireSession: async () => session.user ?? NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
});
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/anthropic", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/anthropic")>();
  const answer = () => ({ content: [{ type: "text", text: claude.text }], stop_reason: "end_turn", usage: claude.usage, parsed_output: claude.parsed });
  const { streamedFrom } = await import("@/tests/fixtures/claude-stream");
  const client = { messages: { create: async () => answer(), parse: async () => answer(), stream: streamedFrom(async () => answer()) } };
  return {
    ...real,
    chatSettings: async () => ({ model: "claude-sonnet-5", effort: "low" }),
    brainSettings: async () => ({ model: "claude-opus-5", effort: "high" }),
    claudeBrainEnabled: () => true,
    anthropicClientFor: async () => ({ client, source: "house" }),
    anthropicFor: async () => client,
  };
});
vi.mock("@/lib/openai", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/openai")>()), openaiClientFor: async () => null }));

import { db } from "@/lib/db";
import { projects, tasks, usage, user } from "@/lib/db/schema";
import { cardFor, rateFor } from "@/lib/pricing";
import { interpretAnswer } from "@/lib/understanding/interpret";
import { anthropicModelCall, ModelOutputError, runProject, type ModelCall } from "@/lib/understanding/run";
import type { QuestionView } from "@/lib/understanding/today";
import type { Bundle } from "@/lib/understanding/types";
import { POST as chat } from "@/app/api/chat/route";

const U = { id: `test-count-claude-${crypto.randomUUID()}`, email: `count-claude-${Date.now()}@v104.test`, name: "Count", timezone: "America/Los_Angeles" };
const rows = (kind: "chat" | "understanding") => db.select().from(usage).where(and(eq(usage.userId, U.id), eq(usage.kind, kind)));
const clear = () => db.delete(usage).where(eq(usage.userId, U.id));
const M = 1_000_000;

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: U.name, email: U.email, timezone: U.timezone });
  session.user = U;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("the new rate card", () => {
  it("takes effect on 2026-10-12: the day before, a Claude model has no cache-write rate; from that day it has", () => {
    const before = rateFor("claude-fable-5", new Date("2026-10-11T23:00:00Z")).rate;
    const from = rateFor("claude-fable-5", new Date("2026-10-12T01:00:00Z")).rate;
    expect(before).toMatchObject({ kind: "per_token", input: 10, output: 50, cachedInput: 1 });
    expect("cacheWrite" in before).toBe(false);
    expect(from).toMatchObject({ cacheWrite: { "5m": 12.5, "1h": 20 } });
    expect(cardFor(new Date("2026-10-11T23:00:00Z")).effectiveFrom).toBe("2026-09-01");
    expect(cardFor(new Date("2026-10-12T01:00:00Z"))).toMatchObject({ effectiveFrom: "2026-10-12", asOf: "2026-10-12" });
    // Nothing else moved between the two cards.
    for (const model of ["gpt-5.5", "claude-opus-5", "claude-sonnet-5", "gpt-realtime-2.1"]) {
      const a = rateFor(model, new Date("2026-10-11T23:00:00Z")).rate as Record<string, unknown>;
      const b = { ...(rateFor(model, new Date("2026-10-12T01:00:00Z")).rate as Record<string, unknown>) };
      delete b.cacheWrite;
      expect(b, model).toEqual(a);
    }
  });
});

describe("what was written to the cache reaches the usage row", { timeout: 30_000 }, () => {
  it("a chat turn through the route: the write Claude reports is on the row and priced as a write", async () => {
    await clear();
    claude.usage = { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 24_000, cache_read_input_tokens: 3_000 };
    claude.text = "Noted.";
    const res = await chat(new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hello" }) }));
    expect(res.status).toBe(200);
    const [row] = await rows("chat");
    expect(row).toMatchObject({ model: "claude-sonnet-5", inputTokens: 27_120, cachedInputTokens: 3_000, cacheWriteInputTokens: 24_000, outputTokens: 30, costEstimated: false });
    expect(Number(row.costUsd)).toBeCloseTo((120 * 2 + 24_000 * 2.5 + 3_000 * 0.2 + 30 * 10) / M, 6);
  });

  it("the understanding run's own Claude call: the write is in what it bills, when the answer is used and when it is thrown away", async () => {
    vi.stubEnv("VITEST", ""); // the real call builder returns nothing under vitest
    vi.stubEnv("UNDERSTANDING_DISABLED", "false");
    const call = (await anthropicModelCall(U.id)) as ModelCall;
    expect(call).toBeTruthy();
    claude.usage = { input_tokens: 4_000, output_tokens: 2_000, cache_creation_input_tokens: 26_000, cache_read_input_tokens: 500 };
    claude.text = "this is not JSON";
    const input = { system: "s", user: "u", bundle: {} as Bundle, attempt: 0, previousErrors: [] };
    const thrown = await call(input).then(() => null, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(ModelOutputError);
    expect((thrown as ModelOutputError).usage).toMatchObject({ inputTokens: 30_500, cachedInputTokens: 500, cacheWriteInputTokens: 26_000, outputTokens: 2_000 });
    claude.text = JSON.stringify({ anything: true });
    const answered = await call(input);
    expect(answered).toMatchObject({ inputTokens: 30_500, cachedInputTokens: 500, cacheWriteInputTokens: 26_000, outputTokens: 2_000 });
  });

  it("a run that fails after the model answered: every attempt's write is added up on the row", async () => {
    await clear();
    const [p] = await db.insert(projects).values({ userId: U.id, name: "Boat" }).returning();
    await db.insert(tasks).values({ userId: U.id, projectId: p.id, title: "Service the boat", status: "todo" });
    let attempts = 0;
    const model = Object.assign(
      async () => {
        attempts++;
        throw new ModelOutputError("not JSON", { model: "claude-sonnet-5", inputTokens: 30_000, cachedInputTokens: 0, cacheWriteInputTokens: 26_000, outputTokens: 100 });
      },
      { modelName: "claude-sonnet-5" }
    );
    const result = await runProject(U.id, p.id, { timezone: U.timezone, model: model as never });
    expect(result.status).toBe("failed");
    expect(attempts).toBeGreaterThan(0);
    const [row] = await rows("understanding");
    expect(row).toMatchObject({ inputTokens: 30_000 * attempts, cacheWriteInputTokens: 26_000 * attempts, outputTokens: 100 * attempts });
    expect(Number(row.costUsd)).toBeCloseTo((attempts * (4_000 * 2 + 26_000 * 2.5 + 100 * 10)) / M, 6);
  });

  it("the one-sentence read: through Claude itself, the write is on the row", async () => {
    await clear();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("UNDERSTANDING_DISABLED", "false");
    vi.stubEnv("UNDERSTANDING_PROVIDER", "anthropic");
    claude.usage = { input_tokens: 900, output_tokens: 40, cache_creation_input_tokens: 1_500, cache_read_input_tokens: 0 };
    claude.parsed = { answerId: null, writes: [], fact: null, process: null, reply: "Noted." };
    const question = { id: "q1", question: "Is the boat serviced?", why: "", context: "", projectName: "Boat", kind: "doesnt_add_up", answers: [], evidence: [], evidenceView: [], kindLabel: "Does not add up" } as unknown as QuestionView;
    const read = await interpretAnswer(U.id, U.timezone, question, "yes it is");
    expect(read.reply).toBe("Noted.");
    const [row] = await rows("understanding");
    expect(row).toMatchObject({ inputTokens: 2_400, cachedInputTokens: 0, cacheWriteInputTokens: 1_500, outputTokens: 40 });
  });
});
