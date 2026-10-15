// Whether the chat thread follows the answer as it is written (docs/chat/SPEC.md
// §1, v1.09 r5): on at his send, off for the rest of the turn at his first hand
// on the thread, back on only by the "New reply below" pill or his next send.
// Pure, so the rule can be driven with made-up sequences (tests/chat-follow.
// test.ts): the thread is read and written through two functions. No timers:
// nothing waits for his finger to lift or decides from where he stopped.
//
// 1. sent(): his send, typed, retried, or a new line of his on a call (heard()
//    finds those): on, and the bottom in view. toBottom() is the same for the
//    page's own reasons: the panel opening, the pill, the end of a call. On a
//    call his line's words can come after the answer has begun, so the line is
//    judged from when his turn began (began(), at his speech committed): a send
//    only if no hand of his has come since. A line whose turn was never marked
//    is a send (a real stream always marks first; noted once a call, so a
//    renamed event shows), except the lines already there at the first look.
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
/** A line with words in it: a letter or a digit (an empty or noise transcript has none). */
const WORDS = /[\p{L}\p{N}]/u;

export function createFollow(opts: {
  read: () => ThreadBox;
  write: (top: number) => void;
  onChange?: (s: FollowState) => void;
  /** A line for the log. */
  note?: (line: string) => void;
}) {
  let follow = true;
  /** Where the page last put the thread, and how tall its content was then. */
  let written: ThreadBox | null = null;
  /** How tall the content was when following stopped: anything below that is new to him. */
  let seenHeight = 0;
  /** His hands on the thread so far, and his scrolls with no input that stopped following (rule 4). */
  let handsSoFar = 0;
  /** On a call: for each turn of his that began, how many hands there had been when it began. */
  const marks = new Map<string, number>();
  /** His lines on a call already judged (each once, when it first has words). */
  const judged = new Set<string>();
  /** Whether the transcript has been looked at yet (the lines there at the first look are not sends). */
  let looked = false;
  /** Whether this call has noted a line of his with no mark. */
  let notedUnmarked = false;
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
  /** Rule 4 stopped following: counted as his hand. */
  const stopNoInput = (seen: number) => {
    handsSoFar++;
    stop(seen);
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
      handsSoFar++;
      if (!follow) return;
      stop(opts.read().height);
      tell();
    },
    /** A scroll event. */
    scrolled() {
      const b = opts.read();
      if (follow) {
        if (movedByNoInput(b)) stopNoInput(written?.height ?? b.height);
        // At the bottom (a clamp, or a scroll within 32 px of it): where the next piece is measured from.
        else written = b;
      }
      tell(b);
    },
    /** A piece came, a round started over, or a size changed. */
    keep() {
      const b = opts.read();
      if (follow) {
        if (movedByNoInput(b)) stopNoInput(written?.height ?? b.height);
        else put();
      }
      tell();
    },
    /** The panel opening, the pill, the end of a call: following on, the bottom in view. */
    toBottom,
    sent,
    /** On a call, his turn began (his speech committed as an item): marked, nothing moved. The first mark stands. */
    began(itemId: string) {
      if (!marks.has(itemId) && !judged.has(itemId)) marks.set(itemId, handsSoFar);
    },
    /** A call's transcript as it stands. A line of his is judged once, when it first has words: a send if no hand
     *  has come since its turn's mark, or if its turn was never marked. A hand since leaves following as it is. Not
     *  sends: the secretary's lines, his line growing as it is heard, a line with no words (an empty or noise
     *  transcript), and the lines already there at the first look (a thread opened during a call). No lines: no
     *  call, so the next call notes an unmarked line again. */
    heard(lines: readonly { itemId: string; role: string; text: string }[]) {
      if (lines.length === 0) notedUnmarked = false;
      let send = false;
      for (const l of lines) {
        if (l.role !== "user" || judged.has(l.itemId) || !WORDS.test(l.text)) continue;
        judged.add(l.itemId);
        if (!looked) continue;
        const mark = marks.get(l.itemId);
        marks.delete(l.itemId);
        if (mark === undefined && !notedUnmarked) {
          notedUnmarked = true;
          opts.note?.(`[chat follow] a line of his on this call came with no mark of his turn beginning (no input_audio_buffer.committed or user item added for ${l.itemId}): counted as a send`);
        }
        if (mark === undefined || mark === handsSoFar) send = true;
      }
      looked = true;
      if (send) sent();
    },
    /** The page took him elsewhere on purpose (a message found by search): not following. */
    leave() {
      stop(opts.read().height);
      tell();
    },
  };
}
