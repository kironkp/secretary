// v1.09 r4 (docs/chat/SPEC.md §1, "only his hands stop it"): the follow rule
// on made-up event sequences, on a clock of the test's own. The thread is a
// box (where it stands, how tall its content is, how tall the view is); the
// page's writes move it; his input and the browser's scroll events are the
// events. Touch and momentum cannot be driven in a browser test: this is
// where their sequences are.
import { describe, expect, it } from "vitest";
import { createFollow } from "@/lib/chat/follow";

/** A thread and a clock: timers fire only when the test moves time on. */
function thread(start: { top: number; height: number; view: number }) {
  const box = { ...start };
  let now = 0;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  const writes: number[] = [];
  const f = createFollow({
    read: () => ({ ...box }),
    write: (top) => {
      box.top = top;
      writes.push(top);
    },
    setTimer: (fn, ms) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  });
  const tick = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      timers = timers.filter((t) => t !== due);
      due.fn();
    }
    now = until;
  };
  const end = () => Math.max(0, box.height - box.view);
  /** A piece of the answer: the content grows, and the page asks to keep the bottom in view. */
  const piece = (px = 40) => {
    box.height += px;
    f.keep();
  };
  return { f, box, tick, writes, end, piece };
}

describe("following", () => {
  it("while following, every piece puts the bottom in view at once", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.piece();
    expect(t.box.top).toBe(t.end());
    t.piece();
    expect(t.box.top).toBe(t.end());
    expect(t.f.following()).toBe(true);
  });

  it("a wheel pauses it at once; settled 150 ms later above the bottom, it is off for the pieces after", () => {
    const t = thread({ top: 500, height: 1000, view: 500 });
    t.f.keep();
    t.f.nudge();
    t.box.top = 380; // the wheel moved him up 120 px
    t.f.scrolled();
    const before = t.writes.length;
    t.piece();
    expect(t.writes.length, "nothing written while it settles").toBe(before);
    t.tick(149);
    expect(t.f.following()).toBe(false);
    t.tick(1);
    t.piece();
    t.piece();
    expect(t.writes.length, "decided off: nothing written").toBe(before);
    expect(t.box.top).toBe(380);
  });

  it("a wheel that settles within 32 px of the bottom turns it on again, and the next piece is followed", () => {
    const t = thread({ top: 380, height: 1000, view: 500 });
    t.f.nudge();
    t.box.top = 470; // 30 px from the bottom
    t.f.scrolled();
    t.tick(150);
    expect(t.f.following()).toBe(true);
    t.piece();
    expect(t.box.top).toBe(t.end());
  });

  it("a touch: nothing decided while the finger is down, however long; then a momentum tail keeps it unsettled until 150 ms after its last scroll", () => {
    const t = thread({ top: 500, height: 1000, view: 500 });
    t.f.keep();
    t.f.down();
    t.box.top = 300;
    t.f.scrolled();
    t.tick(2000);
    expect(t.f.following()).toBe(false);
    t.f.up();
    // Momentum: a scroll event every 16 ms for 600 ms after the finger lifts, drifting up.
    for (let i = 0; i < 37; i++) {
      t.tick(16);
      t.box.top -= 3;
      t.f.scrolled();
      expect(t.f.following(), `still unsettled at ${i * 16} ms of momentum`).toBe(false);
    }
    const writes = t.writes.length;
    t.piece();
    expect(t.writes.length, "nothing written during momentum").toBe(writes);
    t.tick(150);
    // Settled above the bottom: off; a piece after it is not followed.
    t.piece();
    expect(t.writes.length).toBe(writes);
  });

  it("pieces that come while it settles grow the thread below him: a wheel back to the bottom still turns it on", () => {
    const t = thread({ top: 380, height: 1000, view: 500 });
    t.f.nudge();
    t.box.top = 500; // he reached the bottom
    t.f.scrolled();
    for (let i = 0; i < 4; i++) {
      t.tick(40);
      t.piece(46); // 184 px written below him while it settles, no scroll event
    }
    t.tick(150);
    expect(t.f.following()).toBe(true);
    expect(t.box.top, "and the bottom is put in view at once").toBe(t.end());
  });

  it("the scrollbar dragged with a mouse: paused while the button is down, decided when it is let go and settled", () => {
    const t = thread({ top: 500, height: 1000, view: 500 });
    t.f.keep();
    t.f.down();
    t.box.top = 100;
    t.f.scrolled();
    t.piece();
    t.tick(1000);
    expect(t.box.top, "nothing written while the button is down").toBe(100);
    t.box.top = 520; // dragged back down to the bottom before letting go
    t.f.scrolled();
    t.f.up();
    t.tick(150);
    expect(t.f.following()).toBe(true);
    expect(t.box.top).toBe(t.end());
  });

  it("the browser's scrollend settles it at once", () => {
    const t = thread({ top: 380, height: 1000, view: 500 });
    t.f.nudge();
    t.box.top = 495;
    t.f.scrolled();
    t.f.scrollEnded();
    expect(t.f.following()).toBe(true);
  });

  it("a clamp that lands inside the settle window: still decided by position when it settles", () => {
    const t = thread({ top: 500, height: 1000, view: 500 });
    t.f.keep();
    t.f.nudge(); // a wheel that moves nothing yet
    // The panel grows taller while it settles: the browser pulls the position down to fit.
    t.box.view = 700;
    t.box.top = 300;
    t.f.scrolled();
    t.tick(150);
    expect(t.f.following(), "at the bottom after the clamp: on").toBe(true);
  });

  it("each send of his turns it on, and cancels a settle still pending", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.nudge();
    t.f.scrolled();
    t.tick(150);
    expect(t.f.following()).toBe(false);
    t.f.nudge();
    t.f.toBottom();
    expect(t.f.following()).toBe(true);
    expect(t.box.top, "the send puts the bottom in view").toBe(t.end());
    t.tick(500);
    expect(t.f.following(), "the pending settle does not undo the send").toBe(true);
  });

  it("a jump to a message found by search turns it off", () => {
    const t = thread({ top: 500, height: 1000, view: 500 });
    t.f.leave();
    t.piece();
    expect(t.f.following()).toBe(false);
  });
});

describe("a scroll with no input (rule 4)", () => {
  it("above the bottom, not what the page wrote, no size changed since the last follow: his; following off", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.keep();
    t.box.top = 200; // the indicator dragged, say
    t.f.scrolled();
    expect(t.f.following()).toBe(false);
    t.piece();
    expect(t.box.top).toBe(200);
  });

  it("a clamp (the view grew) is never his: following stays on", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.keep();
    t.box.view = 800;
    t.box.top = 200;
    t.f.scrolled();
    expect(t.f.following()).toBe(true);
  });

  it("content that shrank (a round starting over shorter) is never his either", () => {
    const t = thread({ top: 0, height: 1200, view: 500 });
    t.f.keep();
    t.box.height = 800;
    t.box.top = 300;
    t.f.scrolled();
    expect(t.f.following()).toBe(true);
    t.f.keep();
    expect(t.box.top).toBe(t.end());
  });

  it("a scroll with no input whose event has not come when the next size change is followed: still his, and not written over", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.piece(); // followed: the page wrote 540 at these sizes
    t.box.top = 300; // VoiceOver, say; its scroll event comes a frame later
    t.f.keep(); // the size observer, for the piece just followed: nothing resized since
    expect(t.box.top).toBe(300);
    expect(t.f.following()).toBe(false);
  });

  it("the event of the page's own write is not his, nor a scroll that stays within 32 px of the bottom", () => {
    const t = thread({ top: 0, height: 1000, view: 500 });
    t.f.keep();
    t.f.scrolled();
    expect(t.f.following()).toBe(true);
    t.box.top = t.end() - 20;
    t.f.scrolled();
    expect(t.f.following()).toBe(true);
  });
});
