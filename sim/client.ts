// Authed HTTP client for one sim user against the sim instance.
import { cfg } from "./config";

export type ChatResponse = {
  conversationId: string;
  userMessageId: string;
  assistantMessage: { id: string; role: string; content: string; createdAt: string };
  toasts: { icon: string; text: string }[];
};

export class SimClient {
  constructor(private cookie: string) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${cfg.appUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
        ...(init.headers ?? {}),
      },
    });
  }

  async chat(message: string, conversationId: string | null): Promise<ChatResponse> {
    const res = await this.request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message, conversationId }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`/api/chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as ChatResponse;
  }

  /** The endpoint the realtime voice model calls for tools. */
  async voiceTool(
    name: string,
    args: unknown,
    conversationId: string
  ): Promise<{ result: unknown; toast?: { icon: string; text: string } }> {
    const res = await this.request("/api/secretary/tools", {
      method: "POST",
      body: JSON.stringify({ name, args, conversationId }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok)
      throw new Error(`/api/secretary/tools ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return await res.json();
  }

  /** Persist a transcript line (what the voice client does for each utterance). */
  async persistMessage(
    conversationId: string,
    role: "user" | "assistant",
    content: string
  ): Promise<void> {
    const res = await this.request(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ role, content, mode: "voice" }),
    });
    if (!res.ok) throw new Error(`persist message ${res.status}`);
  }

  async getMessages(conversationId: string): Promise<Response> {
    return this.request(`/api/conversations/${conversationId}/messages`);
  }

  async getTasksViaTool(): Promise<unknown> {
    const res = await this.request("/api/secretary/tools", {
      method: "POST",
      body: JSON.stringify({ name: "get_tasks", args: {} }),
    });
    return res.ok ? await res.json() : null;
  }
}
