// v1.09 r5 (docs/chat/SPEC.md §1): the follow rule as a small state machine,
// on made-up sequences. On at his send; off for the rest of the turn at his
// first hand on the thread; the "New reply below" pill, or his next send,
// turns it back on; a scroll with no input turns it off when it is not the
// page's write and leaves him more than 32 px above the bottom. The thread is
// a box (where it stands, how tall its content is, how tall the view is); the
// page's writes move it. r6: on a call, a new line of his is a send.
import { describe, expect, it } from "vitest";
import { createFollow, type FollowState } from "@/lib/chat/follow";

function thread(start: { top: number; height: number; view: number }) {
  const box = { ...start };
  const writes: number[] = [];
  const told: FollowState[] = [];
  const notes: string[] = [];
  const f = createFollow({
    read: () => ({ ...box }),
    write: (top) => {
      box.top = top;
      writes.push(top);
    },
    onChange: (s) => told.push(s),
    note: (line) => notes.push(line),
  });
  const end = () => Math.max(0, box.height - box.view);
  /** A piece of the answer: the content grows, and the page asks to keep the bottom in view. */
  const piece = (px = 40) => {
    box.height += px;
    f.keep();
  };
  return { f, box, writes, told, notes, end, piece };
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
    t.f.sent(); // his send
    expect(t.f.following()).toBe(true);
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

  it("the panel growing pulls the position down to the old bottom in the same read as a new piece (Chromium, logged): still on", () => {
    // Logged at the start of a turn, 3 of 30: the page wrote 95 (content 261, view 166); then, in one read, the view
    // was 249, the browser had pulled the position to 12 (261 - 249), and a piece had made the content 318: 57 px
    // above the bottom, at a position the page did not write. Not his scroll.
    const t = thread({ top: 95, height: 261, view: 166 });
    t.f.toBottom();
    t.box.view = 249;
    t.box.top = 12;
    t.box.height = 318;
    t.f.keep();
    expect(t.f.following()).toBe(true);
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

describe("on a call, a new line of his is a send, judged from when his turn began (v1.09 r6)", () => {
  type Line = { itemId: string; role: "user" | "assistant"; text: string };
  /** A call's thread. began(): his speech committed (the mark). say(): a line drawn, then the page looks at the
   *  transcript (the layout effect), then the size change keeps the bottom in view while following. */
  function call(t: ReturnType<typeof thread>) {
    const lines: Line[] = [];
    const look = () => t.f.heard(lines.map((l) => ({ ...l })));
    const draw = (px: number) => {
      t.box.height += px;
      look();
      t.f.keep();
    };
    look(); // the thread drawn before the call: nothing said yet
    return {
      began: (itemId: string) => t.f.began(itemId),
      say(itemId: string, role: Line["role"], text: string, px = 40) {
        lines.push({ itemId, role, text });
        draw(px);
      },
      grow(itemId: string, text: string, px = 40) {
        lines.find((l) => l.itemId === itemId)!.text += text;
        draw(px);
      },
    };
  }
  /** His hand: a wheel up to 300. */
  const hand = (t: ReturnType<typeof thread>, top = 300) => {
    t.f.hands();
    t.box.top = top;
    t.f.scrolled();
  };

  it("his line before the answer, a hand during the answer: his next spoken question and its answer are followed", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom(); // the panel opened on the call
    const c = call(t);
    c.began("u1");
    c.say("u1", "user", "First question");
    c.say("a1", "assistant", "Point 1. ");
    expect(t.box.top).toBe(t.end());
    hand(t);
    c.grow("a1", "Point 2. ");
    expect(t.f.following()).toBe(false);
    expect(t.box.top, "left where his hand put him").toBe(300);
    c.began("u2");
    c.say("u2", "user", "Second question");
    expect(t.f.following(), "his spoken question is a send").toBe(true);
    expect(t.box.top).toBe(t.end());
    c.say("a2", "assistant", "Point 1. ");
    c.grow("a2", "Point 2. ");
    expect(t.box.top).toBe(t.end());
    expect(t.f.pill()).toBe(false);
  });

  it("his line transcribed after the answer's first pieces, with his hand in between: off, and not moved (the Reviewer's probe)", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    const c = call(t);
    c.began("u1");
    c.say("a1", "assistant", "Point 1. "); // the answer begins before his line's words
    c.grow("a1", "Point 2. ");
    expect(t.box.top, "followed").toBe(t.end());
    hand(t);
    c.grow("a1", "Point 3. ");
    c.say("u1", "user", "His question, late");
    expect(t.f.following()).toBe(false);
    expect(t.box.top, "not pulled down").toBe(300);
    c.grow("a1", "Point 4. ");
    expect(t.box.top).toBe(300);
  });

  it("the same with no hand since his turn began: followed (a hand before it, in the answer before, does not count)", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    const c = call(t);
    c.say("a0", "assistant", "An earlier answer. ");
    hand(t); // off during the answer before
    c.began("u1");
    c.say("a1", "assistant", "Point 1. ");
    c.grow("a1", "Point 2. ");
    expect(t.f.following(), "not yet: his words have not come").toBe(false);
    c.say("u1", "user", "His question, late");
    expect(t.f.following()).toBe(true);
    expect(t.box.top).toBe(t.end());
    c.grow("a1", "Point 3. ");
    expect(t.box.top).toBe(t.end());
  });

  it("a hand while already off counts too: his turn began, then a second hand, then his words: stays off", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    const c = call(t);
    hand(t, 300);
    c.began("u1");
    hand(t, 250);
    c.say("u1", "user", "His question");
    expect(t.f.following()).toBe(false);
    expect(t.box.top).toBe(250);
  });

  it("an empty or noise line of his is never a send (the Reviewer's eighth broken version)", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    const c = call(t);
    hand(t);
    c.began("u1");
    c.say("u1", "user", "");
    c.began("u2");
    c.say("u2", "user", "  …  ");
    c.began("u3");
    c.say("u3", "user", "- . ?");
    expect(t.f.following()).toBe(false);
    expect(t.box.top).toBe(300);
    c.grow("u1", "Wait");
    expect(t.f.following(), "his words came after all: a send, judged from his turn's mark").toBe(true);
  });

  it("only his lines, each once: the secretary's lines and his line growing as it is heard are not sends", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    const c = call(t);
    c.began("u1");
    c.say("u1", "user", "A question");
    hand(t);
    const writes = t.writes.length;
    c.grow("u1", " heard a little more");
    c.say("a1", "assistant", "An answer. ");
    c.grow("a1", "More of it. ");
    expect(t.f.following()).toBe(false);
    expect(t.writes.length).toBe(writes);
  });

  it("a line of his whose turn was never marked is a send (a real stream always marks first), noted once a call", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    const c = call(t);
    hand(t);
    c.say("u1", "user", "No mark for this one");
    expect(t.f.following()).toBe(true);
    expect(t.box.top).toBe(t.end());
    hand(t);
    c.say("u2", "user", "Nor this one");
    expect(t.f.following()).toBe(true);
    expect(t.notes.length, "noted once this call").toBe(1);
    expect(t.notes[0]).toContain("u1");
    // The call ends (no lines); the next one notes it again.
    t.f.heard([]);
    t.f.heard([{ itemId: "v1", role: "user", text: "A new call, no mark" }]);
    expect(t.notes.length).toBe(2);
  });

  it("the lines already there at the first look are not sends: a thread opened during a call is not moved by what was said", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.f.hands();
    t.box.top = 200;
    t.f.scrolled();
    t.f.heard([
      { itemId: "u1", role: "user", text: "Earlier" },
      { itemId: "a1", role: "assistant", text: "Said" },
      { itemId: "u2", role: "user", text: "Earlier again" },
    ]);
    expect(t.f.following()).toBe(false);
    expect(t.box.top).toBe(200);
    expect(t.notes.length).toBe(0);
  });

  it("two turns quickly (the Reviewer's shape): his first line, heard after his hand, is not a send; his second, begun after it, is", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    const c = call(t);
    c.began("u2");
    c.say("a2", "assistant", "Point 1. ");
    hand(t);
    c.grow("a2", "Point 2. ");
    c.began("u3");
    c.say("u2", "user", "The first, late");
    expect(t.f.following(), "u2: a hand since its mark").toBe(false);
    expect(t.box.top).toBe(300);
    c.say("u3", "user", "The second");
    expect(t.f.following(), "u3: begun after his hand").toBe(true);
    expect(t.box.top).toBe(t.end());
  });

  it("the first mark stands: his item added after his speech was committed does not move the mark past a hand", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    const c = call(t);
    c.began("u1"); // committed
    hand(t);
    c.began("u1"); // the item added, later
    c.say("u1", "user", "His question");
    expect(t.f.following()).toBe(false);
  });

  it("a scroll with no input that stops following (rule 4) counts as his hand", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    const c = call(t);
    c.began("u1");
    t.box.top = 300; // VoiceOver, say
    t.f.scrolled();
    c.say("u1", "user", "His question");
    expect(t.f.following()).toBe(false);
    expect(t.box.top).toBe(300);
  });

  it("the end of a call (the saved messages in place of the spoken lines) puts the bottom in view, following", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    hand(t, 100);
    t.box.height = 1100; // the saved messages drawn
    t.f.toBottom();
    expect(t.f.following()).toBe(true);
    expect(t.box.top).toBe(t.end());
  });
});
