// SEC-A004: the global safety net. BACKGROUND_DAILY_CAP_USD (default $4) over
// everything that runs with no one asking; SPEND_KILL=true refuses every paid
// call but the user's own chat or voice turn. Either pushes once a day. OpenAI
// is a counting fake here; nothing leaves the machine.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";

const calls = vi.hoisted(() => ({ extraction: 0 }));
vi.mock("@/lib/openai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/openai")>();
  return {
    ...real,
    openai: {
      responses: {
        create: async () => {
          calls.extraction++;
          return {
            output_text: JSON.stringify({ tasks: [], events: [], status_updates: [], facts: [], mentions: [], ambiguities: [] }),
            usage: { input_tokens: 100, output_tokens: 10 },
          };
        },
      },
    },
  };
});

import { db } from "@/lib/db";
import { conversations, messages, projects, pushLog, tasks, usage, user } from "@/lib/db/schema";
import { backgroundDailyCapUsd, paidCallAllowed } from "@/lib/spend-guard";
import { runExtraction } from "@/lib/secretary/extraction";
import { executeTool } from "@/lib/secretary/tools";
import { runProject } from "@/lib/understanding/run";
import { fakeModel, minimalOutputFor } from "./fixtures/understanding";

process.env.OPENAI_API_KEY = "test-not-sent";
const TZ = "America/Los_Angeles";
const users: string[] = [];

async function newUser(): Promise<string> {
  const id = `test-net-${crypto.randomUUID()}`;
  users.push(id);
  await db.insert(user).values({ id, name: "Net", email: `${id}@sec-a004.test`, timezone: TZ });
  return id;
}
const spend = (userId: string, kind: "understanding" | "extraction" | "other" | "chat", usd: number, model = "claude-opus-5") =>
  db.insert(usage).values({ userId, kind, model, costUsd: usd.toFixed(6), createdAt: new Date(Date.now() - 3600_000) });
const pushes = (userId: string, key: string) =>
  db.select().from(pushLog).where(and(eq(pushLog.userId, userId), like(pushLog.key, `${key}:%`)));

beforeEach(() => {
  calls.extraction = 0;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("BACKGROUND_DAILY_CAP_USD: all background work together, $4 a day by default", () => {
  it("counts understanding, extraction and suggestions together; not chat, not a web search", async () => {
    expect(backgroundDailyCapUsd()).toBe(4);
    const userId = await newUser();
    await spend(userId, "chat", 10);
    await spend(userId, "other", 10, "gpt-5.4-mini"); // search_web
    expect((await paidCallAllowed(userId, "extraction")).ok).toBe(true);
    await spend(userId, "understanding", 2);
    await spend(userId, "extraction", 1);
    expect((await paidCallAllowed(userId, "extraction")).ok).toBe(true);
    await spend(userId, "other", 1, "gpt-5.5"); // suggestions
    expect((await paidCallAllowed(userId, "extraction")).ok).toBe(false);
    expect((await paidCallAllowed(userId, "chat")).ok).toBe(true);
    expect((await paidCallAllowed(userId, "search")).ok).toBe(true);
    await paidCallAllowed(userId, "layout");
    expect(await pushes(userId, "background-cap")).toHaveLength(1);
  });

  it("at the cap, extraction and understanding make no call at all", async () => {
    const userId = await newUser();
    await spend(userId, "understanding", 4);
    const [conv] = await db.insert(conversations).values({ userId, mode: "voice" }).returning();
    await db.insert(messages).values({ userId, conversationId: conv.id, role: "user", content: "remind me about the boat", mode: "voice" });
    await runExtraction(userId, conv.id, TZ);
    expect(calls.extraction).toBe(0);

    const [p] = await db.insert(projects).values({ userId, name: "Boat" }).returning();
    await db.insert(tasks).values({ userId, projectId: p.id, title: "Service the boat", status: "todo" });
    const model = fakeModel((bundle) => minimalOutputFor(bundle));
    const result = await runProject(userId, p.id, { timezone: TZ, model });
    expect(result).toEqual({ status: "skipped", reason: "budget" });
    expect(model.calls).toHaveLength(0);
  });

  it("set to 0, background work is off", async () => {
    vi.stubEnv("BACKGROUND_DAILY_CAP_USD", "0");
    const userId = await newUser();
    expect((await paidCallAllowed(userId, "understanding")).ok).toBe(false);
    expect((await paidCallAllowed(userId, "chat")).ok).toBe(true);
  });
});

describe("SPEND_KILL=true: only the user's own chat and calls", () => {
  it("lets chat, calls, dictation and read-aloud through, and nothing else; one push", async () => {
    vi.stubEnv("SPEND_KILL", "true");
    const userId = await newUser();
    for (const kind of ["chat", "voice", "transcribe", "speech"] as const) {
      expect((await paidCallAllowed(userId, kind)).ok, kind).toBe(true);
    }
    for (const kind of ["understanding", "extraction", "suggestions", "layout", "paint", "consult", "search", "interpret", "email"] as const) {
      expect((await paidCallAllowed(userId, kind)).ok, kind).toBe(false);
    }
    expect(await pushes(userId, "spend-kill")).toHaveLength(1);
  });

  it("a tool the model reaches for says it is switched off, and calls nothing", async () => {
    vi.stubEnv("SPEND_KILL", "true");
    const userId = await newUser();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const out = await executeTool({ userId, timezone: TZ }, "search_web", { query: "boat slip prices" });
      expect(String((out.result as { error: string }).error)).toMatch(/SPEND_KILL/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    const [conv] = await db.insert(conversations).values({ userId, mode: "voice" }).returning();
    await db.insert(messages).values({ userId, conversationId: conv.id, role: "user", content: "remind me", mode: "voice" });
    await runExtraction(userId, conv.id, TZ);
    expect(calls.extraction).toBe(0);
  });
});
