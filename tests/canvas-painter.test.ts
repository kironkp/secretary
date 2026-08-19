// "Paint what I just said" (from the 2026-08-19 CPO call failure): the painter
// must SEE the conversation — spoken details are first-class facts, not
// placeholders. Unit: input assembly. Integration: the stream receives the
// seeded utterances for the exact transcript beats that got dropped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, messages, user } from "@/lib/db/schema";
import { buildPainterInput, paintCanvas } from "@/lib/canvas/painter";

const U = { id: `test-painter-${crypto.randomUUID()}`, email: `paint-${Date.now()}@cv.test` };

describe("buildPainterInput", () => {
  it("places the conversation excerpt between SIGNALS and BRIEF when present", () => {
    const input = buildPainterInput("lay out what we discussed", '{"projects":[]}', {
      conversationExcerpt: "USER: CPO 2079 is antenna, blocked on the TASCAM.",
    });
    const iSignals = input.indexOf("SIGNALS:");
    const iConv = input.indexOf("CONVERSATION (");
    const iBrief = input.indexOf("BRIEF:");
    expect(iConv).toBeGreaterThan(iSignals);
    expect(iBrief).toBeGreaterThan(iConv);
    expect(input).toContain("blocked on the TASCAM");
    expect(input).toContain("verbatim source of truth");
  });

  it("omits the conversation section entirely when there is no excerpt", () => {
    expect(buildPainterInput("brief", "{}")).not.toContain("CONVERSATION (");
  });
});

describe("paintCanvas conversation context (integration)", () => {
  let conversationId: string;

  beforeAll(async () => {
    await db.insert(user).values({ id: U.id, name: "Painter Tester", email: U.email });
    const [conv] = await db
      .insert(conversations)
      .values({ userId: U.id, mode: "voice" })
      .returning();
    conversationId = conv.id;
    await db.insert(messages).values([
      {
        userId: U.id,
        conversationId,
        role: "user",
        mode: "voice",
        content:
          "The one I paid this month was CPO ending in 0035, called comms. 2073 is production monitor, doing it this month. 2110 lenses and camera accessories moves to fiscal year 2027. And 2079 is antenna — blocked, we're still waiting on the TASCAM.",
      },
      {
        userId: U.id,
        conversationId,
        role: "assistant",
        mode: "voice",
        content: "Got it. 2073 this month, 2110 to FY 2027.",
      },
    ]);
  });
  afterAll(async () => {
    await db.delete(user).where(eq(user.id, U.id));
  });

  it("feeds the spoken CPO details to the painter model", async () => {
    let received = "";
    async function* captureStream(_prompt: string, input: string) {
      received = input;
      yield "<div>ok</div>";
    }
    await paintCanvas(U.id, "lay out the CPO status we just discussed", {
      conversationId,
      stream: captureStream,
    });
    for (const detail of ["0035", "comms", "2073", "production monitor", "2110", "2079", "antenna", "TASCAM"]) {
      expect(received).toContain(detail);
    }
    expect(received).toContain("USER:");
  });

  it("still paints without a conversation (dashboard-style briefs)", async () => {
    let received = "";
    async function* captureStream(_prompt: string, input: string) {
      received = input;
      yield "<div>ok</div>";
    }
    await paintCanvas(U.id, "paint my week", { stream: captureStream });
    expect(received).not.toContain("CONVERSATION (");
    expect(received).toContain("BRIEF:\npaint my week");
  });
});
