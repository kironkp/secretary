"use client";

// The answers under a question, shared by the hero card on Today and the
// opened question. The mockup's rule: the choices are filled pills in the
// tint, and the last answer, the way out ("Something else", "Keep them"), is
// the grey one. Pills share the row and wrap onto the next line as a group;
// a label never wraps inside its pill, so "Lenses 2110" stays one shape.
import type { Answer } from "@/lib/understanding/types";

export function AnswerButtons({
  answers,
  disabled,
  onAnswer,
  size = "hero",
}: {
  answers: Answer[];
  disabled: boolean;
  onAnswer: (answerId: string) => void;
  /** hero: 40px pills in a card. page: 44px pills across the screen. */
  size?: "hero" | "page";
}) {
  const last = answers.length - 1;
  const height = size === "hero" ? "min-h-10 text-[15px]" : "min-h-11 text-[16px]";
  return (
    <div className="flex flex-wrap gap-2" data-answers>
      {answers.map((a, i) => (
        <button
          key={a.id}
          type="button"
          data-answer={a.id}
          disabled={disabled}
          onClick={() => onAnswer(a.id)}
          className={`grid flex-auto place-items-center whitespace-nowrap rounded-full px-3 font-semibold transition-opacity focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${height} ${
            i < last || answers.length === 1
              ? "bg-accent text-white active:opacity-80"
              : size === "hero"
                ? "bg-surface-2 text-ink"
                : "bg-card text-ink"
          }`}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
