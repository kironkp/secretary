// The words Today shows, checked without a browser or a database.
// components/today/copy.ts is pure on purpose: the sentence under an answer
// button and the receipt after it are the two places the honesty rule
// (docs/understanding/SPEC.md §10) is visible, so they get a test each.
import { describe, expect, it } from "vitest";
import {
  appliedInWords,
  dateLine,
  failedInWords,
  kindClass,
  kindLabel,
  lateInWords,
  receiptInWords,
  updatedLine,
  writesInWords,
} from "@/components/today/copy";

describe("kind labels", () => {
  it("names the three kinds the way the mockup does", () => {
    expect(kindLabel("need_to_know")).toBe("Need to know");
    expect(kindLabel("doesnt_add_up")).toBe("Doesn't add up");
    expect(kindLabel("done_yet")).toBe("Done yet?");
  });

  it("colors them with the app's tokens, never a raw hex", () => {
    expect(kindClass("need_to_know")).toBe("text-grape");
    expect(kindClass("doesnt_add_up")).toBe("text-warn");
    expect(kindClass("done_yet")).toBe("text-accent");
  });

  it("has a plain fallback for a kind it does not know", () => {
    expect(kindLabel("referent")).toBe("Question");
    expect(kindClass("referent")).toBe("text-muted");
  });
});

describe("what an answer will write", () => {
  it("counts task writes and says them in words", () => {
    expect(
      writesInWords([
        { op: "complete_task" },
        { op: "complete_task" },
        { op: "resolve" },
      ])
    ).toBe("marks 2 tasks done");
    expect(writesInWords([{ op: "complete_task" }])).toBe("marks 1 task done");
    expect(writesInWords([{ op: "drop_task" }, { op: "drop_task" }, { op: "drop_task" }])).toBe(
      "drops 3 tasks"
    );
  });

  it("names every op in the closed list", () => {
    expect(writesInWords([{ op: "set_due" }])).toBe("sets a date");
    expect(writesInWords([{ op: "set_recurrence" }])).toBe("makes it repeat");
    expect(writesInWords([{ op: "set_blocked_reason" }])).toBe("records why it is stuck");
    expect(writesInWords([{ op: "remember_fact" }])).toBe("remembers a fact");
    expect(writesInWords([{ op: "clear_expectation" }])).toBe("clears a follow-up");
  });

  it("joins several writes as one sentence", () => {
    expect(
      writesInWords([
        { op: "complete_task" },
        { op: "complete_task" },
        { op: "complete_task" },
        { op: "remember_fact" },
        { op: "resolve" },
      ])
    ).toBe("marks 3 tasks done and remembers a fact");
    expect(
      writesInWords([{ op: "drop_task" }, { op: "set_due" }, { op: "clear_expectation" }])
    ).toBe("drops 1 task, sets a date and clears a follow-up");
  });

  it("resolve alone leaves everything as it is", () => {
    expect(writesInWords([{ op: "resolve" }])).toBe("leaves everything as it is");
    expect(writesInWords([])).toBe("leaves everything as it is");
  });
});

describe("what an answer did write", () => {
  it("says Closed only for what was applied", () => {
    expect(
      appliedInWords([
        { op: "complete_task" },
        { op: "complete_task" },
        { op: "complete_task" },
      ])
    ).toBe("Closed 3 tasks");
    expect(appliedInWords([{ op: "complete_task" }])).toBe("Closed 1 task");
  });

  it("reads as one sentence with a capital", () => {
    expect(appliedInWords([{ op: "drop_task" }, { op: "remember_fact" }])).toBe(
      "Dropped 1 task and remembered a fact"
    );
    expect(appliedInWords([{ op: "set_due" }, { op: "set_recurrence" }, { op: "set_blocked_reason" }])).toBe(
      "Set a date, made it repeat and recorded why it is stuck"
    );
    expect(appliedInWords([{ op: "clear_expectation" }, { op: "clear_expectation" }])).toBe(
      "Cleared 2 follow-ups"
    );
  });

  it("says Nothing changed when nothing was applied", () => {
    expect(appliedInWords([])).toBe("Nothing changed");
    // A server that lists resolve among the applied ops changed nothing the
    // user would call a change.
    expect(appliedInWords([{ op: "resolve" }])).toBe("Nothing changed");
  });

  it("reports the writes that did not go through, with the reason", () => {
    expect(failedInWords([])).toBeNull();
    expect(failedInWords([{ op: "complete_task", error: "task not found" }])).toBe(
      "1 write did not go through: task not found"
    );
    expect(
      failedInWords([
        { op: "complete_task", error: "task not found" },
        { op: "drop_task", error: "task not found" },
      ])
    ).toBe("2 writes did not go through: task not found");
  });
});

describe("the receipt", () => {
  it("is the writes when there is no reply (a tapped pill)", () => {
    expect(receiptInWords({ applied: [{ op: "complete_task" }, { op: "complete_task" }], failed: [] })).toBe(
      "Closed 2 tasks"
    );
    expect(receiptInWords({ applied: [], failed: [] })).toBe("Nothing changed");
  });

  it("says the reply back, and then the writes that went through", () => {
    // Words the model mapped to "Close both": the user is told what was
    // read AND that the tasks were closed (SPEC §10 is about not claiming
    // more; the writes that ran are the confirmation the mockup drew).
    expect(
      receiptInWords({
        applied: [{ op: "complete_task" }, { op: "complete_task" }],
        failed: [],
        reply: "You want both copies closed.",
      })
    ).toBe("Got it. You want both copies closed. Closed 2 tasks.");
    // A reply without its full stop still reads as two sentences.
    expect(
      receiptInWords({ applied: [{ op: "set_due" }], failed: [], reply: "You want it on the 22nd" })
    ).toBe("Got it. You want it on the 22nd. Set a date.");
  });

  it("keeps the reply alone when only a memory, or nothing, was written", () => {
    expect(receiptInWords({ applied: [{ op: "remember_fact" }], failed: [], reply: "Noted." })).toBe(
      "Got it. Noted."
    );
    expect(receiptInWords({ applied: [], failed: [], reply: "You are keeping both." })).toBe(
      "Got it. You are keeping both."
    );
    expect(receiptInWords({ applied: [{ op: "resolve" }], failed: [], reply: "Keeping them." })).toBe(
      "Got it. Keeping them."
    );
  });

  it("names a write that did not go through either way", () => {
    expect(
      receiptInWords({
        applied: [{ op: "complete_task" }],
        failed: [{ op: "complete_task", error: "task not found" }],
        reply: "You want both closed.",
      })
    ).toBe("Got it. You want both closed. Closed 1 task. 1 write did not go through: task not found");
    expect(
      receiptInWords({ applied: [], failed: [{ op: "complete_task", error: "task not found" }] })
    ).toBe("Nothing changed. 1 write did not go through: task not found");
  });
});

describe("dates in words", () => {
  it("turns the binding's due field into days late, digits kept", () => {
    expect(lateInWords("3d overdue")).toBe("3 days late");
    expect(lateInWords("1d overdue")).toBe("1 day late");
    expect(lateInWords("42d overdue")).toBe("42 days late");
  });

  it("returns null for a due field that is not past due", () => {
    expect(lateInWords("today")).toBeNull();
    expect(lateInWords("tomorrow")).toBeNull();
    expect(lateInWords("")).toBeNull();
  });

  it("writes the date line in the user's timezone", () => {
    // 2026-09-22 08:00 in Los Angeles, which is already the 22nd in UTC too.
    const now = new Date("2026-09-22T15:00:00.000Z");
    expect(dateLine(now, "America/Los_Angeles")).toBe("Tuesday, 22 September");
    // 23:30 in Los Angeles on the 22nd is the 23rd in Tokyo.
    const late = new Date("2026-09-23T06:30:00.000Z");
    expect(dateLine(late, "America/Los_Angeles")).toBe("Tuesday, 22 September");
    expect(dateLine(late, "Asia/Tokyo")).toBe("Wednesday, 23 September");
  });

  it("says when the record was last written, or nothing", () => {
    expect(updatedLine(null, "UTC")).toBeNull();
    expect(updatedLine("not a date", "UTC")).toBeNull();
    expect(updatedLine("2026-09-22T14:40:00.000Z", "America/Los_Angeles")).toBe("Updated Tue 7:40 AM");
  });
});
