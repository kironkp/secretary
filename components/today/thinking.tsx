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
