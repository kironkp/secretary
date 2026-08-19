// SPEC §11 entity cross-reference + clarification queue. The core fixture:
// "signed by Marissa, Teresa Mahers, my boss" — Marissa existed in the store
// since Jul 30, and the Aug 18 session DROPPED her without asking. That can
// never happen again: exact mentions touch, near-misses queue, ambiguity is
// asked ONE at a time, and nothing is silently merged.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { clarifications, entities, user } from "@/lib/db/schema";
import { buildBriefing } from "@/lib/secretary/briefing";
import { crossReferenceMention, crossReferenceMentions } from "@/lib/secretary/entities";
import { applyExtraction } from "@/lib/secretary/extraction";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-entities-${crypto.randomUUID()}`, email: `ent-${Date.now()}@p8.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Entity Tester", email: U.email, timezone: ctx.timezone });
  // Marissa has existed since Jul 30 — the store the session ignored.
  await db.insert(entities).values([
    { userId: U.id, name: "Marissa", kind: "person", createdAt: new Date("2026-07-30") },
    { userId: U.id, name: "Walter Maiara", kind: "person" },
  ]);
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("entity cross-reference", () => {
  it("an exact mention touches the entity — never dropped, never re-created", async () => {
    const outcome = await crossReferenceMention(U.id, {
      name: "Marissa",
      kind: "person",
      context: "signed by Marissa, Teresa Mahers, my boss",
    });
    expect(outcome.action).toBe("touched");
    const rows = await db
      .select()
      .from(entities)
      .where(and(eq(entities.userId, U.id), eq(entities.name, "Marissa")));
    expect(rows).toHaveLength(1); // still exactly one Marissa
  });

  it("a near-miss ('Walter Myara') queues an entity_conflict — no silent merge, no twin", async () => {
    const outcome = await crossReferenceMention(U.id, { name: "Walter Myara", kind: "person" });
    expect(outcome.action).toBe("conflict");
    const twins = await db
      .select()
      .from(entities)
      .where(and(eq(entities.userId, U.id), eq(entities.name, "Walter Myara")));
    expect(twins).toHaveLength(0);
    const [c] = await db
      .select()
      .from(clarifications)
      .where(and(eq(clarifications.userId, U.id), eq(clarifications.kind, "entity_conflict")));
    expect(c.question).toContain("Walter Myara");
    expect(c.question).toContain("Walter Maiara");
  });

  it("a low-confidence new name is created UNCONFIRMED with a spelling question", async () => {
    const outcome = await crossReferenceMention(U.id, {
      name: "Pay-Aye-Test",
      kind: "term",
      context: "I'm gonna refer me to pay I test",
      confidence: "low",
    });
    expect(outcome.action).toBe("created");
    const [ent] = await db
      .select()
      .from(entities)
      .where(and(eq(entities.userId, U.id), eq(entities.name, "Pay-Aye-Test")));
    expect(ent.confirmed).toBe(false); // not usable in documents yet
    const spelling = await db
      .select()
      .from(clarifications)
      .where(and(eq(clarifications.userId, U.id), eq(clarifications.kind, "new_name")));
    expect(spelling.length).toBe(1);
  });

  it("confident new names are just created (Teresa Mahers)", async () => {
    const [outcome] = await crossReferenceMentions(U.id, [
      { name: "Teresa Mahers", kind: "person", confidence: "high" },
    ]);
    expect(outcome.action).toBe("created");
  });
});

describe("clarification queue discipline", () => {
  it("the briefing surfaces exactly ONE question and holds the rest", async () => {
    // queue state from the tests above: entity_conflict + new_name (+ extraction referent below)
    await applyExtraction(U.id, "conv-x", {
      tasks: [],
      events: [],
      status_updates: [],
      facts: [],
      mentions: [],
      ambiguities: [
        {
          kind: "referent",
          question: "You said 'this one is finished' — which CPO was that?",
          context: "Okay. So in my... this one is finished.",
        },
      ],
    });
    const briefing = await buildBriefing(U.id, ctx.timezone);
    const sections = briefing.text.match(/CLARIFICATION QUEUE/g) ?? [];
    expect(sections).toHaveLength(1);
    // exactly one "- " question line inside the clarification block
    const block = briefing.text.split("CLARIFICATION QUEUE")[1].split("\n\n")[0];
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
    expect(block).toContain("more queued");
    expect(block).toContain("never mid-flow");
  });

  it("resolve_clarification same_entity records an alias — the Marissa answer", async () => {
    const { result } = await executeTool(ctx, "resolve_clarification", {
      question: "Walter Myara",
      answer: "that's Walter Maiara, same guy",
      action: "same_entity",
    });
    expect((result as { resolved?: boolean }).resolved).toBe(true);
    const [walter] = await db
      .select()
      .from(entities)
      .where(and(eq(entities.userId, U.id), eq(entities.name, "Walter Maiara")));
    expect(walter.aliases).toContain("Walter Myara");
    // and the alias now resolves exactly — no future conflict
    const again = await crossReferenceMention(U.id, { name: "Walter Myara", kind: "person" });
    expect(again.action).toBe("touched");
  });
});
