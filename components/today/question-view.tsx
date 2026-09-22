"use client";

// A question, opened (docs/understanding/SPEC.md §9): what it asks, why, the
// evidence it rests on with every title and quote in full, what each answer
// will write, the answers, and room for one line from the user.
//
// The evidence is the point of this screen. A question the user cannot check
// is a question they cannot trust, so every row shows its source label ("You,
// Sep 1", "Done Sep 1", "Still open") next to the whole text, never a summary.
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useState } from "react";
import { ErrorNote, Input, Label, SuccessNote } from "@/components/ui";
import type { AnswerResult } from "@/lib/understanding/answer";
import type { EvidenceView, QuestionView as QuestionData } from "@/lib/understanding/today";
import { AnswerButtons } from "./answer-buttons";
import { appliedInWords, failedInWords, kindClass, kindLabel, writesInWords } from "./copy";

const NOTE_MAX = 500;

/** The source label's colour says what kind of thing it is at a glance. */
function labelClass(label: string): string {
  if (label.startsWith("You")) return "text-accent";
  if (label.startsWith("Done")) return "text-ok";
  if (label.startsWith("Still open") || label.startsWith("Expected")) return "text-warn";
  if (label.startsWith("Dropped")) return "text-faint";
  return "text-muted";
}

function EvidenceRow({ item }: { item: EvidenceView }) {
  const text = item.href ? (
    <Link href={item.href} className="text-accent hover:underline">
      {item.text}
    </Link>
  ) : (
    item.text
  );
  return (
    <li
      className="grid grid-cols-[6.5rem_1fr] gap-x-3 px-4 py-2.5 text-sm"
      data-evidence={`${item.type}:${item.id}`}
    >
      <span
        data-evidence-label
        className={`pt-px text-xs font-semibold leading-snug wrap-anywhere ${labelClass(item.label)}`}
      >
        {item.label}
      </span>
      <span className="min-w-0 leading-snug wrap-anywhere">
        <span data-evidence-text>{text}</span>
        {item.meta && <span className="block text-xs text-muted">{item.meta}</span>}
      </span>
    </li>
  );
}

export function QuestionView({ initial }: { initial: QuestionData }) {
  const [question, setQuestion] = useState<QuestionData>(initial);
  const [note, setNote] = useState("");
  const [answering, setAnswering] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = question.status === "open" || question.status === "asked";

  const answer = async (answerId: string) => {
    setAnswering(true);
    setError(null);
    try {
      const trimmed = note.trim();
      const res = await fetch(`/api/questions/${question.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trimmed ? { answerId, note: trimmed } : { answerId }),
      });
      const body = (await res.json().catch(() => null)) as AnswerResult | { error?: string } | null;
      if (res.ok && body && "status" in body && body.status === "resolved") {
        const failed = failedInWords(body.failed);
        setReceipt(appliedInWords(body.applied) + (failed ? `. ${failed}` : ""));
        setQuestion((q) => ({ ...q, status: "resolved" }));
        // Any write elsewhere in the app can say so; the board updates at once.
        window.dispatchEvent(new Event("secretary:data-changed"));
      } else if (res.status === 409) {
        setReceipt("This question was already answered.");
        setQuestion((q) => ({ ...q, status: "resolved" }));
      } else if (res.status === 404) {
        setError("This question is gone.");
      } else {
        setError("That answer could not be applied.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setAnswering(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 py-3">
      <Link
        href="/today"
        data-back
        className="inline-flex min-h-11 w-fit items-center gap-0.5 text-base text-accent hover:underline"
      >
        <ChevronLeft size={20} strokeWidth={2} />
        Today
      </Link>

      <section
        data-testid="question"
        data-question-id={question.id}
        data-status={question.status}
        className="flex flex-col gap-2.5 rounded-2xl border border-edge bg-card px-4 py-3.5"
      >
        <p className={`text-xs font-semibold ${kindClass(question.kind)}`}>
          {kindLabel(question.kind)}
          {question.projectName && <span className="font-normal text-muted"> · {question.projectName}</span>}
        </p>
        <h1 className="text-xl font-bold leading-snug wrap-anywhere" data-question-text>
          {question.question}
        </h1>
        {question.why && <p className="text-sm leading-normal text-muted wrap-anywhere">{question.why}</p>}
      </section>

      {receipt && <SuccessNote>{receipt}</SuccessNote>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {!open && !receipt && (
        <p className="px-1 text-sm text-muted" data-closed>
          {question.status === "resolved"
            ? "You answered this one already."
            : "This one resolved itself when the data changed."}
        </p>
      )}

      <section>
        <h3 className="mb-1.5 px-1 text-base font-semibold">What I&rsquo;m going on</h3>
        <div className="overflow-hidden rounded-2xl border border-edge bg-card">
          {question.evidenceView.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">Nothing I can still point at.</p>
          ) : (
            <ul className="divide-y divide-edge" data-evidence-list>
              {question.evidenceView.map((item) => (
                <EvidenceRow key={`${item.type}:${item.id}`} item={item} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1 px-1 text-sm leading-snug wrap-anywhere" data-answer-effects>
          {question.answers.map((a) => (
            <li key={a.id} data-answer-effect={a.id}>
              <span className="font-semibold">{a.label}</span>: {writesInWords(a.writes)}
            </li>
          ))}
        </ul>

        {open ? (
          <>
            <div>
              <Label htmlFor="answer-note">A note, if you want one</Label>
              <Input
                id="answer-note"
                value={note}
                maxLength={NOTE_MAX}
                disabled={answering}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional"
                className="min-h-11"
                autoComplete="off"
              />
            </div>
            <AnswerButtons answers={question.answers} disabled={answering} onAnswer={(id) => void answer(id)} />
          </>
        ) : (
          <Link
            href="/today"
            className="inline-flex min-h-11 w-fit items-center rounded-full border border-edge bg-card px-4 py-2 text-sm font-semibold text-ink hover:border-faint"
          >
            Back to Today
          </Link>
        )}
      </section>
    </div>
  );
}
