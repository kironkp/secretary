// Canvas continuity (SPEC §7.6): a model operation must never take the user's
// canvas away from them. Before this, every paint inserted a row with EMPTY
// markup and streamed into it, so the iframe rendered blank and rebuilt
// top-down — the "restarting from scratch" the user was watching. And on voice
// there was no edit tool at all, so a spoken "add one thing" could only paint a
// brand-new canvas.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { canvasSnapshots, user } from "@/lib/db/schema";
import { paintCanvas } from "@/lib/canvas/painter";
import { VOICE_TOOL_NAMES, openAIVoiceToolDefs } from "@/lib/secretary/tool-schemas";
import { VOICE_MODALITY_RULES } from "@/lib/secretary/persona";

const U = { id: `canvas-cont-${crypto.randomUUID()}`, email: `cc-${crypto.randomUUID()}@test.local` };

const EXISTING =
  '<div style="display:flex;flex-direction:column;gap:16px">' +
  '<div style="font-size:30px;font-weight:700">Caltrans — this week</div>' +
  '<div data-check="11111111-1111-4111-8111-111111111111">ADM-2011 signature packet</div>' +
  "</div>";

async function snapshots() {
  return db
    .select()
    .from(canvasSnapshots)
    .where(eq(canvasSnapshots.userId, U.id))
    .orderBy(desc(canvasSnapshots.createdAt));
}

beforeAll(async () => {
  await db.insert(user).values({ id: U.id, name: "Canvas Tester", email: U.email });
});
afterAll(async () => {
  await db.delete(canvasSnapshots).where(eq(canvasSnapshots.userId, U.id));
  await db.delete(user).where(eq(user.id, U.id));
});

describe("the canvas never blanks while a model call is in flight", () => {
  it("an edit keeps the existing canvas on screen for the whole generation", async () => {
    const [seed] = await db
      .insert(canvasSnapshots)
      .values({ userId: U.id, brief: "week", markup: EXISTING, painting: false })
      .returning();
    expect(seed.markup).toBe(EXISTING);

    let midFlight = "";
    const stream = async function* () {
      // Halfway through, whatever the shell would fetch must still be the old
      // canvas — not an empty document and not a half-built one.
      yield "<div>par";
      const [row] = await snapshots();
      midFlight = row.markup;
      yield '<div style="display:flex"><div style="font-size:30px">Caltrans — revised</div>' +
        '<div data-check="11111111-1111-4111-8111-111111111111">ADM-2011 signature packet</div>' +
        "<div>Telework Agreement — revise and resubmit</div></div>";
    };

    const out = await paintCanvas(U.id, "add the telework task", {
      baseMarkup: EXISTING,
      stream: stream as never,
    });

    expect(midFlight).toBe(EXISTING);
    expect(out.markup).toContain("Telework Agreement");
    const [latest] = await snapshots();
    expect(latest.painting).toBe(false);
    expect(latest.markup).toContain("Telework Agreement");
  });

  it("a fresh paint shows the previous canvas until the new one is substantial", async () => {
    const stub = "<div>Loading";
    let afterStub = "";
    const big =
      '<div style="display:flex;flex-direction:column">' +
      "<div>".repeat(60) +
      "Caltrans rebuilt" +
      "</div>".repeat(60) +
      "</div>";

    const stream = async function* () {
      yield stub;
      const [row] = await snapshots();
      afterStub = row.markup;
      yield big;
    };

    await paintCanvas(U.id, "paint my week", { stream: stream as never });

    // The stub is far under the replace threshold, so the old canvas held.
    expect(afterStub).not.toBe("");
    expect(afterStub).toContain("Caltrans");
    const [latest] = await snapshots();
    expect(latest.markup).toContain("Caltrans rebuilt");
  });

  it("an aborted stream never commits the half-built canvas it had so far", async () => {
    const before = (await snapshots())[0].markup;
    const stream = async function* () {
      // A substantial partial — long enough to pass every length gate — then
      // the stream dies. Committing this would replace a complete canvas with
      // half of one, which is exactly the teardown being designed out.
      yield '<div style="display:flex"><div>Half a canvas' + "<div>".repeat(80);
      throw new Error("stream aborted");
    };
    await expect(paintCanvas(U.id, "half it", { stream: stream as never })).rejects.toThrow();

    const [latest] = await snapshots();
    expect(latest.markup).toBe(before);
    expect(latest.markup).not.toContain("Half a canvas");
    expect(latest.painting).toBe(false);
  });

  it("a failed generation leaves the canvas alone rather than clearing it", async () => {
    const before = (await snapshots())[0].markup;
    const stream = async function* () {
      yield "";
      throw new Error("model exploded");
    };
    await expect(
      paintCanvas(U.id, "break it", { stream: stream as never })
    ).rejects.toThrow();

    const [latest] = await snapshots();
    expect(latest.painting).toBe(false);
    expect(latest.markup).toBe(before);
    expect(latest.markup).not.toBe("");
  });
});

describe("voice can edit the canvas it is looking at", () => {
  it("edit_canvas is in the voice session's tools", () => {
    expect(VOICE_TOOL_NAMES).toContain("edit_canvas");
    expect(openAIVoiceToolDefs().map((t) => t.name)).toContain("edit_canvas");
  });

  it("the voice rules route modifications to edit_canvas, not a repaint", () => {
    // The old wording told the model to call paint_canvas for anything visual,
    // which trained exactly the from-scratch behaviour being fixed here.
    expect(VOICE_MODALITY_RULES).toMatch(/CHANGING WHAT'S ON SCREEN IS edit_canvas/);
    expect(VOICE_MODALITY_RULES).toMatch(/add one more thing/i);
    expect(VOICE_MODALITY_RULES).toMatch(/when in doubt and a canvas exists: edit/i);
  });

  it("the tool descriptions tell the model which one to reach for", () => {
    const defs = openAIVoiceToolDefs();
    const edit = defs.find((t) => t.name === "edit_canvas");
    const paint = defs.find((t) => t.name === "paint_canvas");
    expect(edit?.description).toMatch(/THE DEFAULT/);
    expect(edit?.description).toMatch(/add one more thing/i);
    expect(paint?.description).toMatch(/use edit_canvas instead/i);
  });
});
