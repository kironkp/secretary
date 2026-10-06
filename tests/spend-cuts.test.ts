// SEC-A004: the background calls that paid for nothing. OpenAI is replaced by
// a counting fake for this file (vi.mock), so no model is reached; the key
// below only makes the code take its OpenAI road, and is never sent.
process.env.TZ = "UTC";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const openaiCalls = vi.hoisted(() => ({ extraction: 0, suggestions: 0, gate: null as null | Promise<void>, suggestionsFail: false }));
const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; timezone: string } }));

vi.mock("@/lib/openai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/openai")>();
  const empty = { tasks: [], events: [], status_updates: [], facts: [], mentions: [], ambiguities: [] };
  return {
    ...real,
    openai: {
      responses: {
        create: async (req: { text?: { format?: { name?: string } } }) => {
          const name = req.text?.format?.name;
          if (name === "extraction") {
            openaiCalls.extraction++;
            if (openaiCalls.gate) await openaiCalls.gate;
            return { output_text: JSON.stringify(empty), usage: { input_tokens: 2000, output_tokens: 300 } };
          }
          if (name === "suggestions") {
            openaiCalls.suggestions++;
            if (openaiCalls.suggestionsFail) throw new Error("503 upstream");
            // "An empty list is the right answer most days."
            return { output_text: JSON.stringify({ suggestions: [] }), usage: { input_tokens: 5000, output_tokens: 50 } };
          }
          throw new Error(`unexpected OpenAI call ${String(name)}`);
        },
      },
    },
  };
});
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return {
    ...real,
    requireSession: async () => session.user ?? NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
  };
});

import { db } from "@/lib/db";
import { conversations, messages, tasks, usage, user } from "@/lib/db/schema";
import { runExtraction } from "@/lib/secretary/extraction";
import { forgetSuggestionAttemptsForTests } from "@/lib/secretary/suggestions";
import { POST as testToken } from "@/app/api/realtime/token-test/route";

process.env.OPENAI_API_KEY = "test-not-sent";
const TZ = "America/Los_Angeles";
const users: string[] = [];

async function userWithConversation(): Promise<{ userId: string; conversationId: string }> {
  const userId = `test-spend-cuts-${crypto.randomUUID()}`;
  users.push(userId);
  await db.insert(user).values({ id: userId, name: "Cuts", email: `${userId}@sec-a004.test`, timezone: TZ });
  const [conv] = await db.insert(conversations).values({ userId, mode: "voice" }).returning();
  return { userId, conversationId: conv.id };
}
const say = (userId: string, conversationId: string, content: string) =>
  db.insert(messages).values({ userId, conversationId, role: "user", content, mode: "voice" });

beforeEach(() => {
  openaiCalls.extraction = 0;
  openaiCalls.suggestions = 0;
  openaiCalls.gate = null;
  openaiCalls.suggestionsFail = false;
});
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

// The first test pays runExtraction's lazy imports on a cold start; under load
// that crossed vitest's 5 s default. An explicit ceiling, not a flake.
describe("extraction: one paid read per burst, never two of the same words", { timeout: 30_000 }, () => {
  it("three utterances in a burst start one extraction, not three", async () => {
    const { userId, conversationId } = await userWithConversation();
    await say(userId, conversationId, "Remind me to call the dentist");
    await say(userId, conversationId, "and to buy stamps");
    await say(userId, conversationId, "and the CPO is due Friday");
    await Promise.all([1, 2, 3].map(() => runExtraction(userId, conversationId, TZ)));
    expect(openaiCalls.extraction).toBe(1);
  });

  it("words spoken while a read is running get one follow-up read, of only what is new", async () => {
    const { userId, conversationId } = await userWithConversation();
    await say(userId, conversationId, "First thing");
    let release!: () => void;
    openaiCalls.gate = new Promise<void>((r) => (release = r));
    const first = runExtraction(userId, conversationId, TZ);
    await vi.waitFor(() => expect(openaiCalls.extraction).toBe(1));
    await say(userId, conversationId, "Second thing");
    const second = runExtraction(userId, conversationId, TZ);
    const third = runExtraction(userId, conversationId, TZ);
    openaiCalls.gate = null;
    release();
    await Promise.all([first, second, third]);
    expect(openaiCalls.extraction).toBe(2);
  });

  it("each read is priced, so the spend line, the alert and the caps see it", async () => {
    const { userId, conversationId } = await userWithConversation();
    await say(userId, conversationId, "Book the boat slip");
    await runExtraction(userId, conversationId, TZ);
    const [row] = await db.select().from(usage).where(and(eq(usage.userId, userId), eq(usage.kind, "extraction")));
    expect(row.costUsd).not.toBeNull();
    expect(Number(row.costUsd)).toBeGreaterThan(0);
  });
});

describe("suggestions: at most once a day, even when the answer is an empty list", { timeout: 30_000 }, () => {
  it("a second extraction the same day makes no second suggestions call", async () => {
    const { userId, conversationId } = await userWithConversation();
    // Enough to predict from (suggestions skips a near-empty board).
    for (const title of ["Renew passport", "File taxes", "Service the boat"]) {
      await db.insert(tasks).values({ userId, title, status: "todo" });
    }
    await say(userId, conversationId, "One thing");
    await runExtraction(userId, conversationId, TZ);
    await say(userId, conversationId, "Another thing");
    await runExtraction(userId, conversationId, TZ);
    expect(openaiCalls.extraction).toBe(2);
    expect(openaiCalls.suggestions).toBe(1);
  });
});

describe("suggestions: the day stays closed across a restart and after a failure", { timeout: 30_000 }, () => {
  async function busyUser() {
    const u = await userWithConversation();
    for (const title of ["Renew passport", "File taxes", "Service the boat"]) {
      await db.insert(tasks).values({ userId: u.userId, title, status: "todo" });
    }
    return u;
  }

  it("after a restart, today's recorded call still closes the day", async () => {
    const { userId, conversationId } = await busyUser();
    await say(userId, conversationId, "One thing");
    await runExtraction(userId, conversationId, TZ);
    forgetSuggestionAttemptsForTests(); // the process restarted
    await say(userId, conversationId, "Another thing");
    await runExtraction(userId, conversationId, TZ);
    expect(openaiCalls.suggestions).toBe(1);
  });

  it("a failed call (nothing recorded) still closes the day in this process", async () => {
    const { userId, conversationId } = await busyUser();
    openaiCalls.suggestionsFail = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await say(userId, conversationId, "One thing");
      await runExtraction(userId, conversationId, TZ);
      await say(userId, conversationId, "Another thing");
      await runExtraction(userId, conversationId, TZ);
    } finally {
      quiet.mockRestore();
    }
    expect(openaiCalls.suggestions).toBe(1);
  });
});

describe("the voicetest token is a development tool", { timeout: 30_000 }, () => {
  it("refuses in production: no quota, no usage row, so no house-key session", async () => {
    const { userId } = await userWithConversation();
    session.user = { id: userId, email: `${userId}@sec-a004.test`, name: "Cuts", timezone: TZ };
    vi.stubEnv("NODE_ENV", "production");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await testToken();
      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
