// v1.11 r2 (docs/projects/SPEC.md §2): on a call, the function calls of one
// reply run one after the other, in the order the model gave them, and the
// reply goes on once, after the last has answered. On 2b212e5 each call was
// sent the moment it arrived, so "put these eight in this order" was eight
// requests at once, and each answer asked the model to go on (eight
// response.create, which the Realtime API refuses while a reply is under way).
// The client is driven through its event handler: the data channel and the
// tool route are fakes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIRealtimeVoice, TOOL_CALL_LIMIT_MS } from "@/lib/realtime/openai-webrtc";

type Sent = { type: string; item?: { type: string; call_id: string; output: string } };

function client() {
  const voice = new OpenAIRealtimeVoice();
  const sent: Sent[] = [];
  const internals = voice as unknown as { dc: unknown; handleEvent: (e: Record<string, unknown>) => void };
  internals.dc = { readyState: "open", send: (s: string) => sent.push(JSON.parse(s) as Sent) };
  /** The tool route: each request waits until the test answers it. */
  const asked: { name: string; project: string; answer: () => void }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
      if (url !== "/api/secretary/tools") return new Response("{}");
      const body = JSON.parse(String(init?.body)) as { name: string; args: { project: string } };
      // Given up on (the signal), it fails the way fetch does.
      await new Promise<void>((resolve, reject) => {
        asked.push({ name: body.name, project: body.args.project, answer: resolve });
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
      return new Response(JSON.stringify({ result: body.name === "move_project" ? { project: body.args.project, place: 1 } : { answer: "found" } }));
    })
  );
  const ask = (id: string, name: string, args: Record<string, string>) =>
    internals.handleEvent({ type: "response.function_call_arguments.done", call_id: id, name, arguments: JSON.stringify(args) });
  const call = (id: string, project: string) => ask(id, "move_project", { project, to: "top" });
  /** A lookup that pays a model or the web for its answer. */
  const lookup = (id: string, name: "consult_brain" | "search_web") => ask(id, name, name === "consult_brain" ? { question: "what is due" } : { query: "what is due" });
  return { sent, asked, call, lookup };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => vi.unstubAllGlobals());

describe("a reply's function calls, on a call", () => {
  it("run one after the other, in the order the model gave them", async () => {
    const c = client();
    c.call("c1", "Atlas");
    c.call("c2", "Birch");
    c.call("c3", "Cedar");
    await settle();
    expect(c.asked.map((a) => a.project), "only the first is asked before it answers").toEqual(["Atlas"]);
    c.asked[0].answer();
    await settle();
    expect(c.asked.map((a) => a.project)).toEqual(["Atlas", "Birch"]);
    c.asked[1].answer();
    await settle();
    c.asked[2].answer();
    await settle();
    expect(c.asked.map((a) => a.project)).toEqual(["Atlas", "Birch", "Cedar"]);
  });

  it("each gets its answer, and the reply goes on once, after the last", async () => {
    const c = client();
    c.call("c1", "Atlas");
    c.call("c2", "Birch");
    c.call("c3", "Cedar");
    for (let i = 0; i < 3; i++) {
      await settle();
      c.asked[i]?.answer();
    }
    await settle();
    expect(c.sent.map((e) => (e.type === "conversation.item.create" ? `output ${e.item!.call_id}` : e.type))).toEqual([
      "output c1",
      "output c2",
      "output c3",
      "response.create",
    ]);
  });

  it("a call held past the limit gets an error output, the calls after it run, and the reply goes on once (v1.11 r3; 28 s since r4)", async () => {
    expect(TOOL_CALL_LIMIT_MS, "under Heroku's 30 s router limit").toBeLessThan(30_000);
    vi.useFakeTimers();
    try {
      const flush = () => vi.advanceTimersByTimeAsync(0);
      const c = client();
      c.call("c1", "Atlas");
      c.call("c2", "Birch");
      await flush();
      expect(c.asked.map((a) => a.project), "the first is asked; it never answers").toEqual(["Atlas"]);
      await vi.advanceTimersByTimeAsync(TOOL_CALL_LIMIT_MS - 1);
      expect(c.sent, "not yet given up on").toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(c.asked.map((a) => a.project), "the next is asked once the first is given up on").toEqual(["Atlas", "Birch"]);
      c.asked[1].answer();
      await flush();
      expect(c.sent.map((e) => (e.type === "conversation.item.create" ? `output ${e.item!.call_id}` : e.type))).toEqual(["output c1", "output c2", "response.create"]);
      // A move changes things: given up on, it may still have been made.
      expect(JSON.parse(c.sent[0].item!.output)).toEqual({ error: "No answer within 28 seconds. It may still have been done: check before doing it again." });
      expect(JSON.parse(c.sent[1].item!.output)).toEqual({ project: "Birch", place: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  // v1.11 r4: a lookup has already paid for its answer by the time it is given up on, and asking again pays again.
  it.each(["consult_brain", "search_web"] as const)("%s held past the limit: its output says it took too long, and not to ask again unless the user asks", async (name) => {
    vi.useFakeTimers();
    try {
      const c = client();
      c.lookup("c1", name);
      await vi.advanceTimersByTimeAsync(TOOL_CALL_LIMIT_MS);
      expect(c.sent.map((e) => (e.type === "conversation.item.create" ? `output ${e.item!.call_id}` : e.type))).toEqual(["output c1", "response.create"]);
      expect(JSON.parse(c.sent[0].item!.output)).toEqual({ error: "No answer within 28 seconds: it took too long. Do not ask again unless the user asks." });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a lookup that answers at 25 s gets its answer (v1.11 r4: at 20 s it was given up on after it had paid)", async () => {
    vi.useFakeTimers();
    try {
      const c = client();
      c.lookup("c1", "consult_brain");
      await vi.advanceTimersByTimeAsync(25_000);
      expect(c.sent, "not given up on at 25 s").toEqual([]);
      c.asked[0].answer();
      await vi.advanceTimersByTimeAsync(0);
      expect(c.sent.map((e) => (e.type === "conversation.item.create" ? `output ${e.item!.call_id}` : e.type))).toEqual(["output c1", "response.create"]);
      expect(JSON.parse(c.sent[0].item!.output)).toEqual({ answer: "found" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a single call is answered and the reply goes on, as before", async () => {
    const c = client();
    c.call("c1", "Atlas");
    await settle();
    c.asked[0].answer();
    await settle();
    expect(c.sent.map((e) => (e.type === "conversation.item.create" ? `output ${e.item!.call_id}` : e.type))).toEqual(["output c1", "response.create"]);
  });
});
