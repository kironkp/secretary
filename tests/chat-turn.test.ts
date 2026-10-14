// v1.09 (docs/chat/SPEC.md): a chat turn reaches him, once. Through the real
// route against the local database. Claude and OpenAI are fakes that can be
// held, made to fail, or made to write in pieces; nothing leaves the machine.
// The times the spec names (a ping every 5 s, alive every 12 s, gone after
// 60 s) are shrunk with the route's own knobs, in the same ratios.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { parse as parseConnectionString } from "pg-connection-string";

/** One answer of the fake Claude. */
type ClaudeStep = {
  /** The answer's text, in the pieces it is written in. */
  text?: string[];
  /** Each piece waits for its gate first (a piece still being written). */
  pieceHolds?: (Promise<void> | undefined)[];
  /** A tool call after the text, instead of an end. */
  tool?: { name: string; input: Record<string, unknown> };
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  /** The request waits for this before anything comes back. */
  hold?: Promise<void>;
  /** Throws instead of answering, with this HTTP status (none: the connection dropped). */
  fail?: { status?: number };
  refusal?: boolean;
};
/** One answer of the fake OpenAI. */
type GptStep = { text?: string; tool?: { name: string; input: Record<string, unknown> }; usage?: { input: number; output: number }; fail?: { status?: number } };

const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string; timezone: string } }));
const chip = vi.hoisted(() => ({ model: "claude-sonnet-5" }));
const claude = vi.hoisted(() => ({ calls: 0, script: [] as ClaudeStep[], requests: [] as Record<string, unknown>[] }));
const gpt = vi.hoisted(() => ({ on: false, calls: 0, script: [] as GptStep[], requests: [] as Record<string, unknown>[] }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  const { NextResponse } = await import("next/server");
  return { ...real, requireSession: async () => session.user ?? NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
});
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // The post-turn extraction is not this test's subject, and calls a model.
  after: () => {},
}));
vi.mock("@/lib/anthropic", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/anthropic")>();
  const answer = async (params: Record<string, unknown>) => {
    claude.calls++;
    claude.requests.push(params);
    const step = claude.script.shift() ?? { text: ["Noted."] };
    if (step.hold) await step.hold;
    if (step.fail) throw Object.assign(new Error("claude is unavailable"), step.fail.status ? { status: step.fail.status } : {});
    const usage = step.usage ?? { input_tokens: 10, output_tokens: 5 };
    const said = (step.text ?? []).join("");
    const content: Record<string, unknown>[] = said ? [{ type: "text", text: said }] : [];
    if (step.tool) content.push({ type: "tool_use", id: `tu-${claude.calls}`, name: step.tool.name, input: step.tool.input });
    return { step, message: { content, stop_reason: step.tool ? "tool_use" : step.refusal ? "refusal" : "end_turn", usage } };
  };
  const client = {
    messages: {
      // The route asked whole until v1.09; kept so these tests also run against the route before it.
      create: async (params: Record<string, unknown>) => (await answer(params)).message,
      stream: (params: Record<string, unknown>) => {
        const listeners: ((delta: string, snapshot: string) => void)[] = [];
        const sent = answer(params);
        sent.catch(() => {});
        return {
          on(event: string, listener: (delta: string, snapshot: string) => void) {
            if (event === "text") listeners.push(listener);
            return this;
          },
          async finalMessage() {
            const { step, message } = await sent;
            let snapshot = "";
            for (const [i, piece] of (step.text ?? []).entries()) {
              await step.pieceHolds?.[i];
              snapshot += piece;
              for (const l of listeners) l(piece, snapshot);
            }
            return message;
          },
        };
      },
    },
  };
  return {
    ...real,
    chatSettings: async () => ({ model: chip.model, effort: "low" }),
    claudeBrainEnabled: () => true,
    anthropicClientFor: async () => ({ client, source: "house" }),
  };
});
vi.mock("@/lib/openai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/openai")>();
  const client = {
    responses: {
      create: async (params: Record<string, unknown>) => {
        gpt.calls++;
        gpt.requests.push(params);
        const step = gpt.script.shift() ?? { text: "From OpenAI." };
        if (step.fail) throw Object.assign(new Error("openai is unavailable"), step.fail.status ? { status: step.fail.status } : {});
        const usage = { input_tokens: step.usage?.input ?? 40, output_tokens: step.usage?.output ?? 8, input_tokens_details: { cached_tokens: 0 } };
        return step.tool
          ? { id: `resp-${gpt.calls}`, output: [{ type: "function_call", name: step.tool.name, arguments: JSON.stringify(step.tool.input), call_id: `call-${gpt.calls}` }], output_text: "", usage }
          : { id: `resp-${gpt.calls}`, output: [{ type: "message" }], output_text: step.text ?? "From OpenAI.", usage };
      },
    },
  };
  return { ...real, openaiClientFor: async () => (gpt.on ? { client, source: "house" } : null) };
});

import { db } from "@/lib/db";
import { chatTurns, conversations, expectations, messages, tasks, usage, user } from "@/lib/db/schema";
import { POST as chat } from "@/app/api/chat/route";

type Line = { type?: string; [k: string]: unknown };
const users: string[] = [];
let U: { id: string; email: string; name: string; timezone: string };

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newTurnId = () => crypto.randomUUID().replaceAll("-", "");
/** Within a time, or a failure saying what did not come. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} (nothing within ${ms} ms)`)), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

const ask = (body: Record<string, unknown>, stream = true) =>
  chat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(stream ? { Accept: "application/x-ndjson" } : {}) },
      body: JSON.stringify(body),
    })
  );

/**
 * Every answer a test opened. After each test they are read to their end, so a test that failed part way
 * never leaves its turn running into the next one (where it would take the next test's scripted answer).
 */
const opened: { drain: () => Promise<unknown> }[] = [];

/** The lines of a streamed answer, as they arrive. A plain JSON answer reads as one line. */
function linesOf(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const seen: Line[] = [];
  const queue: Line[] = [];
  const pull = async (): Promise<boolean> => {
    pending ??= reader.read();
    const { done, value } = await pending;
    pending = null;
    if (done) {
      ended = true;
      if (buffer.trim()) queue.push(JSON.parse(buffer));
      buffer = "";
      return false;
    }
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (raw.trim()) queue.push(JSON.parse(raw));
    }
    return true;
  };
  const next = async (ms = 4000, what = "the next line"): Promise<Line | null> => {
    while (!queue.length && !ended) await within(pull(), ms, what);
    const line = queue.shift() ?? null;
    if (line) seen.push(line);
    return line;
  };
  const lines = {
    seen,
    next,
    /** Reads on until a line of this type, and returns it. */
    async until(type: string, ms = 4000): Promise<Line> {
      for (;;) {
        const line = await next(ms, `a "${type}" line`);
        if (!line) throw new Error(`the answer ended without a "${type}" line; it said ${JSON.stringify(seen)}`);
        if (line.type === type) return line;
      }
    },
    /** Every line still to come (the answer's last line included). */
    async rest(ms = 4000): Promise<Line[]> {
      const out: Line[] = [];
      for (let line = await next(ms); line; line = await next(ms)) out.push(line);
      return out;
    },
    cancel: () => reader.cancel(),
  };
  opened.push({ drain: () => lines.rest(10_000) });
  return lines;
}
/** The last line of a whole streamed answer. */
const lastOf = async (res: Response) => (await linesOf(res).rest()).at(-1)!;

const counts = async () => {
  const mine = await db.select({ role: messages.role }).from(messages).where(eq(messages.userId, U.id));
  return {
    his: mine.filter((m) => m.role === "user").length,
    replies: mine.filter((m) => m.role === "assistant").length,
    usage: (await db.select().from(usage).where(and(eq(usage.userId, U.id), eq(usage.kind, "chat")))).length,
  };
};
const turnRow = async (id: string) => (await db.select().from(chatTurns).where(and(eq(chatTurns.userId, U.id), eq(chatTurns.id, id))))[0];
const chatRows = () => db.select().from(usage).where(and(eq(usage.userId, U.id), eq(usage.kind, "chat")));
/** Bytes a request carried, halved: the floor docs/spend/SPEC.md §1.2 estimates with. */
const floorOf = (parts: unknown[]) => Math.floor(parts.reduce<number>((n, p) => n + Buffer.byteLength(JSON.stringify(p) ?? "", "utf8"), 0) / 2);

async function freshUser() {
  U = { id: `test-chat-turn-${crypto.randomUUID()}`, email: `chat-turn-${crypto.randomUUID().slice(0, 8)}@v109.test`, name: "Turn", timezone: "America/Los_Angeles" };
  users.push(U.id);
  await db.insert(user).values({ id: U.id, name: U.name, email: U.email, timezone: U.timezone });
  session.user = U;
}

beforeEach(async () => {
  claude.calls = 0;
  claude.script = [];
  claude.requests = [];
  gpt.on = false;
  gpt.calls = 0;
  gpt.script = [];
  gpt.requests = [];
  chip.model = "claude-sonnet-5";
  await freshUser();
});
afterEach(async () => {
  for (const o of opened.splice(0)) await o.drain().catch(() => {});
  vi.unstubAllEnvs();
});
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("bytes within a second, and kept flowing (§1)", () => {
  it("the first line comes as soon as his message is stored, before the model answers, and pings follow while it works", async () => {
    vi.stubEnv("CHAT_HEARTBEAT_MS", "50");
    const held = gate();
    claude.script = [{ text: ["All ", "set."], hold: held.p }];
    const turnId = newTurnId();
    try {
      const res = await within(ask({ message: "plan my week", turnId }), 2000, "a response while the model is still working");
      expect(res.headers.get("content-type")).toMatch(/application\/x-ndjson/);
      const lines = linesOf(res);
      // Storing his message can take longer than this test's 50 ms heartbeat: pings may come first, nothing else.
      const first = await lines.until("accepted", 2000);
      expect(lines.seen.slice(0, -1).every((l) => l.type === "ping"), JSON.stringify(lines.seen)).toBe(true);
      expect(first).toMatchObject({ type: "accepted", turnId });
      const [his] = await db.select().from(messages).where(and(eq(messages.userId, U.id), eq(messages.role, "user")));
      expect(first).toMatchObject({ userMessageId: his.id, conversationId: his.conversationId });
      // Held for eight heartbeats: pings, and nothing else, while the model works.
      await sleep(400);
      held.open();
      const rest = await lines.rest();
      const pings = rest.findIndex((l) => l.type !== "ping");
      expect(pings, JSON.stringify(rest)).toBeGreaterThanOrEqual(3);
      const done = rest.at(-1)!;
      expect(done.type).toBe("done");
      expect(done).toMatchObject({ conversationId: his.conversationId, userMessageId: his.id, assistantMessage: { role: "assistant", content: "All set." }, toasts: [], uiActions: [] });
      const [reply] = await db.select().from(messages).where(and(eq(messages.userId, U.id), eq(messages.role, "assistant")));
      expect((done.assistantMessage as { id: string }).id).toBe(reply.id);
    } finally {
      held.open();
    }
  });

  it("Claude's text comes in pieces as it is written; a later round starts the answer over; the last line holds the whole answer", async () => {
    const second = gate();
    claude.script = [
      { text: ["One sec."], tool: { name: "list_projects", input: {} } },
      { text: ["Two ", "projects ", "are open."], pieceHolds: [undefined, second.p] },
    ];
    try {
      const lines = linesOf(await within(ask({ message: "what is open?", turnId: newTurnId() }), 2000, "a response"));
      expect(await lines.until("text")).toMatchObject({ round: 0, text: "One sec." });
      expect(await lines.until("text")).toMatchObject({ round: 1, text: "Two " });
      // The next piece is still being written, and the first of this round has already arrived.
      second.open();
      const rest = await lines.rest();
      expect(rest.filter((l) => l.type === "text").map((l) => [l.round, l.text])).toEqual([[1, "projects "], [1, "are open."]]);
      expect(rest.at(-1)).toMatchObject({ type: "done", assistantMessage: { content: "Two projects are open." } });
    } finally {
      second.open();
    }
  });

  it("a request that does not ask for the stream gets the plain answer, as before", async () => {
    const res = await ask({ message: "hello", turnId: newTurnId() }, false);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toMatchObject({ assistantMessage: { role: "assistant", content: "Noted." }, toasts: [], uiActions: [] });
    expect(typeof body.conversationId).toBe("string");
    expect(typeof body.userMessageId).toBe("string");
  });

  it("a request refused before any work keeps its status and its JSON", async () => {
    const res = await ask({ message: "  ", turnId: newTurnId() });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Say something or attach a file." });
    expect(claude.calls).toBe(0);
  });
});

describe("a turn runs once (§2)", () => {
  it("a resend of a turn that is done gets the saved answer, its toasts included: no model call, nothing written", async () => {
    claude.script = [{ tool: { name: "create_task", input: { title: "Call the plumber" } } }, { text: ["Added."] }];
    const turnId = newTurnId();
    const first = await lastOf(await ask({ message: "remind me to call the plumber", turnId }));
    expect(first).toMatchObject({ type: "done", assistantMessage: { content: "Added." } });
    expect((first.toasts as unknown[]).length).toBe(1);
    const before = { calls: claude.calls, ...(await counts()), tasks: (await db.select().from(tasks).where(eq(tasks.userId, U.id))).length };
    expect(before).toMatchObject({ calls: 2, his: 1, replies: 1, usage: 1, tasks: 1 });
    for (const resume of [false, true]) {
      const again = await lastOf(await ask({ message: "remind me to call the plumber", turnId, ...(resume ? { resume } : {}) }));
      expect(again, resume ? "a resume" : "a tap").toEqual(first);
    }
    expect({ calls: claude.calls, ...(await counts()), tasks: (await db.select().from(tasks).where(eq(tasks.userId, U.id))).length }).toEqual(before);
    // The row names the reply; the reply's text is the message row's own.
    const row = await turnRow(turnId);
    expect(row).toMatchObject({ status: "done", replyMessageId: (first.assistantMessage as { id: string }).id });
    expect(JSON.stringify(row)).not.toContain("Added.");
  });

  it("a long model call does not make the turn look gone: a second ask after the gone limit waits, and both get the one answer (A)", async () => {
    // 12 s alive, 60 s gone, a model held 90 s, the second ask at 70 s: the same ratios, a hundred times faster.
    vi.stubEnv("CHAT_TURN_ALIVE_MS", "120");
    vi.stubEnv("CHAT_TURN_GONE_MS", "600");
    vi.stubEnv("CHAT_HEARTBEAT_MS", "50");
    const held = gate();
    claude.script = [{ text: ["Here is your week."], hold: held.p }];
    const turnId = newTurnId();
    try {
      const started = Date.now();
      const first = linesOf(await within(ask({ message: "plan my week", turnId }), 2000, "a response"));
      await first.until("accepted");
      await sleep(700 - (Date.now() - started));
      // Heard from within the last two alive beats, though the model has said nothing.
      expect(Date.now() - (await turnRow(turnId)).aliveAt.getTime()).toBeLessThan(400);
      const second = linesOf(await within(ask({ message: "plan my week", turnId }), 2000, "a response to the second ask"));
      await sleep(900 - (Date.now() - started));
      held.open();
      const [a, b] = await Promise.all([first.rest(), second.rest()]);
      expect(a.at(-1)).toMatchObject({ type: "done", assistantMessage: { content: "Here is your week." } });
      expect(b.at(-1)).toEqual(a.at(-1));
      expect(claude.calls).toBe(1);
      expect(await counts()).toEqual({ his: 1, replies: 1, usage: 1 });
    } finally {
      held.open();
    }
  });

  it("a failed turn: three automatic asks run no model and bring the failure back; one tap runs it exactly once, on the same stored message (B)", async () => {
    // Refused outright (a 4xx): it cost nothing and leaves no row, so the rows below are the tap's alone.
    claude.script = [{ fail: { status: 429 } }];
    const turnId = newTurnId();
    const failed = await lastOf(await ask({ message: "plan my week", turnId }));
    expect(failed).toMatchObject({ type: "error", error: "The secretary has no OpenAI key. Connect one in Settings." });
    expect(claude.calls).toBe(1);
    expect(await turnRow(turnId)).toMatchObject({ status: "failed" });
    for (let i = 0; i < 3; i++) {
      expect(await lastOf(await ask({ message: "plan my week", turnId, resume: true }))).toEqual(failed);
    }
    expect(claude.calls).toBe(1);
    const tapped = await lastOf(await ask({ message: "plan my week", turnId }));
    expect(tapped).toMatchObject({ type: "done", assistantMessage: { content: "Noted." } });
    expect(claude.calls).toBe(2);
    expect(await counts()).toEqual({ his: 1, replies: 1, usage: 1 });
    expect(await turnRow(turnId)).toMatchObject({ status: "done" });
  });

  it("a turn gone silent: a resume answers Not delivered and runs nothing; two taps together run it once, taking it over (C)", async () => {
    const turnId = newTurnId();
    const [conv] = await db.insert(conversations).values({ userId: U.id, mode: "text" }).returning();
    const [his] = await db.insert(messages).values({ userId: U.id, conversationId: conv.id, role: "user", content: "plan my week", mode: "text", origin: "app" }).returning();
    const longAgo = new Date(Date.now() - 2 * 60_000);
    await db.insert(chatTurns).values({ userId: U.id, id: turnId, conversationId: conv.id, userMessageId: his.id, status: "running", startedAt: longAgo, aliveAt: longAgo });
    expect(await lastOf(await ask({ message: "plan my week", turnId, resume: true }))).toEqual({ type: "error", error: "Not delivered" });
    expect(claude.calls).toBe(0);
    const held = gate();
    claude.script = [{ text: ["Here is your week."], hold: held.p }];
    try {
      const both = Promise.all([ask({ message: "plan my week", turnId }), ask({ message: "plan my week", turnId })]).then((rs) => Promise.all(rs.map(lastOf)));
      await sleep(200);
      held.open();
      const [a, b] = await within(both, 4000, "both answers");
      expect(a).toMatchObject({ type: "done", conversationId: conv.id, userMessageId: his.id, assistantMessage: { content: "Here is your week." } });
      expect(b).toEqual(a);
      expect(claude.calls).toBe(1);
      expect(await counts()).toEqual({ his: 1, replies: 1, usage: 1 });
    } finally {
      held.open();
    }
  });

  it("a resume of a turn that never arrived answers Not delivered and stores nothing", async () => {
    expect(await lastOf(await ask({ message: "plan my week", turnId: newTurnId(), resume: true }))).toEqual({ type: "error", error: "Not delivered" });
    expect(claude.calls).toBe(0);
    expect(await db.select().from(conversations).where(eq(conversations.userId, U.id))).toEqual([]);
    expect(await counts()).toEqual({ his: 0, replies: 0, usage: 0 });
  });

  it("another user's turn with the same id is a turn of its own", async () => {
    const turnId = newTurnId();
    claude.script = [{ text: ["For the first."] }, { text: ["For the second."] }];
    const a = await lastOf(await ask({ message: "hello", turnId }));
    const first = U;
    await freshUser();
    const b = await lastOf(await ask({ message: "hello", turnId }));
    expect(a).toMatchObject({ type: "done", assistantMessage: { content: "For the first." } });
    expect(b).toMatchObject({ type: "done", assistantMessage: { content: "For the second." } });
    expect(claude.calls).toBe(2);
    expect((await db.select().from(chatTurns).where(eq(chatTurns.id, turnId))).map((r) => r.userId).toSorted()).toEqual([first.id, U.id].toSorted());
  });
});

describe("a cut connection (§3)", () => {
  it("the turn runs to the end with nobody listening, is saved and paid for, and a resume brings the answer back", async () => {
    const held = gate();
    claude.script = [{ text: ["Here is your week."], hold: held.p }];
    const turnId = newTurnId();
    try {
      const lines = linesOf(await within(ask({ message: "plan my week", turnId }), 2000, "a response"));
      await lines.until("accepted");
      await lines.cancel();
      held.open();
      let row = await turnRow(turnId);
      for (let i = 0; i < 40 && row?.status !== "done"; i++) {
        await sleep(50);
        row = await turnRow(turnId);
      }
      expect(row?.status).toBe("done");
      expect(await counts()).toEqual({ his: 1, replies: 1, usage: 1 });
      const back = await lastOf(await ask({ message: "plan my week", turnId, resume: true }));
      expect(back).toMatchObject({ type: "done", assistantMessage: { id: row!.replyMessageId, content: "Here is your week." } });
      expect(claude.calls).toBe(1);
    } finally {
      held.open();
    }
  });
});

describe("money: once the model has answered, a database error never loses what it cost nor leaves a second reply (§4, v1.09 r2)", () => {
  // Failures are injected by triggers that fire only for a user this test switches on, so the other files that
  // share the database never meet them. Local or CI test database only.
  beforeAll(async () => {
    const host = parseConnectionString(process.env.DATABASE_URL ?? "").host ?? "";
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) throw new Error("these triggers go into a local or CI test database only");
    await db.execute(sql`create table if not exists test_fail_switch (user_id text not null, what text not null, primary key (user_id, what))`);
    const trigger = async (name: string, table: string, when: string, what: string) => {
      await db.execute(sql.raw(`create or replace function ${name}() returns trigger language plpgsql as $$ begin if ${when} and exists (select 1 from test_fail_switch s where s.user_id = new.user_id and s.what = '${what}') then raise exception 'injected: the ${what} write fails'; end if; return new; end $$`));
      await db.execute(sql.raw(`drop trigger if exists ${name} on ${table}`));
      await db.execute(sql.raw(`create trigger ${name} before ${table === "messages" ? "insert" : "update"} on ${table} for each row execute function ${name}()`));
    };
    await trigger("test_fail_reply", "messages", "new.role = 'assistant'", "reply");
    await trigger("test_fail_done", "chat_turns", "new.status = 'done'", "done");
    await trigger("test_fail_settle", "expectations", "new.status = 'missed'", "settle");
  });
  afterAll(async () => {
    for (const [name, table] of [["test_fail_reply", "messages"], ["test_fail_done", "chat_turns"], ["test_fail_settle", "expectations"]]) {
      await db.execute(sql.raw(`drop trigger if exists ${name} on ${table}`));
      await db.execute(sql.raw(`drop function if exists ${name}()`));
    }
    await db.execute(sql`drop table if exists test_fail_switch`);
  });
  const fail = (what: string) => db.execute(sql`insert into test_fail_switch (user_id, what) values (${U.id}, ${what}) on conflict do nothing`);
  const heal = () => db.execute(sql`delete from test_fail_switch where user_id = ${U.id}`);

  it.each([
    ["the reply's insert", "reply"],
    ["the turn's done mark", "done"],
  ])("%s fails: the usage is counted, no reply is stored, the turn says it failed; his tap stores the one reply", async (_what, what) => {
    await fail(what);
    claude.script = [{ text: ["First answer."] }, { text: ["Second answer."] }];
    const turnId = newTurnId();
    expect(await lastOf(await ask({ message: "plan my week", turnId }))).toMatchObject({ type: "error" });
    expect(await counts()).toEqual({ his: 1, replies: 0, usage: 1 });
    expect(await turnRow(turnId)).toMatchObject({ status: "failed", replyMessageId: null });
    await heal();
    expect(await lastOf(await ask({ message: "plan my week", turnId }))).toMatchObject({ type: "done", assistantMessage: { content: "Second answer." } });
    // Two model runs, both paid and both counted; one reply.
    expect(await counts()).toEqual({ his: 1, replies: 1, usage: 2 });
  });

  it("settling the follow-ups fails: the answer is saved and the turn done all the same; the follow-up stays open", async () => {
    const [due] = await db.insert(expectations).values({ userId: U.id, commitment: "the shed roof", expectedUpdateBy: new Date(Date.now() - 3_600_000), onMiss: "nag" }).returning();
    await fail("settle");
    const turnId = newTurnId();
    expect(await lastOf(await ask({ message: "hello", turnId }))).toMatchObject({ type: "done" });
    expect(await counts()).toEqual({ his: 1, replies: 1, usage: 1 });
    expect(await turnRow(turnId)).toMatchObject({ status: "done" });
    expect((await db.select().from(expectations).where(eq(expectations.id, due.id)))[0].status).toBe("open");
    await heal();
  });
});

describe("money: rounds that did not end in an answer from that provider are counted (§4)", () => {
  const claudeRows = async () => (await chatRows()).filter((r) => r.model === "claude-sonnet-5");
  const gptRows = async () => (await chatRows()).filter((r) => r.model === "gpt-5.5");
  const roundOne = { tool: { name: "list_projects", input: {} }, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 } };

  it("Claude answers one round and the next is never answered: that round as reported, the next at the estimate, then OpenAI's answer", async () => {
    gpt.on = true;
    claude.script = [roundOne, { fail: { status: 500 } }];
    expect(await lastOf(await ask({ message: "what is open?", turnId: newTurnId() }))).toMatchObject({ type: "done", assistantMessage: { content: "From OpenAI." } });
    const rows = await claudeRows();
    const exact = rows.filter((r) => !r.costEstimated);
    const guessed = rows.filter((r) => r.costEstimated);
    expect(exact.map((r) => [r.inputTokens, r.outputTokens, r.cachedInputTokens, r.cacheWriteInputTokens])).toEqual([[1600, 20, 1000, 500]]);
    expect(guessed.map((r) => r.outputTokens)).toEqual([0]);
    const sent = claude.requests[1];
    expect(guessed[0].inputTokens).toBeGreaterThanOrEqual(floorOf([sent.system, sent.tools, sent.messages]));
    expect((await gptRows()).map((r) => [r.inputTokens, r.outputTokens, r.costEstimated])).toEqual([[40, 8, false]]);
  });

  it("Claude refuses the second round with a 4xx: the first round as reported, nothing for the refused one", async () => {
    gpt.on = true;
    claude.script = [roundOne, { fail: { status: 429 } }];
    await lastOf(await ask({ message: "what is open?", turnId: newTurnId() }));
    expect((await claudeRows()).map((r) => [r.inputTokens, r.costEstimated])).toEqual([[1600, false]]);
    expect((await gptRows()).length).toBe(1);
  });

  it("a refusal reported its usage: it is counted as reported, not estimated", async () => {
    gpt.on = true;
    claude.script = [{ text: ["No."], refusal: true, usage: { input_tokens: 70, output_tokens: 3 } }];
    await lastOf(await ask({ message: "what is open?", turnId: newTurnId() }));
    expect((await claudeRows()).map((r) => [r.inputTokens, r.outputTokens, r.costEstimated])).toEqual([[70, 3, false]]);
  });

  it("the first Claude round never comes back (the connection dropped): one row at the estimate", async () => {
    gpt.on = true;
    claude.script = [{ fail: {} }];
    await lastOf(await ask({ message: "what is open?", turnId: newTurnId() }));
    const rows = await claudeRows();
    expect(rows.map((r) => [r.outputTokens, r.costEstimated])).toEqual([[0, true]]);
    const sent = claude.requests[0];
    expect(rows[0].inputTokens).toBeGreaterThanOrEqual(floorOf([sent.system, sent.tools, sent.messages]));
  });

  it("OpenAI answers one round and fails the next: that round as reported, the next at the estimate, and the turn says it failed", async () => {
    chip.model = "gpt-5.5";
    gpt.on = true;
    gpt.script = [{ tool: { name: "list_projects", input: {} }, usage: { input: 300, output: 12 } }, { fail: { status: 500 } }];
    expect(await lastOf(await ask({ message: "what is open?", turnId: newTurnId() }))).toMatchObject({ type: "error" });
    expect(claude.calls).toBe(0);
    const rows = await gptRows();
    expect(rows.filter((r) => !r.costEstimated).map((r) => [r.inputTokens, r.outputTokens])).toEqual([[300, 12]]);
    const guessed = rows.filter((r) => r.costEstimated);
    expect(guessed.map((r) => r.outputTokens)).toEqual([0]);
    const sent = gpt.requests[1];
    expect(guessed[0].inputTokens).toBeGreaterThanOrEqual(floorOf([sent.instructions, sent.input, sent.tools]));
  });

  it("OpenAI refuses the second round with a 4xx: the first round as reported, nothing for the refused one", async () => {
    chip.model = "gpt-5.5";
    gpt.on = true;
    gpt.script = [{ tool: { name: "list_projects", input: {} }, usage: { input: 300, output: 12 } }, { fail: { status: 400 } }];
    await lastOf(await ask({ message: "what is open?", turnId: newTurnId() }));
    expect((await gptRows()).map((r) => [r.inputTokens, r.costEstimated])).toEqual([[300, false]]);
  });
});
