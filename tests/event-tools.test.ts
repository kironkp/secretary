// Capture fidelity: events are editable, reminders are first-class, and
// reminder writes are honest about delivery (logged-only, no push yet).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { events, tasks, user } from "@/lib/db/schema";
import { executeTool } from "@/lib/secretary/tools";

const U = { id: `test-event-${crypto.randomUUID()}`, email: `e-${Date.now()}@event.test` };
const OTHER = { id: `test-event-o-${crypto.randomUUID()}`, email: `o-${Date.now()}@event.test` };
const ctx = { userId: U.id, timezone: "America/Los_Angeles" };

const MEETING_AT = new Date(Date.now() + 3 * 86400000);
const r = (minsBefore: number) =>
  new Date(MEETING_AT.getTime() - minsBefore * 60000).toISOString();

beforeAll(async () => {
  await db.insert(user).values([
    { id: U.id, name: "Event Test", email: U.email },
    { id: OTHER.id, name: "Other", email: OTHER.email },
  ]);
});

afterAll(async () => {
  await db.delete(user).where(inArray(user.id, [U.id, OTHER.id]));
});

describe("event tools", () => {
  it("create_event stores notes + reminders and reports logged-only delivery", async () => {
    const res = await executeTool(ctx, "create_event", {
      title: "Patent meeting with Ash",
      starts_at: MEETING_AT.toISOString(),
      location: "Stephens Law Group",
      notes: "11:00 AM PT / 2:00 PM ET",
      reminders: [r(10), r(5), r(0)],
    });
    const out = res.result as { event_id: string; reminders: string[]; delivery: string };
    expect(out.delivery).toBe("logged-only");
    expect(out.reminders).toHaveLength(3);
    const [row] = await db.select().from(events).where(eq(events.id, out.event_id));
    expect(row.notes).toBe("11:00 AM PT / 2:00 PM ET");
    expect(row.reminders).toHaveLength(3);
  });

  it("update_event finds by title fragment and updates notes + reminders", async () => {
    const res = await executeTool(ctx, "update_event", {
      event: "patent meeting",
      notes: "11:00 AM PT / 2:00 PM ET — bring prior art questions",
      reminders: [r(10), r(5), r(0)],
    });
    const out = res.result as { event_id: string; notes: string; delivery: string };
    expect(out.delivery).toBe("logged-only");
    expect(out.notes).toContain("2:00 PM ET");
    expect(res.toast?.text).toContain("reminders");
  });

  it("update_event never touches another user's event", async () => {
    const res = await executeTool(
      { userId: OTHER.id, timezone: "UTC" },
      "update_event",
      { event: "patent meeting", notes: "hijacked" }
    );
    expect((res.result as { error: string }).error).toContain("No event matching");
  });

  it("update_task can set reminders (logged-only)", async () => {
    const created = await executeTool(ctx, "create_task", { title: "Prep patent questions" });
    const id = (created.result as { task_id: string }).task_id;
    const res = await executeTool(ctx, "update_task", { task: id, reminders: [r(30)] });
    const out = res.result as { reminders: string[]; delivery: string };
    expect(out.delivery).toBe("logged-only");
    expect(out.reminders).toHaveLength(1);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row.reminders).toHaveLength(1);
  });

  it("delete_event removes it", async () => {
    const res = await executeTool(ctx, "delete_event", { event: "patent meeting" });
    expect((res.result as { deleted: string }).deleted).toBe("Patent meeting with Ash");
    const rows = await db.select().from(events).where(eq(events.userId, U.id));
    expect(rows).toHaveLength(0);
  });

  it("bad reminder timestamps are rejected, not silently dropped", async () => {
    const res = await executeTool(ctx, "create_task", {
      title: "bad reminder task",
      reminders: ["ten minutes before"],
    });
    expect((res.result as { error: string }).error).toContain("Unparseable reminder");
  });
});
