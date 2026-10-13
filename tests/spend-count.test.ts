// docs/spend/SPEC.md (v1.04): the count the caps read is the real one.
// - the all-background cap is $3 when nothing sets it;
// - input written to the prompt cache is priced as a cache write, per model
//   and per lifetime, and the lifetime is stated in one place;
// - the Settings spend card still adds up.
// No model is reached: Claude is a fake that reports usage the way Anthropic
// documents it.
process.env.TZ = "UTC";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { projects, tasks, usage, user } from "@/lib/db/schema";
import { priceUsage } from "@/lib/pricing";
import { cacheControl, PROMPT_CACHE_LIFETIME } from "@/lib/prompt-cache";
import { runClaudeChat } from "@/lib/secretary/chat-claude";
import { executeTool, type ToolContext } from "@/lib/secretary/tools";
import { spendAllTime, spendReport, spendWindow } from "@/lib/spend";
import { backgroundDailyCapUsd, paidCallAllowed } from "@/lib/spend-guard";
import { runProject } from "@/lib/understanding/run";
import { recordUsage } from "@/lib/usage";
import { minimalOutputFor } from "./fixtures/understanding";

const TZ = "America/Los_Angeles";
const users: string[] = [];
async function newUser(): Promise<string> {
  const id = `test-count-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Count", email: `${id}@v104.test`, timezone: TZ });
  return id;
}
const spend = (userId: string, kind: "understanding" | "extraction" | "email" | "layout", usd: number) =>
  db.insert(usage).values({ userId, kind, model: "claude-sonnet-5", costUsd: usd.toFixed(6), createdAt: new Date(Date.now() - 3600_000) });
const rowsOf = (userId: string) => db.select().from(usage).where(eq(usage.userId, userId));
const price = (row: Partial<Parameters<typeof priceUsage>[0]>) =>
  priceUsage({ model: "claude-fable-5", kind: "chat", inputTokens: 0, outputTokens: 0, seconds: 0, ...row });

afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("the all-background cap when nothing sets it", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.BACKGROUND_DAILY_CAP_USD;
    delete process.env.BACKGROUND_DAILY_CAP_USD;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BACKGROUND_DAILY_CAP_USD;
    else process.env.BACKGROUND_DAILY_CAP_USD = saved;
  });

  it("is $3: at $2.99 the next background call runs, at $3.00 it does not", async () => {
    expect(backgroundDailyCapUsd()).toBe(3);
    const userId = await newUser();
    await spend(userId, "understanding", 1.5);
    await spend(userId, "extraction", 1.49);
    for (const kind of ["layout", "extraction", "understanding", "email", "suggestions"] as const) {
      expect((await paidCallAllowed(userId, kind)).ok, `${kind} at $2.99`).toBe(true);
    }
    await spend(userId, "email", 0.01);
    for (const kind of ["layout", "extraction", "understanding", "email", "suggestions"] as const) {
      expect((await paidCallAllowed(userId, kind)).ok, `${kind} at $3.00`).toBe(false);
    }
    expect((await paidCallAllowed(userId, "chat")).ok).toBe(true);
  });

  it("an empty or unreadable setting is the default too, not 'no cap'", () => {
    for (const junk of ["", "  ", "three", "-1", "NaN"]) {
      process.env.BACKGROUND_DAILY_CAP_USD = junk;
      expect(backgroundDailyCapUsd(), JSON.stringify(junk)).toBe(3);
    }
    process.env.BACKGROUND_DAILY_CAP_USD = "5.5";
    expect(backgroundDailyCapUsd()).toBe(5.5);
  });
});

describe("a cache write is priced as a cache write", () => {
  const M = 1_000_000;
  // Read 2026-10-12 from platform.claude.com/docs/en/about-claude/pricing, $ per million tokens.
  const card = [
    { model: "claude-fable-5", input: 10, fiveMin: 12.5, hour: 20 },
    { model: "claude-opus-5", input: 5, fiveMin: 6.25, hour: 10 },
    { model: "claude-sonnet-5", input: 2, fiveMin: 2.5, hour: 4 },
  ];

  it.each(card)("$model: a million tokens written costs the 5-minute or the 1-hour rate, not the input rate", ({ model, input, fiveMin, hour }) => {
    const written = (cacheWriteLifetime: "5m" | "1h") => price({ model, inputTokens: M, cacheWriteInputTokens: M, cacheWriteLifetime });
    expect(written("5m")).toMatchObject({ usd: fiveMin, known: true, estimated: false });
    expect(written("1h")).toMatchObject({ usd: hour, known: true, estimated: false });
    expect(fiveMin).toBeCloseTo(input * 1.25, 10);
    expect(hour).toBeCloseTo(input * 2, 10);
    // The same tokens with no write reported are fresh input, as every row before v1.04 was priced.
    expect(price({ model, inputTokens: M }).usd).toBe(input);
  });

  it("a real first call of a chat turn: fresh, written and read input each at its own rate", () => {
    // 30,000 input tokens: 5,000 fresh, 20,000 written to the cache, 5,000 read from it; 400 out.
    const row = { inputTokens: 30_000, cachedInputTokens: 5_000, cacheWriteInputTokens: 20_000, outputTokens: 400 };
    const usd = (5_000 * 10 + 20_000 * 12.5 + 5_000 * 1 + 400 * 50) / M;
    expect(price({ ...row, cacheWriteLifetime: "5m" }).usd).toBeCloseTo(usd, 10);
    expect(usd).toBeCloseTo(0.325, 10);
    // What the app recorded for the same call until v1.04: the write as fresh input.
    expect(price({ ...row, cacheWriteInputTokens: null }).usd).toBeCloseTo(0.275, 10);
  });

  it("with the lifetime unknown, the write is priced at the dearer rate and the figure is marked a guess", () => {
    const p = price({ inputTokens: M, cacheWriteInputTokens: M });
    expect(p).toMatchObject({ usd: 20, estimated: true });
    expect(p.note).toMatch(/dearer rate/);
  });

  it("a model with no cache-write rate on the card: twice its input rate, marked a guess", () => {
    // An unknown model is already priced at the ceiling ($10 in); its write is twice that.
    expect(price({ model: "claude-some-new-6", inputTokens: M, cacheWriteInputTokens: M, cacheWriteLifetime: "5m" })).toMatchObject({ usd: 20, known: false, estimated: true });
    // A known model whose card entry has no write rate.
    expect(price({ model: "gpt-5.5", inputTokens: M, cacheWriteInputTokens: M, cacheWriteLifetime: "5m" })).toMatchObject({ usd: 10, known: true, estimated: true });
  });

  it("never prices more written tokens than the input that was not read, and never a negative count", () => {
    expect(price({ inputTokens: 1_000, cachedInputTokens: 800, cacheWriteInputTokens: 5_000, cacheWriteLifetime: "5m" }).usd).toBeCloseTo((800 * 1 + 200 * 12.5) / M, 12);
    expect(price({ inputTokens: 1_000, cacheWriteInputTokens: -50, cacheWriteLifetime: "5m" }).usd).toBeCloseTo((1_000 * 10) / M, 12);
  });

  it("a row from before the new rate card is priced as it was", () => {
    const september = new Date("2026-09-20T12:00:00Z");
    const row = { inputTokens: 30_000, cachedInputTokens: 5_000, outputTokens: 400, at: september };
    expect(price(row).usd).toBeCloseTo((25_000 * 10 + 5_000 * 1 + 400 * 50) / M, 10);
  });
});

describe("the lifetime is stated in one place", () => {
  it("is 5 minutes today, the provider's default: the marker carries no ttl; an hour would say so", () => {
    expect(PROMPT_CACHE_LIFETIME).toBe("5m");
    expect(cacheControl()).toEqual({ type: "ephemeral" });
    expect(cacheControl("1h")).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("no request writes its own cache marker: every one takes it from lib/prompt-cache.ts", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    for (const dir of ["lib", "app", "scripts"]) walk(join(process.cwd(), dir));
    const own: string[] = [];
    let marked = 0;
    for (const file of files) {
      if (file.endsWith("lib/prompt-cache.ts")) continue;
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        if (!/cache_control\s*:/.test(line)) continue;
        marked++;
        if (!/cache_control\s*:\s*cacheControl\(\)/.test(line)) own.push(`${file.replace(process.cwd() + "/", "")}:${i + 1}`);
      }
    }
    expect(own).toEqual([]);
    expect(marked).toBeGreaterThanOrEqual(4); // the tools, two instruction blocks, the understanding prompt
  });
});

describe("the recorders report what was written to the cache", () => {
  it("recordUsage stores the count and the price of a 5-minute write; a row without one stores none", async () => {
    const userId = await newUser();
    await recordUsage({ userId, kind: "chat", model: "claude-fable-5", inputTokens: 30_000, cachedInputTokens: 5_000, cacheWriteInputTokens: 20_000, outputTokens: 400 });
    await recordUsage({ userId, kind: "chat", model: "gpt-5.5", inputTokens: 1_000, outputTokens: 100 });
    const rows = await rowsOf(userId);
    const claude = rows.find((r) => r.model === "claude-fable-5")!;
    expect(claude).toMatchObject({ inputTokens: 30_000, cachedInputTokens: 5_000, cacheWriteInputTokens: 20_000, costEstimated: false });
    expect(Number(claude.costUsd)).toBeCloseTo(0.325, 6);
    expect(rows.find((r) => r.model === "gpt-5.5")).toMatchObject({ cacheWriteInputTokens: null, costEstimated: false });
  });

  it("a chat turn on Claude: the first round's write and the second round's read are both carried out of the loop", async () => {
    const userId = await newUser();
    let round = 0;
    const seen: unknown[] = [];
    const client = {
      messages: {
        create: async (req: { tools: { cache_control?: unknown }[]; system: { cache_control?: unknown }[] }) => {
          seen.push(req.tools.at(-1)?.cache_control, ...req.system.map((b) => b.cache_control));
          round++;
          return round === 1
            ? { content: [{ type: "tool_use", id: "t1", name: "get_layout_plan", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: 24_000, cache_read_input_tokens: 0 } }
            : { content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: { input_tokens: 400, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 24_000 } };
        },
      },
    } as unknown as Anthropic;
    const ctx: ToolContext = { userId, timezone: TZ };
    const result = await runClaudeChat({ client, model: "claude-fable-5", effort: "low", instructions: { stable: "S", live: "L" }, history: [], message: "hi", attachments: [], toolCtx: ctx, executeTool });
    expect(result).toMatchObject({ inputTokens: 120 + 24_000 + 400 + 300 + 24_000, cachedInputTokens: 24_000, cacheWriteInputTokens: 24_300, outputTokens: 50 });
    // Every marker the request carried is the one from the one place.
    expect(seen).toHaveLength(6);
    for (const marker of seen) expect(marker).toEqual(cacheControl());
  });

  it("an understanding run: the write the model call reports is in the usage row, priced as a write", async () => {
    const userId = await newUser();
    const [p] = await db.insert(projects).values({ userId, name: "Boat" }).returning();
    await db.insert(tasks).values({ userId, projectId: p.id, title: "Service the boat", status: "todo" });
    const model = Object.assign(
      async (input: { bundle: Parameters<typeof minimalOutputFor>[0] }) => ({
        output: minimalOutputFor(input.bundle),
        model: "claude-sonnet-5",
        inputTokens: 30_000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 26_000,
        outputTokens: 2_000,
      }),
      { modelName: "claude-sonnet-5" }
    );
    const result = await runProject(userId, p.id, { timezone: TZ, model: model as never });
    expect(result.status).toBe("ok");
    const [row] = await rowsOf(userId);
    expect(row).toMatchObject({ kind: "understanding", inputTokens: 30_000, cacheWriteInputTokens: 26_000 });
    expect(Number(row.costUsd)).toBeCloseTo((4_000 * 2 + 26_000 * 2.5 + 2_000 * 10) / 1_000_000, 6);
  });
});

describe("the Settings spend card still adds up", () => {
  it("the day's total, each kind's line and the all-time figure are the sum of the stored costs, cache writes included", async () => {
    const userId = await newUser();
    await recordUsage({ userId, kind: "chat", model: "claude-fable-5", inputTokens: 30_000, cachedInputTokens: 5_000, cacheWriteInputTokens: 20_000, outputTokens: 400 });
    await recordUsage({ userId, kind: "chat", model: "claude-fable-5", inputTokens: 30_000, cachedInputTokens: 29_000, cacheWriteInputTokens: 0, outputTokens: 400 });
    await recordUsage({ userId, kind: "understanding", model: "claude-sonnet-5", inputTokens: 30_000, cacheWriteInputTokens: 26_000, outputTokens: 2_000 });
    await recordUsage({ userId, kind: "extraction", model: "gpt-5.5", inputTokens: 2_000, outputTokens: 300 });
    const rows = await rowsOf(userId);
    const stored = rows.reduce((sum, r) => sum + Number(r.costUsd), 0);
    const report = await spendReport(userId, spendWindow("day", 0, TZ), TZ);
    expect(report.totalUsd).toBeCloseTo(stored, 6);
    const kinds = Object.fromEntries(report.byKind.map((b) => [b.key, b.usd]));
    expect(kinds.chat).toBeCloseTo(0.325 + (1_000 * 10 + 29_000 * 1 + 400 * 50) / 1_000_000, 6);
    expect(report.byKind.reduce((sum, b) => sum + b.usd, 0)).toBeCloseTo(report.totalUsd, 6);
    expect(report.byModel.reduce((sum, b) => sum + b.usd, 0)).toBeCloseTo(report.totalUsd, 6);
    expect((await spendAllTime(userId)).usd).toBeCloseTo(stored, 6);
    expect(report.totalUsd).toBeGreaterThan(0.4);
  });
});
