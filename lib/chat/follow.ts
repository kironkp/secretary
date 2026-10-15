// Whether the chat thread follows the answer as it is written (docs/chat/SPEC.md
// §1, v1.09 r5): on at his send, off for the rest of the turn at his first hand
// on the thread, back on only by the "New reply below" pill or his next send.
// Pure, so the rule can be driven with made-up sequences (tests/chat-follow.
// test.ts): the thread is read and written through two functions. No timers:
// nothing waits for his finger to lift or decides from where he stopped.
//
// 1. toBottom(): his send, his retry, the panel opening, the pill: on, and the
//    bottom in view.
// 2. hands(): a touch, a wheel, a mouse or pen down, a scroll key: off.
// 3. pill(): off, the bottom out of view, and something written below since
//    following stopped.
// 4. A scroll with no input turns it off when it is not the position the page
//    last wrote and leaves him more than NEAR_PX above the bottom (a clamp
//    leaves him at the bottom, so it never counts). keep() checks the same
//    before it writes: that scroll's event can come after the next piece.
// 5. keep(): while on, every piece, round restart and size change puts the
//    bottom in view.

export type ThreadBox = { top: number; height: number; view: number };
export type FollowState = { following: boolean; pill: boolean };

const NEAR_PX = 32;

export function createFollow(opts: { read: () => ThreadBox; write: (top: number) => void; onChange?: (s: FollowState) => void }) {
  let follow = true;
  /** Where the page last put the thread, and how tall its content was then. */
  let written: ThreadBox | null = null;
  /** How tall the content was when following stopped: anything below that is new to him. */
  let seenHeight = 0;
  let told: FollowState = { following: true, pill: false };

  const gapOf = (b: ThreadBox) => Math.max(0, b.height - b.top - b.view);
  const ours = (b: ThreadBox) => written === null || Math.abs(b.top - written.top) <= 1;
  const pillOf = (b: ThreadBox) => !follow && gapOf(b) > 1 && b.height > seenHeight;
  const tell = (b: ThreadBox = opts.read()) => {
    const now = { following: follow, pill: pillOf(b) };
    if (now.following !== told.following || now.pill !== told.pill) {
      told = now;
      opts.onChange?.(now);
    }
  };
  const put = () => {
    const b = opts.read();
    opts.write(Math.max(0, b.height - b.view));
    written = opts.read();
  };
  const stop = (seen: number) => {
    follow = false;
    seenHeight = seen;
  };
  /** Rule 4: moved, not by the page, and left above the bottom. */
  const movedByNoInput = (b: ThreadBox) => !ours(b) && gapOf(b) > NEAR_PX;

  return {
    following: () => follow,
    pill: () => pillOf(opts.read()),
    /** His hand on the thread: off for the rest of the turn. */
    hands() {
      if (!follow) return;
      stop(opts.read().height);
      tell();
    },
    /** A scroll event. */
    scrolled() {
      const b = opts.read();
      if (follow) {
        if (movedByNoInput(b)) stop(written?.height ?? b.height);
        // At the bottom (a clamp, or a scroll within 32 px of it): where the next piece is measured from.
        else written = b;
      }
      tell(b);
    },
    /** A piece came, a round started over, or a size changed. */
    keep() {
      const b = opts.read();
      if (follow) {
        if (movedByNoInput(b)) stop(written?.height ?? b.height);
        else put();
      }
      tell();
    },
    /** His send, his retry, the panel opening, the pill: following on, the bottom in view. */
    toBottom() {
      follow = true;
      put();
      tell();
    },
    /** The page took him elsewhere on purpose (a message found by search): not following. */
    leave() {
      stop(opts.read().height);
      tell();
    },
  };
}
