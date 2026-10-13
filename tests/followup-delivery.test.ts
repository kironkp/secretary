// v1.03: a promised follow-up ("I'll be asking") is asked, once, at the start
// of the next conversation, however many pages were opened in between
// (docs/adaptive-ui/SPEC.md §11). Before this, every briefing build turned a
// due expectation from open to missed, and the chat dock builds one on every
// page load, so the promise was gone before anyone spoke.
//
// Through the real entry points, against the local database: the dock's
// bootstrap, the briefing card, consult_brain, the chat route and the voice
// token route. The session and the providers are fakes; nothing leaves the
// machine. What the model was handed is read off the fake.
process.env.TZ = "UTC";
process.env.VOICE_DISABLED = "false";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; timezone: string } }));
/** The fake model: what it was last handed, and whether it answers. */
const model = vi.hoisted(() => ({ fail: false, calls: 0, system: "", user: "" }));
/** The fake Realtime mint: the instructions it was sent, and whether it accepts them. */
const mint = vi.hoisted(() => ({ fail: false, calls: 0, instructions: "" }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return {
    ...real,
    requireSession: async () => session.user ?? NextResponse.json({ error: "Not authenticated" }, { status: 401 }),
  };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // The post-turn extraction is not this test's subject, and calls a model.
  after: () => {},
}));
vi.mock("@/lib/anthropic", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/anthropic")>();
  const text = (v: unknown): string =>
    typeof v === "string" ? v : Array.isArray(v) ? v.map((b: { text?: string }) => b.text ?? "").join("\n") : "";
  const client = {
    messages: {
      create: async (args: { system?: unknown; messages: { content: unknown }[] }) => {
        model.calls++;
        if (model.fail) throw new Error("the model is unavailable");
        model.system = text(args.system);
        model.user = text(args.messages.at(-1)?.content);
        return { content: [{ type: "text", text: "Noted." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
  return {
    ...real,
    chatSettings: async () => ({ model: "claude-sonnet-5", effort: "low" }),
    brainSettings: async () => ({ model: "claude-opus-5", effort: "high" }),
    claudeBrainEnabled: () => true,
    anthropicClientFor: async () => ({ client, source: "house" }),
    anthropicFor: async () => client,
  };
});
vi.mock("@/lib/openai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openai")>()),
  // No fallback model: when the fake Claude fails, the turn fails.
  openaiClientFor: async () => null,
}));

import { db } from "@/lib/db";
import { expectations, usage, user } from "@/lib/db/schema";
import { executeTool } from "@/lib/secretary/tools";
import { GET as bootstrap } from "@/app/api/chat/bootstrap/route";
import { GET as briefingCard } from "@/app/api/briefing/route";
import { POST as chat } from "@/app/api/chat/route";
import { POST as voiceToken } from "@/app/api/realtime/token/route";

const U = { id: `test-followup-${crypto.randomUUID()}`, email: `followup-${Date.now()}@v103.test`, name: "Follow Up", timezone: "America/Los_Angeles" };
const ctx = { userId: U.id, timezone: U.timezone };
const OPENER = "EXPECTATIONS MISSED";

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const pageLoad = () => bootstrap(new Request("http://localhost/api/chat/bootstrap"));
const say = (message: string) => chat(post("http://localhost/api/chat", { message }));
const call = (body: Record<string, unknown> = {}) => voiceToken(post("http://localhost/api/realtime/token", body));

/** A follow-up Secretary promised, due an hour ago. */
async function promised(commitment: string): Promise<string> {
  const [row] = await db
    .insert(expectations)
    .values({ userId: U.id, commitment, expectedUpdateBy: new Date(Date.now() - 3_600_000), onMiss: "nag" })
    .returning();
  return row.id;
}
const statusOf = async (id: string) => (await db.select().from(expectations).where(eq(expectations.id, id)))[0]?.status;
/** Every earlier follow-up is out of the way, so each test reads only its own. */
const settleAll = () => db.update(expectations).set({ status: "cleared" }).where(and(eq(expectations.userId, U.id), eq(expectations.status, "open")));
/** A call that was started is over: the next one is not "already running". */
const hangUp = () => db.update(usage).set({ seconds: 5 }).where(and(eq(usage.userId, U.id), eq(usage.kind, "voice")));

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: U.name, email: U.email, timezone: U.timezone });
  session.user = U;
  vi.stubGlobal("fetch", async (url: string | URL, init?: { body?: string }) => {
    if (!String(url).includes("/v1/realtime/client_secrets")) throw new Error(`unexpected request to ${url}`);
    mint.calls++;
    if (mint.fail) return new Response("no", { status: 500 });
    mint.instructions = (JSON.parse(init?.body ?? "{}") as { session: { instructions: string } }).session.instructions;
    return Response.json({ value: "ephemeral-test-secret" });
  });
});
afterEach(async () => {
  model.fail = false;
  mint.fail = false;
  await settleAll();
  await hangUp();
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await db.delete(user).where(eq(user.id, U.id));
});

describe("a briefing nobody hears does not settle a follow-up", () => {
  it("the chat dock's bootstrap: three page loads, and it is still open", async () => {
    const id = await promised("the signed form went back to the office");
    for (let i = 0; i < 3; i++) expect((await pageLoad()).status).toBe(200);
    expect(await statusOf(id)).toBe("open");
  });

  it("the briefing card (/api/briefing)", async () => {
    const id = await promised("the quote arrived");
    expect((await briefingCard()).status).toBe(200);
    expect(await statusOf(id)).toBe("open");
  });

  it("consult_brain: the brain reads the situation, and is not told to open a session", async () => {
    const id = await promised("the deposit was paid");
    const before = model.calls;
    const { result } = await executeTool(ctx, "consult_brain", { question: "Which of these should come first?" });
    expect((result as { answer?: string }).answer).toBe("Noted.");
    expect(model.calls).toBe(before + 1);
    expect(model.user).toContain("USER'S CURRENT SITUATION");
    expect(model.user).not.toContain(OPENER);
    expect(await statusOf(id)).toBe("open");
  });

  it("a voice reconnect and an interview call: neither raises it, neither settles it", async () => {
    const id = await promised("the room was booked");
    expect((await call({ reconnect: true })).status).toBe(200);
    expect(mint.instructions).not.toContain(OPENER);
    await hangUp();
    expect((await call({ flavor: "interview" })).status).toBe(200);
    expect(mint.instructions).not.toContain(OPENER);
    expect(await statusOf(id)).toBe("open");
  });
});

describe("the session start that reaches the model asks, once", () => {
  it("after page loads, the first chat turn carries the opener and the promise; then it is settled and not raised again", async () => {
    const id = await promised("the contract was countersigned");
    await pageLoad();
    await pageLoad();
    expect(await briefingCard()).toBeTruthy();

    expect((await say("hello")).status).toBe(200);
    expect(model.system).toContain(OPENER);
    expect(model.system).toContain("ONE combined question");
    expect(model.system).toContain("the contract was countersigned");
    expect(await statusOf(id)).toBe("missed");

    // The following session start: nothing to raise, nothing changed.
    expect((await say("hello again")).status).toBe(200);
    expect(model.system).not.toContain(OPENER);
    expect(model.system).not.toContain("the contract was countersigned");
    expect(await statusOf(id)).toBe("missed");
  });

  it("a turn the model never answers leaves it open; the next turn that is answered raises it", async () => {
    const id = await promised("the invoice was approved");
    model.fail = true;
    expect((await say("hello")).status).toBe(502);
    expect(await statusOf(id)).toBe("open");

    model.fail = false;
    expect((await say("hello")).status).toBe(200);
    expect(model.system).toContain("the invoice was approved");
    expect(await statusOf(id)).toBe("missed");
  });

  it("a voice call: a refused start leaves it open; a start the provider accepts carries it and settles it", async () => {
    const id = await promised("the van was returned");
    await pageLoad();
    mint.fail = true;
    expect((await call()).status).toBe(502);
    expect(await statusOf(id)).toBe("open");
    await hangUp();

    mint.fail = false;
    expect((await call()).status).toBe(200);
    expect(mint.instructions).toContain(OPENER);
    expect(mint.instructions).toContain("the van was returned");
    expect(await statusOf(id)).toBe("missed");
    await hangUp();

    // The next call does not ask again.
    expect((await call()).status).toBe(200);
    expect(mint.instructions).not.toContain("the van was returned");
  });

  it("a report in between still clears it silently: page loads, then the task is done, and nothing is raised", async () => {
    await executeTool(ctx, "create_task", { title: "Return the borrowed lens" });
    const made = await executeTool(ctx, "create_expectation", {
      commitment: "the borrowed lens went back",
      expected_update_by: new Date(Date.now() - 3_600_000).toISOString(),
      task: "Return the borrowed lens",
    });
    const id = (made.result as { expectation_id: string }).expectation_id;
    await pageLoad();
    await pageLoad();
    await executeTool(ctx, "update_task", { task: "Return the borrowed lens", status: "done" });
    expect(await statusOf(id)).toBe("cleared");

    expect((await say("hello")).status).toBe(200);
    expect(model.system).not.toContain("the borrowed lens went back");
    expect(await statusOf(id)).toBe("cleared");
  });
});
