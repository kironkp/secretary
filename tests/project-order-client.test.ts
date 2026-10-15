// v1.11 (docs/projects/SPEC.md §5): the page's side of a drag. The row moves
// at once; the moves are stored one after the other, in the order he made
// them; an answer to the first never puts the list back under the second; a
// failed store puts the list back where it was last stored, says so plainly,
// and drops what was waiting behind it. The network is a fake.
import { describe, expect, it } from "vitest";
import { createMoveQueue, type MoveSave } from "@/lib/projects/move-queue";

type List = string[];
const gate = () => {
  let open!: (v: Awaited<ReturnType<MoveSave>>) => void;
  const p = new Promise<Awaited<ReturnType<MoveSave>>>((r) => (open = r));
  return { p, open };
};
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the drag on the page", () => {
  it("the row moves at once, before the server answers", () => {
    const q = createMoveQueue<List>(["Garden shed", "Kitchen repaint", "Tax paperwork"], () => new Promise(() => {}));
    q.move({ projectId: "tax", name: "Tax paperwork", to: 0 }, ["Tax paperwork", "Garden shed", "Kitchen repaint"]);
    expect(q.state().shown).toEqual(["Tax paperwork", "Garden shed", "Kitchen repaint"]);
  });

  it("two quick drags are stored in order, the second only after the first; the first's answer never puts the list back", async () => {
    const first = gate();
    const sent: string[] = [];
    const seen: List[] = [];
    const q = createMoveQueue<List>(["Garden shed", "Kitchen repaint", "Tax paperwork"], (m) => {
      sent.push(`${m.name} to ${m.to}`);
      return m.name === "Tax paperwork" ? first.p : Promise.resolve({ ok: true });
    }, (s) => seen.push(s.shown));
    q.move({ projectId: "tax", name: "Tax paperwork", to: 0 }, ["Tax paperwork", "Garden shed", "Kitchen repaint"]);
    q.move({ projectId: "kitchen", name: "Kitchen repaint", to: 0 }, ["Kitchen repaint", "Tax paperwork", "Garden shed"]);
    await settle();
    expect(sent).toEqual(["Tax paperwork to 0"]);
    first.open({ ok: true });
    await settle();
    await settle();
    expect(sent).toEqual(["Tax paperwork to 0", "Kitchen repaint to 0"]);
    expect(q.state()).toMatchObject({ shown: ["Kitchen repaint", "Tax paperwork", "Garden shed"], line: null });
    // Once the second drag was drawn, nothing drew the first's list again.
    const second = seen.findIndex((l) => l[0] === "Kitchen repaint");
    expect(seen.slice(second).every((l) => l[0] === "Kitchen repaint")).toBe(true);
  });

  it("a failed store goes back to the order last stored, says so plainly, and drops the drag waiting behind it", async () => {
    const first = gate();
    const sent: string[] = [];
    const q = createMoveQueue<List>(["Garden shed", "Kitchen repaint", "Tax paperwork"], (m) => {
      sent.push(m.name);
      return first.p;
    });
    q.move({ projectId: "tax", name: "Tax paperwork", to: 0 }, ["Tax paperwork", "Garden shed", "Kitchen repaint"]);
    q.move({ projectId: "kitchen", name: "Kitchen repaint", to: 0 }, ["Kitchen repaint", "Tax paperwork", "Garden shed"]);
    first.open({ ok: false, error: "network" });
    await settle();
    await settle();
    expect(q.state()).toEqual({ shown: ["Garden shed", "Kitchen repaint", "Tax paperwork"], line: "Couldn't move Tax paperwork. It's back where it was.", says: null });
    expect(sent).toEqual(["Tax paperwork"]);
  });

  it("after a store that worked, a later failure goes back only as far as that one", async () => {
    let n = 0;
    const q = createMoveQueue<List>(["Garden shed", "Kitchen repaint", "Tax paperwork"], () => Promise.resolve(++n === 1 ? { ok: true } : { ok: false, error: "no" }));
    q.move({ projectId: "tax", name: "Tax paperwork", to: 0 }, ["Tax paperwork", "Garden shed", "Kitchen repaint"]);
    await settle();
    q.move({ projectId: "garden", name: "Garden shed", to: 2 }, ["Tax paperwork", "Kitchen repaint", "Garden shed"]);
    await settle();
    await settle();
    expect(q.state()).toMatchObject({ shown: ["Tax paperwork", "Garden shed", "Kitchen repaint"], line: "Couldn't move Garden shed. It's back where it was." });
  });

  it("a fresh load of the page while a move is being stored does not undo it; once stored, the next load is taken", async () => {
    const first = gate();
    const q = createMoveQueue<List>(["Garden shed", "Kitchen repaint", "Tax paperwork"], () => first.p);
    q.move({ projectId: "tax", name: "Tax paperwork", to: 0 }, ["Tax paperwork", "Garden shed", "Kitchen repaint"]);
    // The page is loaded again (a refresh after another change) and hands over the order it read before the move.
    q.reset(["Garden shed", "Kitchen repaint", "Tax paperwork"]);
    expect(q.state().shown).toEqual(["Tax paperwork", "Garden shed", "Kitchen repaint"]);
    first.open({ ok: true });
    await settle();
    await settle();
    q.reset(["Tax paperwork", "Garden shed", "Kitchen repaint", "New one"]);
    expect(q.state().shown).toEqual(["Tax paperwork", "Garden shed", "Kitchen repaint", "New one"]);
  });

  it("when the server says the card on the Overview stays where he put it, the page says so", async () => {
    const q = createMoveQueue<List>(["Garden shed", "Kitchen repaint"], () => Promise.resolve({ ok: true, says: "Kitchen repaint is at the top of your projects. On the Overview, its card stays where you put it." }));
    q.move({ projectId: "kitchen", name: "Kitchen repaint", to: 0 }, ["Kitchen repaint", "Garden shed"]);
    await settle();
    expect(q.state().says).toMatch(/On the Overview, its card stays where you put it/);
  });
});
