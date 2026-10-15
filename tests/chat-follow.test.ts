// v1.09 r5 (docs/chat/SPEC.md §1): the follow rule as a small state machine,
// on made-up sequences. On at his send; off for the rest of the turn at his
// first hand on the thread; the "New reply below" pill, or his next send,
// turns it back on; a scroll with no input turns it off when it is not the
// page's write and leaves him more than 32 px above the bottom. The thread is
// a box (where it stands, how tall its content is, how tall the view is); the
// page's writes move it.
import { describe, expect, it } from "vitest";
import { createFollow, type FollowState } from "@/lib/chat/follow";

function thread(start: { top: number; height: number; view: number }) {
  const box = { ...start };
  const writes: number[] = [];
  const told: FollowState[] = [];
  const f = createFollow({
    read: () => ({ ...box }),
    write: (top) => {
      box.top = top;
      writes.push(top);
    },
    onChange: (s) => told.push(s),
  });
  const end = () => Math.max(0, box.height - box.view);
  /** A piece of the answer: the content grows, and the page asks to keep the bottom in view. */
  const piece = (px = 40) => {
    box.height += px;
    f.keep();
  };
  return { f, box, writes, told, end, piece };
}

describe("on, off, and the pill", () => {
  it("on at his send: every piece puts the bottom in view at once", () => {
    const t = thread({ top: 0, height: 400, view: 500 });
    t.f.toBottom();
    t.piece(200);
    expect(t.box.top).toBe(t.end());
    t.piece();
    expect(t.box.top).toBe(t.end());
    expect(t.f.following()).toBe(true);
    expect(t.f.pill()).toBe(false);
  });

  it("his first hand turns it off for the rest of the turn: nothing is written, wherever he goes, even back to the bottom", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.f.hands();
    t.box.top = 380; // he scrolled up
    t.f.scrolled();
    const writes = t.writes.length;
    t.piece();
    t.piece();
    expect(t.writes.length).toBe(writes);
    t.box.top = t.end(); // he scrolled back to the bottom himself
    t.f.scrolled();
    t.piece();
    expect(t.writes.length, "still off: one way").toBe(writes);
    expect(t.f.following()).toBe(false);
  });

  it("a hand while it is already off changes nothing (no lift is waited for, nothing is decided later)", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.f.hands();
    t.f.hands();
    t.f.hands();
    t.piece();
    expect(t.f.following()).toBe(false);
    expect(t.writes.length).toBe(1);
  });

  it("the pill: only while off, the bottom out of view, and something written below since it stopped", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    expect(t.f.pill(), "following: no pill").toBe(false);
    t.f.hands();
    expect(t.f.pill(), "off, at the bottom, nothing new").toBe(false);
    t.piece(46);
    expect(t.f.pill(), "a piece below him").toBe(true);
    t.box.top = t.end();
    t.f.scrolled();
    expect(t.f.pill(), "he scrolled to the bottom himself: in view").toBe(false);
    t.piece(46);
    expect(t.f.pill(), "another piece below").toBe(true);
    expect(t.told.at(-1)).toEqual({ following: false, pill: true });
  });

  it("off with nothing new below (he scrolled up in what was already there): no pill", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.f.hands();
    t.box.top = 100;
    t.f.scrolled();
    expect(t.f.pill()).toBe(false);
  });

  it("the pill turns it back on and puts the bottom in view; the next pieces are followed", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.f.hands();
    t.box.top = 200;
    t.f.scrolled();
    t.piece();
    expect(t.f.pill()).toBe(true);
    t.f.toBottom(); // the pill
    expect(t.box.top).toBe(t.end());
    expect(t.f.following()).toBe(true);
    expect(t.f.pill()).toBe(false);
    t.piece();
    expect(t.box.top).toBe(t.end());
    expect(t.told.at(-1)).toEqual({ following: true, pill: false });
  });

  it("his next send turns it on too", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.f.hands();
    t.f.toBottom(); // his send
    t.piece();
    expect(t.box.top).toBe(t.end());
  });

  it("a jump to a message found by search turns it off, with no pill until something new is written", () => {
    const t = thread({ top: 500, height: 1000, view: 500 });
    t.f.toBottom();
    t.f.leave();
    t.box.top = 100;
    t.f.scrolled();
    expect(t.f.pill()).toBe(false);
    t.piece();
    expect(t.f.following()).toBe(false);
    expect(t.f.pill()).toBe(true);
  });
});

describe("a scroll with no input (rule 4)", () => {
  it("not the page's write, more than 32 px above the bottom: off", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.box.top = 300; // VoiceOver, say
    t.f.scrolled();
    expect(t.f.following()).toBe(false);
    t.piece();
    expect(t.box.top).toBe(300);
  });

  it("its event comes after the next piece: the piece does not put him back (the race r4 lost: no height condition)", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.piece(); // followed: the page wrote 540
    t.box.top = 300; // a scroll with no input; its event has not come yet
    t.piece(46); // the next piece: the content grew, and the page is asked to keep the bottom in view
    expect(t.box.top, "not written over").toBe(300);
    expect(t.f.following()).toBe(false);
    t.f.scrolled(); // its event, late
    expect(t.f.following()).toBe(false);
  });

  it("a clamp (the view grew taller) leaves him at the bottom: still on", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.box.view = 800;
    t.box.top = 200; // the browser pulled it down to what the content allows
    t.f.scrolled();
    expect(t.f.following()).toBe(true);
    t.piece();
    expect(t.box.top).toBe(t.end());
  });

  it("a round that starts over shorter (the content shrank, the position pulled down to fit): still on", () => {
    const t = thread({ top: 0, height: 1400, view: 500 });
    t.f.toBottom();
    t.box.height = 800;
    t.box.top = 300;
    t.f.keep(); // the round restart, before its scroll event
    expect(t.f.following()).toBe(true);
    t.f.scrolled();
    expect(t.f.following()).toBe(true);
    t.piece();
    expect(t.box.top).toBe(t.end());
  });

  it("the event of the page's own write is not his, nor a scroll that stays within 32 px of the bottom", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.f.scrolled();
    expect(t.f.following()).toBe(true);
    t.box.top = t.end() - 20;
    t.f.scrolled();
    expect(t.f.following()).toBe(true);
  });

  it("the keyboard (the view grows shorter): the position is the page's, so the bottom is put back in view", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.box.view = 320;
    t.f.keep(); // the size change
    expect(t.f.following()).toBe(true);
    expect(t.box.top).toBe(t.end());
  });
});
