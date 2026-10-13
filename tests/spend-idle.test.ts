// docs/spend/SPEC.md §4 (v1.04): work nobody asked for costs nothing when
// nothing changed. Each kind of background work is run for real, twice over
// the same data, and then once more as a new process would (whatever is
// remembered in memory is forgotten): the second and third runs make no paid
// call. The providers are counting fakes; nothing leaves the machine.
process.env.TZ = "UTC";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const paid = vi.hoisted(() => ({ extraction: 0, suggestions: 0, email: 0, claudeOn: false, read: [] as string[] }));

vi.mock("@/lib/openai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/openai")>();
  const empty = { tasks: [], events: [], status_updates: [], facts: [], mentions: [], ambiguities: [] };
  return {
    ...real,
    openai: {
      responses: {
        create: async (req: { input?: unknown; text?: { format?: { name?: string } } }) => {
          const name = req.text?.format?.name;
          if (name === "extraction") {
            paid.extraction++;
            paid.read.push(String(req.input));
            return { output_text: JSON.stringify(empty), usage: { input_tokens: 2000, output_tokens: 300 } };
          }
          if (name === "suggestions") {
            paid.suggestions++;
            return { output_text: JSON.stringify({ suggestions: [] }), usage: { input_tokens: 5000, output_tokens: 50 } };
          }
          throw new Error(`unexpected OpenAI call ${String(name)}`);
        },
      },
    },
  };
});
// Claude is only switched on for the inbound-email test: its vision pass over
// an attachment is the paid call there. Asked to extract, this fake fails
// without a bill, so extraction takes its OpenAI road (the fake above).
vi.mock("@/lib/anthropic", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/anthropic")>();
  const client = {
    messages: {
      create: async (req: { system?: unknown }) => {
        if (!String(req.system).startsWith("Transcribe")) throw new Error("this fake only reads attachments");
        paid.email++;
        return { content: [{ type: "text", text: "Invoice 42, $220, due September 15." }], stop_reason: "end_turn", usage: { input_tokens: 1800, output_tokens: 40 } };
      },
      parse: async () => {
        throw new Error("this fake does not extract");
      },
    },
  };
  return { ...real, claudeBrainEnabled: () => paid.claudeOn, anthropicFor: async () => (paid.claudeOn ? client : null) };
});

import { db } from "@/lib/db";
import { conversations, messages, projects, tasks, usage, user } from "@/lib/db/schema";
import { ingestEmail, type ParsedEmail } from "@/lib/email-intake";
import { defaultPlan } from "@/lib/layout/plan";
import { clearPlanCache, lastPlannerUsage } from "@/lib/layout/plan-from-llm";
import { computeCurrentPlan, persistPlan } from "@/lib/layout/plan-store";
import { runExtraction } from "@/lib/secretary/extraction";
import { forgetSuggestionAttemptsForTests } from "@/lib/secretary/suggestions";
import { sweepUnderstanding } from "@/lib/understanding/sweep";
import { fakeModel, minimalOutputFor } from "./fixtures/understanding";

process.env.OPENAI_API_KEY = "test-not-sent";
const TZ = "America/Los_Angeles";
const users: string[] = [];
async function newUser(): Promise<{ id: string; email: string }> {
  const id = `test-idle-${crypto.randomUUID()}`;
  users.push(id);
  const email = `${id}@v104.test`;
  await db.insert(user).values({ id, name: "Idle", email, timezone: TZ });
  return { id, email };
}
const usageOf = (userId: string, kind: (typeof usage.kind.enumValues)[number]) =>
  db.select().from(usage).where(and(eq(usage.userId, userId), eq(usage.kind, kind)));

beforeEach(() => {
  paid.extraction = 0;
  paid.suggestions = 0;
  paid.email = 0;
  paid.claudeOn = false;
  paid.read = [];
  clearPlanCache();
  forgetSuggestionAttemptsForTests();
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  for (const id of users) await db.delete(user).where(eq(user.id, id));
});

describe("run twice over unchanged data, the second run makes no paid call", { timeout: 30_000 }, () => {
  it("understanding: the real sweep reads each project once; the next two sweeps call no model", async () => {
    const u = await newUser();
    for (const name of ["Boat", "Garden"]) {
      const [p] = await db.insert(projects).values({ userId: u.id, name }).returning();
      await db.insert(tasks).values({ userId: u.id, projectId: p.id, title: `${name}: a task`, status: "todo" });
    }
    const model = fakeModel((bundle) => minimalOutputFor(bundle));
    const now = new Date();
    const first = await sweepUnderstanding({ userIds: [u.id], model, now });
    expect(first.ran).toBe(2);
    expect(model.calls).toHaveLength(2);
    expect(await usageOf(u.id, "understanding")).toHaveLength(2);

    const second = await sweepUnderstanding({ userIds: [u.id], model, now });
    expect(second).toMatchObject({ ran: 0, failed: 0, skipped: 2 });
    // A new process: a new model call object, nothing held over in memory.
    const fresh = fakeModel((bundle) => minimalOutputFor(bundle));
    const third = await sweepUnderstanding({ userIds: [u.id], model: fresh, now });
    expect(third).toMatchObject({ ran: 0, failed: 0, skipped: 2 });
    expect(model.calls).toHaveLength(2);
    expect(fresh.calls).toHaveLength(0);
    expect(await usageOf(u.id, "understanding")).toHaveLength(2);
  });

  it("understanding: a read the validator refused is not paid for again on the same data", async () => {
    const u = await newUser();
    const [p] = await db.insert(projects).values({ userId: u.id, name: "Boat" }).returning();
    await db.insert(tasks).values({ userId: u.id, projectId: p.id, title: "Service the boat", status: "todo" });
    const bad = fakeModel(() => ({ not: "a record" }));
    const now = new Date();
    const first = await sweepUnderstanding({ userIds: [u.id], model: bad, now });
    expect(first.failed).toBe(1);
    const attempts = bad.calls.length;
    expect(attempts).toBeGreaterThan(0);
    const fresh = fakeModel(() => ({ not: "a record" }));
    expect(await sweepUnderstanding({ userIds: [u.id], model: fresh, now })).toMatchObject({ ran: 0, failed: 0 });
    expect(fresh.calls).toHaveLength(0);
    expect(bad.calls).toHaveLength(attempts);
  });

  it("extraction and suggestions: one read of what was said, one suggestions pass; nothing more until something is said", async () => {
    const u = await newUser();
    // Enough to predict from (suggestions skips a near-empty board).
    for (const title of ["Renew passport", "File taxes", "Service the boat"]) {
      await db.insert(tasks).values({ userId: u.id, title, status: "todo" });
    }
    const [conv] = await db.insert(conversations).values({ userId: u.id, mode: "voice" }).returning();
    const say = (content: string) => db.insert(messages).values({ userId: u.id, conversationId: conv.id, role: "user", content, mode: "voice" });
    await say("remind me about the boat");
    await runExtraction(u.id, conv.id, TZ);
    expect(paid).toMatchObject({ extraction: 1, suggestions: 1 });

    await runExtraction(u.id, conv.id, TZ);
    expect(paid).toMatchObject({ extraction: 1, suggestions: 1 });
    // A new process forgets when it last tried.
    forgetSuggestionAttemptsForTests();
    await runExtraction(u.id, conv.id, TZ);
    expect(paid).toMatchObject({ extraction: 1, suggestions: 1 });
    expect(await usageOf(u.id, "extraction")).toHaveLength(1);
    expect(await usageOf(u.id, "other")).toHaveLength(1);

    // Something new is said: that is read (once), and the day's suggestions
    // stay closed by the recorded call, in the new process too.
    await say("and the trailer");
    await runExtraction(u.id, conv.id, TZ);
    expect(paid).toMatchObject({ extraction: 2, suggestions: 1 });
  });

  it("extraction: the mark is the last message's own stored time, to the microsecond; a message later in the same millisecond is still read, alone", async () => {
    const u = await newUser();
    const [conv] = await db.insert(conversations).values({ userId: u.id, mode: "voice" }).returning();
    const at = (micros: string) => sql`${`2026-10-12T17:00:00.${micros}Z`}::timestamptz`;
    const say = (content: string, micros: string) =>
      db.insert(messages).values({ userId: u.id, conversationId: conv.id, role: "user", content, mode: "voice", createdAt: at(micros) });
    await say("book the boat slip", "123400");
    await runExtraction(u.id, conv.id, TZ);
    const stored = async () =>
      ((await db.execute(sql`select extracted_at::text as mark, (select max(created_at)::text from messages where conversation_id = ${conv.id}) as latest from conversations where id = ${conv.id}`)) as unknown as { rows: { mark: string; latest: string }[] }).rows[0];
    expect((await stored()).mark).toMatch(/00\.1234/);
    expect((await stored()).mark).toBe((await stored()).latest);

    // Nothing new: no read, however often it is asked for.
    await runExtraction(u.id, conv.id, TZ);
    await runExtraction(u.id, conv.id, TZ);
    expect(paid.extraction).toBe(1);

    // 0.5 ms later, inside the same millisecond as the mark.
    await say("and call the harbour office", "123900");
    await runExtraction(u.id, conv.id, TZ);
    expect(paid.extraction).toBe(2);
    expect(paid.read[1]).toContain("and call the harbour office");
    expect(paid.read[1]).not.toContain("book the boat slip");
    expect((await stored()).mark).toMatch(/00\.1239/);
  });

  it("the dashboard planner: one call for a situation; the next two renders of it, one in a new process, call nothing", async () => {
    const u = await newUser();
    const [p] = await db.insert(projects).values({ userId: u.id, name: "Boat" }).returning();
    await db.insert(tasks).values({ userId: u.id, projectId: p.id, title: "Service the boat", status: "todo", dueAt: new Date(Date.now() + 3 * 86_400_000) });
    let calls = 0;
    const render = async () => {
      const bundle = await computeCurrentPlan(u.id);
      await persistPlan(u.id, bundle, {
        call: async () => {
          calls++;
          lastPlannerUsage.model = "claude-sonnet-5";
          lastPlannerUsage.input = 4_000;
          lastPlannerUsage.output = 800;
          // The planner's own plan: the default with the strip opened, so it is not what the rules made.
          const plan = defaultPlan(bundle.signals);
          return JSON.stringify({ ...plan, plan_id: "p", reason_summary: "Dates first", sections: plan.sections.map((s) => (s.component === "timeline" ? { ...s, props: { span_days: 14, expanded: true }, why: "A date is close" } : s)) });
        },
      });
      return bundle;
    };
    await render();
    expect(calls).toBe(1);
    expect(await usageOf(u.id, "layout")).toHaveLength(1);
    const second = await render();
    expect(second.wantsLlmRefinement).toBe(false);
    clearPlanCache(); // a new process
    const third = await render();
    expect(third.wantsLlmRefinement).toBe(false);
    expect(calls).toBe(1);
    expect(await usageOf(u.id, "layout")).toHaveLength(1);
  });

  it("inbound email: an attachment is read once; the same message taken in again is not read again", async () => {
    const u = await newUser();
    paid.claudeOn = true;
    // ingestEmail leaves the vision pass and the extraction out under vitest; this test is about exactly those.
    vi.stubEnv("VITEST", "");
    const mail: ParsedEmail = {
      messageId: `<${crypto.randomUUID()}@test>`,
      fromAddress: u.email,
      subject: "Invoice",
      text: "See attached.",
      authenticationResults: "mx.test.local; spf=pass dkim=pass dmarc=pass",
      attachments: [{ contentType: "application/pdf", filename: "invoice.pdf", content: Buffer.from("%PDF-1.4 not a real file") }],
    };
    expect((await ingestEmail(mail)).outcome).toBe("ingested");
    expect(paid.email).toBe(1);
    expect(await usageOf(u.id, "email")).toHaveLength(1);
    const reads = { ...paid };

    // The scan finds it unread again (the flag was never set, or the process restarted before it was).
    expect((await ingestEmail(mail)).outcome).toBe("duplicate");
    expect((await ingestEmail({ ...mail, attachments: [...mail.attachments] })).outcome).toBe("duplicate");
    expect(paid).toEqual(reads);
    expect(await usageOf(u.id, "email")).toHaveLength(1);
  });
});
