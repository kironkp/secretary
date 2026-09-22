"use client";

// The answers under a question (docs/understanding/SPEC.md §9), shared by the
// hero card on Today and the opened question. One rule from the mockup: the
// first answer is the filled one, the rest are outlined; and one from the
// Canvas post-mortem: every button is a 44px target and its label wraps, so a
// long answer is read in full rather than cut to fit a pill.
import type { Answer } from "@/lib/understanding/types";

export function AnswerButtons({
  answers,
  disabled,
  onAnswer,
}: {
  answers: Answer[];
  disabled: boolean;
  onAnswer: (answerId: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" data-answers>
      {answers.map((a, i) => (
        <button
          key={a.id}
          type="button"
          data-answer={a.id}
          disabled={disabled}
          onClick={() => onAnswer(a.id)}
          className={`min-h-11 rounded-full px-4 py-2 text-left text-sm font-semibold wrap-anywhere transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${
            i === 0
              ? "bg-accent text-white hover:bg-accent/90"
              : "border border-edge bg-card text-ink hover:border-faint"
          }`}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
