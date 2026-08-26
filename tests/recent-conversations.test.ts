// SPEC §11 cross-session recall: the briefing opens every session with a
// verbatim tail of the last few conversations — voice and text, labeled with
// mode and timestamps, never summaries.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages, user } from "@/lib/db/schema";
import { getRecentConversationTails } from "@/lib/db/queries";
import { buildBriefing } from "@/lib/secretary/briefing";

const U = { id: `test-tails-${crypto.randomUUID()}`, email: `tails-${Date.now()}@recall.test` };
const tz = "America/Los_Angeles";

let currentId: string; // the live thread — must never echo back as "prior"
let voiceId: string;
let oldTextId: string;

async function makeConversation(
  mode: "text" | "voice",
  startedAt: Date,
  turns: { role: "user" | "assistant"; content: string; at: Date }[]
) {
  const [conv] = await db
    .insert(conversations)
    .values({ userId: U.id, mode, startedAt })
    .returning();
  if (turns.length) {
    await db.insert(messages).values(
      turns.map((t) => ({
        userId: U.id,
        conversationId: conv.id,
        role: t.role,
        content: t.content,
        mode,
        createdAt: t.at,
      }))
    );
  }
  return conv.id;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000);

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Tails Tester", email: U.email, timezone: tz });
  oldTextId = await makeConversation(
    "text",
    hoursAgo(48),
    Array.from({ length: 15 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: i === 14 ? "so remember: the venue deposit is due Friday" : `old turn ${i + 1}`,
      at: new Date(hoursAgo(48).getTime() + i * 60000),
    }))
  );
  voiceId = await makeConversation("voice", hoursAgo(24), [
    { role: "user", content: "I told Teresa the CPO is signed", at: hoursAgo(24) },
    { role: "assistant", content: "Logged — CPO signed, Teresa knows.", at: hoursAgo(23.9) },
  ]);
  // a voice token minted but never spoken into: no messages, must be skipped
  await makeConversation("voice", hoursAgo(12), []);
  currentId = await makeConversation("text", hoursAgo(1), [
    { role: "user", content: "this is the live thread", at: hoursAgo(1) },
  ]);
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("recent conversation tails", () => {
  it("excludes the current conversation, skips empty ones, newest first", async () => {
    const tails = await getRecentConversationTails(U.id, { excludeConversationId: currentId });
    expect(tails.map((t) => t.conversation.id)).toEqual([voiceId, oldTextId]);
  });

  it("caps each tail and keeps messages oldest-first within it", async () => {
    const tails = await getRecentConversationTails(U.id, {
      excludeConversationId: currentId,
      messagesPerConversation: 10,
    });
    const old = tails.find((t) => t.conversation.id === oldTextId)!;
    expect(old.messages).toHaveLength(10); // tail of 15, not the head
    expect(old.messages[0].content).toBe("old turn 6");
    expect(old.messages[9].content).toBe("so remember: the venue deposit is due Friday");
  });

  it("is user-scoped: a stranger sees no tails", async () => {
    const tails = await getRecentConversationTails(`nobody-${crypto.randomUUID()}`);
    expect(tails).toHaveLength(0);
  });
});

describe("briefing PRIOR SESSIONS block", () => {
  it("carries verbatim lines with mode labels, and never the excluded thread", async () => {
    const briefing = await buildBriefing(U.id, tz, { excludeConversationId: currentId });
    expect(briefing.text).toContain("PRIOR SESSIONS");
    // verbatim, not summarized
    expect(briefing.text).toContain("USER: I told Teresa the CPO is signed");
    expect(briefing.text).toContain("SECRETARY: Logged — CPO signed, Teresa knows.");
    expect(briefing.text).toContain("so remember: the venue deposit is due Friday");
    // mode labels so the model can say "on our call yesterday"
    expect(briefing.text).toContain("[voice session ·");
    expect(briefing.text).toContain("[text session ·");
    // the live thread is the model's own input — never echoed as prior
    expect(briefing.text).not.toContain("this is the live thread");
    // and the deep past is routed to the tool
    expect(briefing.text).toContain("search_history");
  });

  it("stays within the size cap", async () => {
    const briefing = await buildBriefing(U.id, tz, { excludeConversationId: currentId });
    const start = briefing.text.indexOf("PRIOR SESSIONS");
    const block = briefing.text.slice(start);
    // block cap (~3KB) plus header slack — the briefing must not balloon
    expect(block.length).toBeLessThan(4000);
  });
});
