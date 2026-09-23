// lib/understanding/repair.ts: an id the model copied with a slip of one or
// two characters is mended to the one known id it is that close to; anything
// farther, or close to two ids, is left for the validator to refuse. Pure:
// no database, no model.
import { describe, expect, it } from "vitest";
import type { Bundle } from "@/lib/understanding/types";
import { nearestId, repairIds, repairLine } from "@/lib/understanding/repair";

const T1 = "04718334-6af8-480c-86e2-f2d1a1d00cc4";
const T2 = "c58c2de5-5a5f-40b7-9a2f-885db56dcdc3";
const E1 = "9f0e3c2a-1b2c-4d5e-8f70-1234567890ab";
const M1 = "aaaaaaaa-0000-4000-8000-000000000001";

/** Only the id lists matter to the index; the rest of a Bundle is not read. */
const bundle = {
  tasksOpen: [{ id: T1 }],
  tasksDone: [{ id: T2 }],
  memories: [{ id: M1 }],
  messages: [],
  events: [],
  documents: [],
  expectations: [{ id: E1 }],
} as unknown as Bundle;

describe("nearestId", () => {
  const known = new Set([T1, T2]);
  it("keeps a known id, mends a slip of one or two characters, and refuses more", () => {
    expect(nearestId(T1, known)).toBe(T1);
    // One hex digit wrong (the production slip of 2026-09-23: 86e2 → 89e2).
    expect(nearestId("04718334-6af8-480c-89e2-f2d1a1d00cc4", known)).toBe(T1);
    // Two wrong.
    expect(nearestId("04718334-6af8-480c-89e2-f2d1a1d00cc5", known)).toBe(T1);
    // Three wrong: not a slip.
    expect(nearestId("04718334-6af8-480c-89e2-f2d1a1d00cc6".replace("480c", "481d"), known)).toBeNull();
    // A different length is never a slip.
    expect(nearestId("04718334-6af8-480c-86e2-f2d1a1d00cc", known)).toBeNull();
    // Case does not count as a slip.
    expect(nearestId(T1.toUpperCase(), known)).toBe(T1);
  });

  it("refuses an id that is that close to two known ids", () => {
    const twins = new Set(["abcdefab-0000-4000-8000-000000000001", "abcdefab-0000-4000-8000-000000000002"]);
    expect(nearestId("abcdefab-0000-4000-8000-000000000003", twins)).toBeNull();
  });
});

describe("repairIds", () => {
  it("mends sources by their type and writes by their field, reports each, and leaves the input alone", () => {
    const slipT1 = "04718334-6af8-480c-89e2-f2d1a1d00cc4";
    const slipE1 = "9f0e3c2a-1b2c-4d5e-8f70-1234567890ac";
    const output = {
      record: {
        things: [{ name: "x", state: { text: "t", sources: [{ type: "task", id: slipT1 }], confidence: "high" } }],
        rules: [{ text: "r", sources: [{ type: "memory", id: M1 }], confidence: "high" }],
      },
      questions: [
        {
          question: "q?",
          evidence: [{ type: "expectation", id: slipE1 }, { type: "task", id: T2 }],
          answers: [
            { id: "a", label: "Do it", writes: [{ op: "complete_task", taskId: slipT1 }, { op: "clear_expectation", expectationId: slipE1 }] },
          ],
        },
      ],
    };
    const before = JSON.stringify(output);
    const { output: mended, repairs } = repairIds(output, bundle);
    expect(JSON.stringify(output)).toBe(before);
    const m = mended as typeof output;
    expect(m.record.things[0].state.sources[0].id).toBe(T1);
    expect(m.record.rules[0].sources[0].id).toBe(M1);
    expect(m.questions[0].evidence[0].id).toBe(E1);
    expect(m.questions[0].evidence[1].id).toBe(T2);
    expect(m.questions[0].answers[0].writes[0]).toEqual({ op: "complete_task", taskId: T1 });
    expect(m.questions[0].answers[0].writes[1]).toEqual({ op: "clear_expectation", expectationId: E1 });
    expect(repairs.map(repairLine)).toEqual([
      `record.things[0].state.sources[0].id: task id "${slipT1}" read as "${T1}"`,
      `questions[0].evidence[0].id: expectation id "${slipE1}" read as "${E1}"`,
      `questions[0].answers[0].writes[0].taskId: task id "${slipT1}" read as "${T1}"`,
      `questions[0].answers[0].writes[1].expectationId: expectation id "${slipE1}" read as "${E1}"`,
    ]);
  });

  it("leaves an id it cannot place, and a source of the wrong type, for the validator", () => {
    const output = {
      record: { rules: [{ text: "r", sources: [{ type: "task", id: "not-a-real-task" }, { type: "task", id: M1 }] }] },
    };
    const { output: mended, repairs } = repairIds(output, bundle);
    expect(mended).toEqual(output);
    expect(repairs).toEqual([]);
  });
});
