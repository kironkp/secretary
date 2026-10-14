// v1.09 (docs/chat/SPEC.md §1, §3): the page's side of a chat turn. It reads
// the streamed answer line by line, and after a drop asks again with the same
// turn id, marked resume, at once, after 2 s and after 5 s; only then does it
// give up with "Not delivered". The network is a fake fetch, and the waits are
// recorded instead of slept.
import { describe, expect, it } from "vitest";
import { newTurnId, RESUME_DELAYS_MS, sendTurn, type TurnLine } from "@/lib/chat/turn-client";

const enc = new TextEncoder();
/** A streamed answer delivered in these chunks (a line may be split across two). */
const streamed = (chunks: string[], status = 200) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(enc.encode(chunk));
        c.close();
      },
    }),
    { status, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } }
  );
const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
const DONE = { type: "done", conversationId: "c1", userMessageId: "u1", assistantMessage: { id: "a1", role: "assistant", content: "All set.", createdAt: "2026-10-14T17:00:00.000Z" }, toasts: [], uiActions: [] };
const ACCEPTED = { type: "accepted", turnId: "t1", conversationId: "c1", userMessageId: "u1" };
const BODY = { message: "plan my week", conversationId: null, attachmentIds: [] as string[] };

/** A fetch that answers each ask in turn, and keeps what each ask sent. */
function network(answers: (() => Response | Promise<Response>)[]) {
  const asks: { url: string; accept: string | null; body: Record<string, unknown> }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    asks.push({ url: String(url), accept: new Headers(init?.headers).get("accept"), body: JSON.parse(String(init?.body)) });
    const next = answers.shift();
    if (!next) throw new Error("no answer left");
    return next();
  };
  const waits: number[] = [];
  const wait = async (ms: number) => void waits.push(ms);
  return { asks, fetch: fetch as typeof globalThis.fetch, waits, wait };
}
const dropped = () => Promise.reject(new TypeError("Load failed"));

describe("reading the streamed answer", () => {
  it("asks for the stream, reads lines split across chunks, hands each to the page, and ends with the answer", async () => {
    const net = network([
      () => streamed([line(ACCEPTED) + '{"type":"pi', 'ng"}\n{"type":"text","round":0,"text":"All "}\n', line({ type: "text", round: 0, text: "set." }) + line(DONE)]),
    ]);
    const seen: TurnLine[] = [];
    const out = await sendTurn({ turnId: "t1", body: BODY, fetch: net.fetch, wait: net.wait, onLine: (l) => seen.push(l) });
    expect(out).toEqual({ ok: true, answer: DONE });
    expect(seen.map((l) => l.type)).toEqual(["accepted", "ping", "text", "text", "done"]);
    expect(net.asks).toEqual([{ url: "/api/chat", accept: "application/x-ndjson", body: { ...BODY, turnId: "t1" } }]);
  });

  it("a sentence the turn failed with is shown as it is, and nothing is asked again", async () => {
    const net = network([() => streamed([line(ACCEPTED), line({ type: "error", error: "The secretary has no OpenAI key. Connect one in Settings." })])]);
    expect(await sendTurn({ turnId: "t1", body: BODY, fetch: net.fetch, wait: net.wait })).toEqual({ ok: false, error: "The secretary has no OpenAI key. Connect one in Settings." });
    expect(net.asks.length).toBe(1);
  });

  it("a refusal before any work (a JSON error with its status) is shown as it is, and nothing is asked again", async () => {
    const net = network([() => Response.json({ error: "Say something or attach a file." }, { status: 400 })]);
    expect(await sendTurn({ turnId: "t1", body: BODY, fetch: net.fetch, wait: net.wait })).toEqual({ ok: false, error: "Say something or attach a file." });
    expect(net.asks.length).toBe(1);
  });
});

describe("after a drop, the page only resumes", () => {
  it("a stream that ends before its last line: asked again at once, same turn id, marked resume; the saved answer comes back", async () => {
    const net = network([() => streamed([line(ACCEPTED), line({ type: "ping" })]), () => streamed([line(ACCEPTED), line(DONE)])]);
    expect(await sendTurn({ turnId: "t1", body: BODY, fetch: net.fetch, wait: net.wait })).toEqual({ ok: true, answer: DONE });
    expect(net.asks.map((a) => a.body)).toEqual([{ ...BODY, turnId: "t1" }, { ...BODY, turnId: "t1", resume: true }]);
    expect(net.waits).toEqual([0]);
  });

  it("the router's own 503 page is a drop, not an answer", async () => {
    const net = network([
      () => new Response("<html><body>Application error</body></html>", { status: 503, headers: { "Content-Type": "text/html" } }),
      () => streamed([line(DONE)]),
    ]);
    expect(await sendTurn({ turnId: "t1", body: BODY, fetch: net.fetch, wait: net.wait })).toEqual({ ok: true, answer: DONE });
    expect(net.asks.map((a) => a.body.resume ?? false)).toEqual([false, true]);
  });

  it("three resumes that all fail on the network: Not delivered, after waiting 0, 2 and 5 seconds, every ask the same turn", async () => {
    const net = network([dropped, dropped, dropped, dropped]);
    expect(await sendTurn({ turnId: "t1", body: BODY, fetch: net.fetch, wait: net.wait })).toEqual({ ok: false, error: "Not delivered" });
    expect(RESUME_DELAYS_MS).toEqual([0, 2000, 5000]);
    expect(net.waits).toEqual([0, 2000, 5000]);
    expect(net.asks.map((a) => [a.body.turnId, a.body.resume ?? false])).toEqual([["t1", false], ["t1", true], ["t1", true], ["t1", true]]);
  });

  it("a resume that brings back a failure stops there and shows it: the page never asks the server to run the turn", async () => {
    const net = network([dropped, () => streamed([line({ type: "error", error: "Not delivered" })])]);
    expect(await sendTurn({ turnId: "t1", body: BODY, fetch: net.fetch, wait: net.wait })).toEqual({ ok: false, error: "Not delivered" });
    expect(net.asks.length).toBe(2);
    expect(net.asks.slice(1).every((a) => a.body.resume === true)).toBe(true);
  });

  it("his tap is a new ask with the same turn id and no resume mark", async () => {
    const net = network([() => streamed([line(DONE)])]);
    await sendTurn({ turnId: "t1", body: BODY, fetch: net.fetch, wait: net.wait });
    expect(net.asks.map((a) => a.body)).toEqual([{ ...BODY, turnId: "t1" }]);
  });
});

describe("the turn id", () => {
  it("is 32 hex characters, new each time, and made without crypto.randomUUID (missing on a page served over plain http)", () => {
    const real = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const ids = new Set(Array.from({ length: 200 }, () => newTurnId()));
      expect(ids.size).toBe(200);
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      Object.defineProperty(globalThis.crypto, "randomUUID", { value: real, configurable: true });
    }
  });
});
