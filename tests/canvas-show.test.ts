// Auto-open Canvas (SPEC §7.6 auto-open): every canvas tool's SUCCESSFUL
// outcome carries the UI-only uiAction the shell acts on; failures open
// nothing. The painter module is mocked — CI never calls a live model; what's
// under test is the tool envelope, not the paint.
import { describe, expect, it, vi } from "vitest";
import { executeTool } from "@/lib/secretary/tools";

vi.mock("@/lib/canvas/painter", () => ({
  paintCanvas: vi.fn(async () => {}),
  latestSnapshot: vi.fn(async () => ({
    id: "snap-1",
    markup: "<div>ok</div>",
    painting: false,
  })),
}));

const ctx = { userId: "test-canvas-show", timezone: "UTC" };

describe("canvas tool outcomes carry the auto-open action", () => {
  it("paint_canvas brings the canvas into view", async () => {
    const outcome = await executeTool(ctx, "paint_canvas", { brief: "my week" });
    expect(outcome.uiAction).toEqual({ type: "show_canvas" });
    expect((outcome.result as { painting?: boolean }).painting).toBe(true);
    expect(JSON.stringify(outcome.result)).not.toContain("uiAction");
  });

  it("edit_canvas brings the canvas into view", async () => {
    const outcome = await executeTool(ctx, "edit_canvas", { patch: "bigger title" });
    expect(outcome.uiAction).toEqual({ type: "show_canvas" });
    expect((outcome.result as { painting?: boolean }).painting).toBe(true);
  });

  it("a failed edit (no canvas yet) opens nothing", async () => {
    const { latestSnapshot } = await import("@/lib/canvas/painter");
    vi.mocked(latestSnapshot).mockResolvedValueOnce({
      id: "snap-0",
      userId: ctx.userId,
      brief: "",
      markup: "", // no paint yet — edit_canvas must refuse
      composition: null,
      painting: false,
      createdAt: new Date(0),
    });
    const outcome = await executeTool(ctx, "edit_canvas", { patch: "x" });
    expect((outcome.result as { error?: string }).error).toBeTruthy();
    expect(outcome.uiAction).toBeUndefined();
  });
});
