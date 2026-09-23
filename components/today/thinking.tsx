"use client";

// The sign that Secretary is thinking: the Talk screen's six bars, small,
// with a line saying what it is reading. Shown under a question card from
// the moment an answer lands until the project's re-read has written new
// questions (or a minute has passed). Kiron's words: "every time I press one
// of these answers, it should be thinking and parsing the data."
//
// Motion is the whole message here, so it is the one place a page animates
// on its own; with prefers-reduced-motion the bars stand still and the words
// carry it. role=status: a screen reader hears the line once, not the bars.
import { useCallback, useEffect, useState } from "react";

const HEIGHTS = [10, 22, 16, 26, 14, 20];

export function Thinking({ label, className = "" }: { label: string; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-thinking
      className={`flex items-center gap-3 px-1 text-[15px] text-faint ${className}`}
    >
      <span className="flex h-7 items-center gap-[5px]" aria-hidden>
        {HEIGHTS.map((h, i) => (
          <span
            key={i}
            className="thinking-bar block w-[5px] rounded-[3px] bg-accent"
            style={{ height: h, animationDelay: `${i * 0.12}s` }}
          />
        ))}
      </span>
      <span className="wrap-anywhere">{label}</span>
    </div>
  );
}

/** While the bars show, the screen asks the server this often whether the re-read has landed. */
export const REREAD_POLL_MS = 2_500;
/** The bars never claim more than a minute: a re-read that has not written by then is over or failed. */
export const REREAD_MAX_MS = 60_000;

type Watch = {
  /** "Reading Caltrans…" */
  label: string;
  /** The stamp before the answer; the re-read has landed when the server's is later. */
  since: string | null;
  /** One refresh: applies the new data in place and returns the server's stamp, or null when nothing was read. */
  tick: () => Promise<string | null>;
  startedAt: number;
};

/**
 * The bars' clock. `start` is called when an answer has resolved; from then
 * on `tick` runs every REREAD_POLL_MS while the tab is visible (paused when
 * it is hidden, resumed on focus), and the watch ends when the stamp it
 * returns is later than `since`, or REREAD_MAX_MS after it began. Each tick
 * applies whatever it read, so the answered question leaves and new ones
 * arrive as the server has them; the bars only say a reading is under way,
 * never that it finished, so a failed re-read simply ends in silence.
 */
export function useReread(): { label: string | null; start: (watch: Omit<Watch, "startedAt">) => void } {
  const [watch, setWatch] = useState<Watch | null>(null);

  useEffect(() => {
    if (!watch) return;
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const pause = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const stop = () => {
      live = false;
      pause();
      setWatch((w) => (w === watch ? null : w));
    };
    const tick = async () => {
      if (!live) return;
      if (Date.now() - watch.startedAt >= REREAD_MAX_MS) {
        stop();
        return;
      }
      const stamp = await watch.tick();
      if (!live) return;
      if (stamp && (!watch.since || stamp > watch.since)) stop();
    };
    const run = () => {
      pause();
      timer = setInterval(() => void tick(), REREAD_POLL_MS);
    };
    const resume = () => {
      if (document.hidden || !live) return;
      void tick();
      run();
    };
    const onVisibility = () => (document.hidden ? pause() : resume());
    if (!document.hidden) run();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", resume);
    // The minute is wall time: a tab hidden for it comes back to no bars.
    const cap = setTimeout(stop, Math.max(0, REREAD_MAX_MS - (Date.now() - watch.startedAt)));
    return () => {
      live = false;
      pause();
      clearTimeout(cap);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", resume);
    };
  }, [watch]);

  const start = useCallback((w: Omit<Watch, "startedAt">) => setWatch({ ...w, startedAt: Date.now() }), []);
  return { label: watch?.label ?? null, start };
}
