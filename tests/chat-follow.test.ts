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

describe("on a call, a new line of his is a send (v1.09 r6)", () => {
  type Line = { role: "user" | "assistant"; text: string };
  /** A call's thread: each line said (or grown as it is heard) is drawn, then the page looks at the transcript (the
   *  layout effect), then the size change keeps the bottom in view while following. */
  function call(t: ReturnType<typeof thread>) {
    const lines: Line[] = [];
    const look = () => t.f.heard(lines.map((l) => ({ ...l })));
    look(); // the thread drawn before the call: nothing said yet
    return {
      lines,
      say(role: Line["role"], text: string, px = 40) {
        lines.push({ role, text });
        t.box.height += px;
        look();
        t.f.keep();
      },
      grow(text: string, px = 40) {
        lines[lines.length - 1].text += text;
        t.box.height += px;
        look();
        t.f.keep();
      },
      look,
    };
  }

  it("a hand during one spoken answer: the next question and its answer are followed", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom(); // the panel opened on the call
    const c = call(t);
    c.say("user", "First question");
    c.say("assistant", "Point 1. ");
    expect(t.box.top).toBe(t.end());
    t.f.hands(); // a wheel during the first answer
    t.box.top = 300;
    t.f.scrolled();
    c.grow("Point 2. ");
    c.grow("Point 3. ");
    expect(t.f.following()).toBe(false);
    expect(t.box.top, "left where his hand put him").toBe(300);
    c.say("user", "Second question");
    expect(t.f.following(), "his spoken question is a send").toBe(true);
    expect(t.box.top).toBe(t.end());
    c.say("assistant", "Point 1. ");
    c.grow("Point 2. ");
    expect(t.box.top).toBe(t.end());
    expect(t.f.pill()).toBe(false);
  });

  it("only his new lines are sends: the secretary's lines, and his line growing as it is heard, are not", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    const c = call(t);
    c.say("user", "A question");
    t.f.hands();
    const writes = t.writes.length;
    c.grow(" heard a little more");
    c.say("assistant", "An answer. ");
    c.grow("More of it. ");
    c.say("assistant", "   "); // a line with nothing in it yet
    expect(t.f.following()).toBe(false);
    expect(t.writes.length).toBe(writes);
  });

  it("the first look only counts: a thread opened during a call is not moved by what was already said; a new call counts from none", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.f.hands();
    t.box.top = 200;
    t.f.scrolled();
    // Opened during a call: two lines of his already there.
    t.f.heard([
      { role: "user", text: "Earlier" },
      { role: "assistant", text: "Said" },
      { role: "user", text: "Earlier again" },
    ]);
    expect(t.f.following()).toBe(false);
    expect(t.box.top).toBe(200);
    // The call ends (no lines), and a new one starts: his first line is a send.
    t.f.heard([]);
    expect(t.f.following()).toBe(false);
    t.f.heard([{ role: "user", text: "A new call" }]);
    expect(t.f.following()).toBe(true);
    expect(t.box.top).toBe(t.end());
  });

  it("the end of a call (the saved messages in place of the spoken lines) puts the bottom in view, following", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.toBottom();
    t.f.hands();
    t.box.top = 100;
    t.f.scrolled();
    t.box.height = 1100; // the saved messages drawn
    t.f.toBottom();
    expect(t.f.following()).toBe(true);
    expect(t.box.top).toBe(t.end());
  });
});
