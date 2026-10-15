// A stand-in for Anthropic's Messages API, for the browser tests (playwright.config.ts starts it next to the app and
// points ANTHROPIC_BASE_URL at it). No model, no key, nothing leaves the machine. It answers the way the streaming API
// does: a turn whose last line says "Add to the note of task <id>: <words>" gets one amend_task call; the turn after
// a tool result gets "Added."; anything else gets "Noted.". It keeps nothing between requests.
import http from "node:http";

const PORT = Number(process.env.STANDIN_PORT ?? 4000);
let n = 0;

/** The text of the last message, whatever shape its content has. */
function lastText(messages) {
  const last = messages?.at(-1);
  if (!last) return { text: "", toolResult: false };
  if (typeof last.content === "string") return { text: last.content, toolResult: false };
  const blocks = Array.isArray(last.content) ? last.content : [];
  return {
    text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
    toolResult: blocks.some((b) => b.type === "tool_result"),
  };
}

http
  .createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") return res.end("ok");
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end("{}");
    }
    const request = JSON.parse(body || "{}");
    const { text, toolResult } = lastText(request.messages);
    const ask = toolResult ? null : text.match(/Add to the note of task (\S+): (.+)$/m);
    n += 1;
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    ev("message_start", {
      message: { id: `msg_standin_${n}`, type: "message", role: "assistant", model: request.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
    });
    if (ask) {
      const input = { task: ask[1], note: ask[2].trim() };
      ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_standin_${n}`, name: "amend_task", input: {} } });
      ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
    } else {
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: toolResult ? "Added." : "Noted." } });
      ev("content_block_stop", { index: 0 });
      ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } });
    }
    ev("message_stop", {});
    res.end();
  })
  .listen(PORT, "127.0.0.1", () => console.log(`model stand-in on 127.0.0.1:${PORT}`));
