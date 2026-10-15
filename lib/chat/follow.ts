// Whether the chat thread follows the answer as it is written (docs/chat/SPEC.md
// §1, v1.09 r5): on at his send, off for the rest of the turn at his first hand
// on the thread, back on only by the "New reply below" pill or his next send.
// Pure, so the rule can be driven with made-up sequences (tests/chat-follow.
// test.ts): the thread is read and written through two functions. No timers:
// nothing waits for his finger to lift or decides from where he stopped.
//
// 1. sent(): his send, typed, retried, or a new line of his on a call (heard()
//    finds those): on, and the bottom in view. toBottom() is the same for the
//    page's own reasons: the panel opening, the pill, the end of a call.
// 2. hands(): a touch, a wheel, a mouse or pen down, a scroll key: off.
// 3. pill(): off, the bottom out of view, and something written below since
//    following stopped.
// 4. A scroll with no input turns it off when it is not the position the page
//    last wrote and leaves him more than NEAR_PX above the bottom as it stood
//    when the page last wrote (what was written since is not his scroll: the
//    panel growing pulls the position down to the old bottom in the same read
//    as a new piece). A clamp leaves him at the bottom, so it never counts.
//    keep() checks the same before it writes: that scroll's event can come
//    after the next piece.
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
  /** How many lines of his a call's transcript held at the last look (null: not looked at yet). */
  let spoken: number | null = null;
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
  /** Rule 4: moved, not by the page, and left above the bottom as it stood at the page's last write (or as it stands, if shorter). */
  const movedByNoInput = (b: ThreadBox) =>
    !ours(b) && Math.max(0, Math.min(written?.height ?? b.height, b.height) - b.top - b.view) > NEAR_PX;
  const toBottom = () => {
    follow = true;
    put();
    tell();
  };
  /** His send: typed, his tap to retry, or a new line of his on a call. The one path for all three. */
  const sent = () => toBottom();

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
    /** The panel opening, the pill, the end of a call: following on, the bottom in view. */
    toBottom,
    sent,
    /** A call's transcript as it stands: a new line of his is a send. The secretary's lines, and his line growing
     *  as it is heard, are not. The first look only counts (a thread opened during a call is not moved by lines
     *  already said); a call that ends, or a new one, starts the count again from none. */
    heard(lines: readonly { role: string; text: string }[]) {
      const his = lines.filter((l) => l.role === "user" && l.text.trim()).length;
      const more = spoken !== null && his > spoken;
      spoken = his;
      if (more) sent();
    },
    /** The page took him elsewhere on purpose (a message found by search): not following. */
    leave() {
      stop(opts.read().height);
      tell();
    },
  };
}
