// The two numbers the one urgency order is built on (lib/project-order.ts),
// as computeSignals reads them from the database (SEC-A007, v1.02):
// soonest_days is the earliest date among the user's OPEN work, in his
// calendar days, and deadline_days is the project's own stored deadline. A
// finished task, or a suggestion still waiting, is not his open work; and
// "today" is his today, not UTC's. Against the local database.
process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { projects, tasks, user } from "@/lib/db/schema";
import { computeSignals } from "@/lib/layout/signals";

const TZ = "America/Los_Angeles";
// 7 PM on Tue Oct 6 in Los Angeles; already Wed Oct 7 in UTC.
const NOW = new Date("2026-10-07T02:00:00Z");
const U = { id: `test-signals-soonest-${crypto.randomUUID()}`, email: `signals-soonest-${Date.now()}@v102.test` };
const at = (iso: string) => new Date(iso);
const ids: Record<string, string> = {};

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Signals", email: U.email, timezone: TZ });
  const project = async (name: string, deadline: Date | null = null) => {
    const [p] = await db.insert(projects).values({ userId: U.id, name, status: "active", deadline }).returning();
    ids[name] = p.id;
    return p.id;
  };
  const task = (projectId: string, title: string, dueAt: Date | null, status: "todo" | "done" | "inbox" | "blocked" = "todo", source: "spoken" | "suggested" = "spoken") =>
    db.insert(tasks).values({ userId: U.id, projectId, title, status, source, dueAt });

  // Its late task is finished, and its late suggestion was never taken up: the open work is in five days.
  const mixed = await project("Mixed");
  await task(mixed, "finished long ago", at("2026-09-20T19:00:00Z"), "done");
  await task(mixed, "a suggestion nobody accepted", at("2026-09-25T19:00:00Z"), "inbox", "suggested");
  await task(mixed, "the real next step", at("2026-10-11T19:00:00Z"));
  // Nothing open is dated at all.
  const settled = await project("Settled");
  await task(settled, "done and dated", at("2026-09-30T19:00:00Z"), "done");
  await task(settled, "open, no date", null);
  // Due at 1 PM his time today: today for him, yesterday by the UTC date.
  const today = await project("Today");
  await task(today, "due this afternoon", at("2026-10-06T20:00:00Z"));
  // A blocked task is still his open work, and it is late.
  const blocked = await project("Blocked");
  await task(blocked, "waiting on someone", at("2026-10-03T19:00:00Z"), "blocked");
  // Its own deadline is 1 PM tomorrow his time, which is still "today" in UTC.
  await project("Deadline", at("2026-10-07T20:00:00Z"));
});
afterAll(async () => {
  await db.delete(user).where(eq(user.id, U.id));
});

describe("soonest_days and deadline_days", () => {
  it("a finished task and a waiting suggestion do not count as a project's soonest", async () => {
    const by = Object.fromEntries((await computeSignals(U.id, NOW)).projects.map((p) => [p.name, p]));
    expect(by.Mixed.soonest_days).toBe(5);
    expect(by.Settled.soonest_days).toBeNull();
    expect(by.Blocked.soonest_days).toBe(-3);
  });

  it("days are his calendar days: due this afternoon is today, not yesterday", async () => {
    const by = Object.fromEntries((await computeSignals(U.id, NOW)).projects.map((p) => [p.name, p]));
    expect(by.Today.soonest_days).toBe(0);
  });

  it("deadline_days is the project's own deadline in his days, and null without one", async () => {
    const by = Object.fromEntries((await computeSignals(U.id, NOW)).projects.map((p) => [p.name, p]));
    expect(by.Deadline.deadline_days).toBe(1);
    expect(by.Deadline.soonest_days).toBeNull();
    expect(by.Mixed.deadline_days).toBeNull();
  });
});
