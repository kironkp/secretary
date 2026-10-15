// Whether the chat thread follows the answer as it is written (docs/chat/SPEC.md
// §1, v1.09 r4): only his hands stop it. Pure, so the rule can be driven with
// made-up event sequences (tests/chat-follow.test.ts): the thread is read and
// written through two functions, and time passes through two timer functions.
//
// 1. His hands pause it at once (a touch or a pointer down, a wheel, a scroll
//    key), and nothing writes the position while they are on it or until it
//    settles.
// 2. Settled (no scroll event for SETTLE_MS after his last input, or the
//    browser's scrollend once his input has moved the thread), it decides
//    once, by where his scroll left him: within NEAR_PX of the bottom as it
//    stood when his input began, on; otherwise off. What is written below him
//    after that is not his scroll (a browser takes a wheel to the bottom as it
//    was when the wheel came, though a piece lands before the scroll does).
//    And a scroll down that stopped exactly at an end the thread had a moment
//    ago is at the bottom: a browser stops a scroll at the end it last drew,
//    which can be a piece behind the page.
// 3. While following, keep() puts the bottom in view, at once.
// 4. A scroll with no input counts as his (following off) only when it leaves
//    him above the bottom, is not what the page last wrote, and neither height
//    changed since the page last followed. A clamp changes one, so never counts.
//    keep() checks the same before it writes: that scroll's event may not have
//    come yet.
// 5. Each send of his turns it on.

export type ThreadBox = { top: number; height: number; view: number };

const SETTLE_MS = 150;
const NEAR_PX = 32;
const RECENT_HEIGHTS = 4;

export function createFollow(opts: {
  read: () => ThreadBox;
  write: (top: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}) {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let follow = true;
  /** A touch or a pointer is down on the thread. */
  let handsDown = false;
  /** His input came; the thread has not settled since. */
  let settling = false;
  let timer: unknown = null;
  /** How tall the content was when his input began. */
  let startHeight = 0;
  /** A scroll event since his input began that was not the page's own write. */
  let moved = false;
  /** Where the thread stood when his input began. */
  let startTop = 0;
  /** The last few content heights the thread has had. */
  const heights: number[] = [];
  const saw = (b: ThreadBox) => {
    if (heights[heights.length - 1] === b.height) return;
    heights.push(b.height);
    if (heights.length > RECENT_HEIGHTS) heights.shift();
  };
  /** Where the page last put the thread, and its sizes then. */
  let written: ThreadBox | null = null;

  const gapOf = (b: ThreadBox) => Math.max(0, b.height - b.top - b.view);
  /** Above the bottom as it stood when his input began (or as it stands, if the content has since grown shorter). */
  const hisGap = (b: ThreadBox) => Math.max(0, Math.min(startHeight, b.height) - b.top - b.view);
  const ours = (b: ThreadBox) => written !== null && Math.abs(b.top - written.top) <= 1;
  const put = () => {
    const b = opts.read();
    opts.write(Math.max(0, b.height - b.view));
    written = opts.read();
  };
  /** Rule 4: moved, not by the page, with nothing resized since it last followed, and left above the bottom. */
  const movedByNoInput = (b: ThreadBox) =>
    written !== null &&
    !ours(b) &&
    b.height === written.height &&
    b.view === written.view &&
    gapOf(b) > NEAR_PX;
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const decide = () => {
    timer = null;
    settling = false;
    if (handsDown) return;
    const b = opts.read();
    const atAnEnd = b.top > startTop + 1 && heights.some((h) => Math.abs(b.top + b.view - h) <= 1);
    follow = hisGap(b) <= NEAR_PX || atAnEnd;
    if (follow) put();
  };
  const settleLater = () => {
    cancel();
    timer = setTimer(decide, SETTLE_MS);
  };
  /** His input: the start of a gesture, unless one is still settling. */
  const begin = () => {
    if (!settling) {
      const b = opts.read();
      saw(b);
      startHeight = b.height;
      startTop = b.top;
      moved = false;
    }
    settling = true;
  };

  return {
    /** Whether a piece now would be followed. */
    following: () => follow && !handsDown && !settling,
    /** A wheel or a scroll key: his input, all at once. */
    nudge() {
      begin();
      settleLater();
    },
    /** A touch or a pointer down on the thread. */
    down() {
      begin();
      handsDown = true;
      cancel();
    },
    /** The touch or the pointer lifted (or was cancelled): it settles from here, momentum included. */
    up() {
      if (!handsDown) return;
      handsDown = false;
      settleLater();
    },
    /** A scroll event. */
    scrolled() {
      const b = opts.read();
      saw(b);
      if (handsDown || settling) {
        // His scroll, or its momentum: not settled yet. (The event of a write the page made before his input can
        // come after it: that one has not moved anything of his.)
        if (!ours(b)) moved = true;
        if (!handsDown) settleLater();
        return;
      }
      if (movedByNoInput(b)) follow = false;
    },
    /** The browser says a scroll ended: settled now, if it was his. */
    scrollEnded() {
      if (!settling || handsDown || !moved) return;
      cancel();
      decide();
    },
    /** A piece came, a round started over, or a size changed: while following, the bottom in view. */
    keep() {
      const b = opts.read();
      saw(b);
      if (!follow || handsDown || settling) return;
      if (movedByNoInput(b)) {
        follow = false;
        return;
      }
      put();
    },
    /** His send, or the conversation opened: following on, the bottom in view. */
    toBottom() {
      cancel();
      settling = false;
      handsDown = false;
      follow = true;
      put();
    },
    /** The page took him elsewhere on purpose (a message found by search): not following. */
    leave() {
      follow = false;
    },
    /** The thread is gone: no settle left pending. */
    dispose: cancel,
  };
}
