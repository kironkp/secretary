// The page's side of a drag on the Projects tab (docs/projects/SPEC.md §5):
// the row moves at once; the moves are stored one after the other, in the
// order he made them; an answer to one never draws the list again (what is
// shown is always his latest move); a failed store puts the list back where
// it was last stored, says so plainly, and drops the moves waiting behind it
// (each was worked out on the list that just failed).

export type Move = { projectId: string; name: string; to: number };
export type MoveSave = (m: Move) => Promise<{ ok: true; says?: string } | { ok: false; error: string }>;
export type MoveQueueState<T> = { shown: T; line: string | null; says: string | null };

export function createMoveQueue<T>(initial: T, save: MoveSave, listener: (s: MoveQueueState<T>) => void = () => {}) {
  let shown = initial;
  /** The list as the server last stored it. */
  let stored = initial;
  let line: string | null = null;
  let says: string | null = null;
  const waiting: { move: Move; after: T }[] = [];
  let running = false;
  const tell = () => listener({ shown, line, says });

  const run = async () => {
    if (running) return;
    running = true;
    while (waiting.length) {
      const { move, after } = waiting[0];
      let ok = false;
      let said: string | undefined;
      try {
        const res = await save(move);
        ok = res.ok;
        if (res.ok) said = res.says;
      } catch {
        ok = false;
      }
      waiting.shift();
      if (ok) {
        stored = after;
        if (said?.includes("On the Overview")) {
          says = said;
          tell();
        }
        continue;
      }
      waiting.length = 0;
      shown = stored;
      line = `Couldn't move ${move.name}. It's back where it was.`;
      says = null;
      tell();
    }
    running = false;
  };

  return {
    /** He let go: the list he sees now is `after`. */
    move(move: Move, after: T) {
      shown = after;
      line = null;
      says = null;
      tell();
      waiting.push({ move, after });
      void run();
    },
    /** The server's list, after a fresh load: taken only when nothing is waiting, so it never undoes a move in flight. */
    reset(list: T) {
      if (running || waiting.length) return;
      shown = stored = list;
      tell();
    },
    state: (): MoveQueueState<T> => ({ shown, line, says }),
  };
}
