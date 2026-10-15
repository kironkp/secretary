// SPEC §11 ASR lexicon export. Transcript garble fixture: "CPU" for CPO,
// "calc card" for CalCard — the store's exact spellings must reach the
// realtime transcription config so the ASR stops mishearing them.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { entities, projects, user } from "@/lib/db/schema";
import { buildLexicon, lexiconPrompt } from "@/lib/secretary/lexicon";
import { crossReferenceMention } from "@/lib/secretary/entities";

const U = { id: `test-lexicon-${crypto.randomUUID()}`, email: `lex-${Date.now()}@p9.test` };

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Lexicon Tester", email: U.email });
  await db.insert(entities).values([
    { userId: U.id, name: "CPO", kind: "acronym", aliases: ["CPU"] }, // the classic garble, aliased
    { userId: U.id, name: "CalCard", kind: "term", aliases: ["calc card"] },
    { userId: U.id, name: "Tamsin Malvey", kind: "person" },
    { userId: U.id, name: "Warren Maiada", kind: "person" },
    { userId: U.id, name: "QTB", kind: "acronym" },
  ]);
  await db.insert(projects).values({ userId: U.id, name: "canterly", status: "active" });
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("lexicon export", () => {
  it("exports store vocabulary — entities, aliases, and project names", async () => {
    const terms = await buildLexicon(U.id);
    for (const expected of ["CPO", "CPU", "CalCard", "calc card", "Tamsin Malvey", "Warren Maiada", "QTB", "canterly"]) {
      expect(terms).toContain(expected);
    }
  });

  it("updates on every new entity — the next session hears the new name", async () => {
    await crossReferenceMention(U.id, { name: "Avery Linden", kind: "person", confidence: "high" });
    const terms = await buildLexicon(U.id);
    expect(terms).toContain("Avery Linden");
  });

  it("dedupes case-insensitively and produces a biasing prompt", async () => {
    const terms = await buildLexicon(U.id);
    const lower = terms.map((t) => t.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    const prompt = lexiconPrompt(terms);
    expect(prompt).toContain("exact spellings");
    expect(prompt).toContain("CalCard");
    expect(lexiconPrompt([])).toBeUndefined();
  });

  it("caps the export at the prompt budget, most recent first", async () => {
    const bulk = Array.from({ length: 130 }, (_, i) => ({
      userId: U.id,
      name: `Filler Term ${i}`,
      kind: "term" as const,
      lastMentionedAt: new Date(Date.now() + i * 1000),
    }));
    await db.insert(entities).values(bulk);
    const terms = await buildLexicon(U.id);
    expect(terms.length).toBeLessThanOrEqual(120);
    expect(terms[0]).toBe("Filler Term 129"); // most recently mentioned wins
  });
});
