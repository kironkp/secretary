// docs/understanding/SPEC.md §7 (a lede is "stored on the record keyed by
// widget id and shipped in the workspace payload as `ledes[widgetId]` ... the
// client renders a stale lede dimmed until the fresh one lands") and §9, the
// server half: lib/understanding/words.ts ledesFor, against the local database
// on one throwaway user seeded with the duplicate-CPO scenario. No model is
// involved: the ledes are written by hand onto the records, as a run would.
//
// Everything is relative to the real clock, not CPO_NOW: the scenario's Album
// task takes the database's own now() as its updated_at, and a fixed date
// would make "newer than every task" true only until that date passed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, records, tasks, user } from "@/lib/db/schema";
import type { ProjectRecord } from "@/lib/understanding/types";
import { ledesFor } from "@/lib/understanding/words";
import { CPO_TZ, seedCpoScenario, type CpoIds } from "./fixtures/understanding";

const U = {
  id: `test-understanding-words-${crypto.randomUUID()}`,
  email: `understanding-words-${Date.now()}@p11.test`,
};
const NOW = new Date();
const HOUR_MS = 3_600_000;
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * HOUR_MS);

let ids: CpoIds;
let emptyProjectId = "";

const LEDES = {
  caltrans: {
    overdue: "Both of these are the same CPO. The oldest has waited since August.",
    "everything-open": "Three are one job.",
    shared: "Written by Caltrans, the older record.",
  },
  album: {
    "due-today": "One track is left to master.",
    shared: "Written by Album, the newer record.",
  },
};

const emptyRecord = (): ProjectRecord => ({
  things: [],
  rules: [],
  decisions: [],
  currentWork: [],
  blockers: [],
  attempts: [],
  contradictions: [],
  unknowns: [],
  asked: [],
  lastActivityAt: NOW.toISOString(),
});

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Understanding Words Tester", email: U.email, timezone: CPO_TZ });
  ids = await seedCpoScenario(U.id, NOW);

  // Both records are newer than every task the scenario seeded (the newest
  // task is the Album one, at the database's now()); Album's is the newer of
  // the two, so it owns the shared widget id.
  await db.insert(records).values([
    {
      userId: U.id,
      projectId: ids.caltrans,
      body: emptyRecord(),
      inputsHash: "test-caltrans",
      words: { todayLine: "Nothing is due today.", ledes: LEDES.caltrans },
      updatedAt: hoursFromNow(1),
    },
    {
      userId: U.id,
      projectId: ids.album,
      body: emptyRecord(),
      inputsHash: "test-album",
      words: { ledes: LEDES.album },
      updatedAt: hoursFromNow(2),
    },
  ]);

  // A third project whose record predates the words column: `{}` and nothing
  // else, the shape an old row reads back as.
  const [empty] = await db
    .insert(projects)
    .values({ userId: U.id, name: "Empty", status: "active" })
    .returning({ id: projects.id });
  emptyProjectId = empty.id;
  await db.insert(records).values({
    userId: U.id,
    projectId: emptyProjectId,
    body: emptyRecord(),
    inputsHash: "test-empty",
    words: sql`'{}'::jsonb`,
    updatedAt: hoursFromNow(3),
  });
});

afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("ledesFor", () => {
  it("returns every lede keyed by widget id, with its text and project", async () => {
    const ledes = await ledesFor(U.id);
    expect(Object.keys(ledes).sort()).toEqual(["due-today", "everything-open", "overdue", "shared"]);

    expect(ledes.overdue.text).toBe(LEDES.caltrans.overdue);
    expect(ledes.overdue.projectId).toBe(ids.caltrans);
    expect(ledes["everything-open"].text).toBe(LEDES.caltrans["everything-open"]);
    expect(ledes["everything-open"].projectId).toBe(ids.caltrans);
    expect(ledes["due-today"].text).toBe(LEDES.album["due-today"]);
    expect(ledes["due-today"].projectId).toBe(ids.album);
  });

  it("is not stale while the record is newer than every task of its project", async () => {
    const ledes = await ledesFor(U.id);
    expect(ledes.overdue.stale).toBe(false);
    expect(ledes["everything-open"].stale).toBe(false);
    expect(ledes["due-today"].stale).toBe(false);
  });

  it("the newer record wins a widget id two records both carry", async () => {
    const ledes = await ledesFor(U.id);
    expect(ledes.shared.text).toBe(LEDES.album.shared);
    expect(ledes.shared.projectId).toBe(ids.album);
  });

  it("a record whose words are {} contributes nothing and breaks nothing", async () => {
    const ledes = await ledesFor(U.id);
    expect(Object.values(ledes).some((l) => l.projectId === emptyProjectId)).toBe(false);
  });

  it("goes stale when a task of its project moves after the record was written", async () => {
    // Touch one Caltrans task past the Caltrans record (+1h): every lede of
    // that record is stale, and the Album record's are not.
    await db
      .update(tasks)
      .set({ updatedAt: hoursFromNow(1.5) })
      .where(and(eq(tasks.userId, U.id), eq(tasks.id, ids.checkCpo)));

    const ledes = await ledesFor(U.id);
    expect(ledes.overdue.stale).toBe(true);
    expect(ledes["everything-open"].stale).toBe(true);
    expect(ledes["due-today"].stale).toBe(false);
    // The shared lede is the Album record's, so the Caltrans touch does not
    // reach it.
    expect(ledes.shared.stale).toBe(false);
    // Stale is a flag, not a cut: the text is still the whole lede.
    expect(ledes.overdue.text).toBe(LEDES.caltrans.overdue);
  });

  it("returns {} for a user with no records", async () => {
    expect(await ledesFor(`nobody-${crypto.randomUUID()}`)).toEqual({});
  });
});
