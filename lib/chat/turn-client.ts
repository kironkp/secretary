// The page's side of a written chat turn (docs/chat/SPEC.md §1, §3). It asks
// for the stream and reads it line by line. After a drop (the stream ends
// before its last line, the request fails on the network, or the answer is not
// the stream, such as the router's own 503 page) it asks again with the same
// turn id, marked resume, at once, after 2 s and after 5 s. A resume only
// fetches or waits: it never makes the server run a model. Only a send or his
// tap does, and his tap is a new sendTurn with the same turn id.

export type DoneLine = {
  type: "done";
  conversationId: string;
  userMessageId: string;
  assistantMessage: { id: string; role: "assistant"; content: string; createdAt: string };
  toasts: unknown[];
  uiActions: unknown[];
};
export type TurnLine =
  | { type: "accepted"; turnId: string | null; conversationId: string; userMessageId: string }
  | { type: "text"; round: number; text: string }
  | { type: "ping" }
  | DoneLine
  | { type: "error"; error: string };
export type TurnBody = { message: string; conversationId: string | null; attachmentIds: string[] };
export type TurnOutcome = { ok: true; answer: DoneLine } | { ok: false; error: string };

/** The page's own asks after a drop, and how long it waits before each. */
export const RESUME_DELAYS_MS = [0, 2000, 5000];
const NOT_DELIVERED = "Not delivered";

/** A turn's id: 128 random bits as hex. getRandomValues works where randomUUID does not (a page on plain http). */
export function newTurnId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One ask's end: an answer, a failure to show, or a drop to resume from. */
type AskEnd = TurnOutcome | { dropped: true };

async function ask(
  fetchFn: typeof fetch,
  turnId: string,
  body: TurnBody,
  resume: boolean,
  onLine: (line: TurnLine) => void
): Promise<AskEnd> {
  let res: Response;
  try {
    res = await fetchFn("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ ...body, turnId, ...(resume ? { resume: true } : {}) }),
    });
  } catch {
    return { dropped: true };
  }
  if (!(res.headers.get("content-type") ?? "").includes("application/x-ndjson") || !res.body) {
    // A refusal before any work keeps its status and JSON ("Say something or attach a file").
    // Anything else (the router's own page, a proxy's) is a drop.
    const text = await res.text().catch(() => "");
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (!res.ok && typeof parsed.error === "string") return { ok: false, error: parsed.error };
    } catch {
      // not JSON
    }
    return { dropped: true };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!raw) continue;
        const line = JSON.parse(raw) as TurnLine;
        onLine(line);
        if (line.type === "done") return { ok: true, answer: line };
        if (line.type === "error") return { ok: false, error: line.error };
      }
    }
  } catch {
    // the connection dropped mid-answer
  }
  return { dropped: true };
}

/**
 * Sends a turn (or his tap's resend of it) and brings back its answer, or the
 * sentence to show under his message. onLine hears every line as it comes,
 * the resumes' too.
 */
export async function sendTurn(opts: {
  turnId: string;
  body: TurnBody;
  onLine?: (line: TurnLine) => void;
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}): Promise<TurnOutcome> {
  const fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const onLine = opts.onLine ?? (() => {});
  let end = await ask(fetchFn, opts.turnId, opts.body, false, onLine);
  for (const delay of RESUME_DELAYS_MS) {
    if (!("dropped" in end)) return end;
    await wait(delay);
    end = await ask(fetchFn, opts.turnId, opts.body, true, onLine);
  }
  return "dropped" in end ? { ok: false, error: NOT_DELIVERED } : end;
}
