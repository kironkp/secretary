"use client";

// Today (docs/understanding/SPEC.md §9): the date, the Today line, the one
// question whose answer changes tomorrow, the other questions, then past due
// and coming up. It renders the last record and never waits for a run (§8).
//
// Client component: it talks to /api/today and /api/questions only. Every
// type it needs is imported as a type, so nothing server-only crosses over.
//
// Rendering rules the Playwright spec checks (§9 "Nothing is cut off"): no
// truncate, no line-clamp, no nowrap on any text; every tap target is 44px.
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openDetail } from "@/components/dashboard/shared";
import { ErrorNote, SuccessNote } from "@/components/ui";
import type { AnswerResult } from "@/lib/understanding/answer";
import type { QuestionView, TodayData } from "@/lib/understanding/today";
import type { BoundRow } from "@/lib/workspace/types";
import { AnswerButtons } from "./answer-buttons";
import {
  appliedInWords,
  dateLine,
  failedInWords,
  kindClass,
  kindLabel,
  lateInWords,
  updatedLine,
} from "./copy";

/** A question answered by voice or on another device disappears within this. */
const POLL_MS = 60_000;

const isSuggested = (row: BoundRow) => row.fields.source === "suggested";

export function TodayView({
  initial,
  today: initialToday,
  timezone,
}: {
  initial: TodayData;
  /** The date line as the server wrote it, so the first paint and the hydration agree. */
  today: string;
  timezone: string;
}) {
  const [data, setData] = useState<TodayData>(initial);
  // The date line is only ever computed on the server (the page) or after a
  // refresh: a render-time Date on the client would disagree with the
  // server's across midnight, and React would warn on hydrate.
  const [today, setToday] = useState(initialToday);
  const [answering, setAnswering] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A refresh that lands while an answer is in flight would swap the hero out
  // from under the button that was just pressed; the ref is current at once.
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    try {
      const res = await fetch("/api/today", { cache: "no-store" });
      if (!res.ok) return;
      setData((await res.json()) as TodayData);
      setToday(dateLine(new Date(), timezone));
    } catch {
      // A failed poll is not worth a message; the next one is a minute away.
    }
  }, [timezone]);

  // Freshness: the poll, and the window coming back (a stale question that
  // was answered elsewhere disappears on the next of either).
  useEffect(() => {
    const id = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const answer = async (question: QuestionView, answerId: string) => {
    busy.current = true;
    setAnswering(true);
    setError(null);
    setReceipt(null);
    try {
      const res = await fetch(`/api/questions/${question.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answerId }),
      });
      const body = (await res.json().catch(() => null)) as AnswerResult | { error?: string } | null;
      if (res.ok && body && "status" in body && body.status === "resolved") {
        const failed = failedInWords(body.failed);
        setReceipt(appliedInWords(body.applied) + (failed ? `. ${failed}` : ""));
        // Any write elsewhere in the app can say so; the board updates at once.
        window.dispatchEvent(new Event("secretary:data-changed"));
      } else if (res.status === 409) {
        setReceipt("That question was already answered.");
      } else if (res.status === 404) {
        setReceipt("That question is gone.");
      } else {
        setError("That answer could not be applied.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      busy.current = false;
      setAnswering(false);
      // Whatever happened, the screen should now say what is true.
      void refresh();
    }
  };

  const { hero, questions, counts, pastDue, comingUp } = data;
  // The server already leaves suggestions out of `pastDue` and counts them in
  // `counts.pastDueSuggested` (SPEC §10); the split here is only a guard, so a
  // suggested row can never be shown as the user's own if that ever changes.
  const ownPastDue = pastDue.filter((r) => !isSuggested(r));
  const suggestedPastDue = pastDue.filter(isSuggested);
  const updated = updatedLine(data.updatedAt, timezone);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 py-3">
      <div>
        <p className="text-xs font-semibold text-muted">{today}</p>
        <h1 className="mt-1 text-3xl font-bold leading-tight">Today</h1>
        <p className="mt-2 text-base leading-snug wrap-anywhere" data-today-line>
          {data.todayLine}
        </p>
      </div>

      {receipt && <SuccessNote>{receipt}</SuccessNote>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {hero ? (
        <section
          data-testid="today-hero"
          data-question-id={hero.id}
          className="flex flex-col gap-2.5 rounded-2xl border border-edge bg-card px-4 py-3.5"
        >
          <p className={`text-xs font-semibold ${kindClass(hero.kind)}`}>{kindLabel(hero.kind)}</p>
          <h2 className="text-xl font-bold leading-snug wrap-anywhere" data-question-text>
            {hero.question}
          </h2>
          <p className="text-sm leading-normal text-muted wrap-anywhere">{hero.why}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-2">
            <AnswerButtons
              answers={hero.answers}
              disabled={answering}
              onAnswer={(id) => void answer(hero, id)}
            />
            <Link
              href={`/today/${hero.id}`}
              className="inline-flex min-h-11 items-center text-sm text-accent hover:underline"
            >
              What this rests on
            </Link>
          </div>
        </section>
      ) : (
        <section
          data-testid="today-hero-empty"
          className="rounded-2xl border border-edge bg-card px-4 py-3.5 text-sm text-muted"
        >
          No questions right now.
        </section>
      )}

      {/* The hero is the only question: no section saying "nothing else",
          which read as a contradiction under a count of 1. The empty state
          with no hero at all is the hero slot's own, above. */}
      {hero && questions.length === 0 ? null : (
      <Section title="Questions" count={questions.length}>
        {questions.length === 0 ? (
          <Empty>No questions right now.</Empty>
        ) : (
          <ul className="divide-y divide-edge">
            {questions.map((q) => (
              <li key={q.id}>
                <Link
                  href={`/today/${q.id}`}
                  data-question-row={q.id}
                  className="flex min-h-11 items-start gap-2 px-4 py-3 text-sm hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 leading-snug wrap-anywhere">
                    <span className={`font-semibold ${kindClass(q.kind)}`}>{kindLabel(q.kind)}</span>{" "}
                    {q.question}
                  </span>
                  <ChevronRight size={16} strokeWidth={2} className="mt-0.5 flex-none text-faint" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
      )}

      <Section title="Past due" count={counts.pastDue}>
        {ownPastDue.length === 0 && counts.pastDueSuggested === 0 ? (
          <Empty>Nothing past due.</Empty>
        ) : (
          <ul className="divide-y divide-edge">
            {ownPastDue.map((row) => (
              <li key={row.id}>
                <TaskRow row={row} />
              </li>
            ))}
            {counts.pastDueSuggested > 0 && (
              <li>
                <SuggestionsLine count={counts.pastDueSuggested} />
              </li>
            )}
            {suggestedPastDue.map((row) => (
              <li key={row.id}>
                <TaskRow row={row} suggested />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Coming up" count={comingUp.length}>
        {comingUp.length === 0 ? (
          <Empty>Nothing on the calendar this week.</Empty>
        ) : (
          <ul className="divide-y divide-edge">
            {comingUp.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  data-coming-up-row={row.id}
                  onClick={() => openDetail("event", row.id)}
                  className="flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left text-sm hover:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 leading-snug wrap-anywhere">
                    <span data-field="title">{row.fields.title}</span>
                    {row.fields.location && (
                      <span className="block text-xs text-muted">{row.fields.location}</span>
                    )}
                  </span>
                  <span className="flex-none text-xs text-muted">{row.fields.when}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {updated && <p className="text-xs text-faint">{updated}</p>}
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between px-1">
        <h3 className="text-base font-semibold">{title}</h3>
        <span className="text-sm text-muted" data-count>
          {count}
        </span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-edge bg-card">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-sm text-muted">{children}</p>;
}

/** A past-due task: the full title, its project, and how late, as digits. */
function TaskRow({ row, suggested = false }: { row: BoundRow; suggested?: boolean }) {
  const late = lateInWords(row.fields.due ?? "");
  const under = [row.fields.project, suggested ? "my suggestion" : ""].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      data-past-due-row={row.id}
      onClick={() => openDetail("task", row.id)}
      className="flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left text-sm hover:bg-surface-2"
    >
      <span className="min-w-0 flex-1 leading-snug wrap-anywhere">
        <span data-field="title">{row.fields.title}</span>
        {under && <span className="block text-xs text-muted">{under}</span>}
      </span>
      <span className="flex-none text-xs text-danger" data-field="late">
        {late ?? row.fields.due}
      </span>
    </button>
  );
}

/**
 * Suggestions the app made that were never taken up (SPEC §10): labelled as
 * its own and never counted against the user. One line, from the count: the
 * rows themselves stay on the Workspace's past-due widget, where they are
 * marked "my suggestion", so a pile of them cannot bury the user's own work.
 */
function SuggestionsLine({ count }: { count: number }) {
  return (
    <p className="px-4 py-3 text-sm text-muted wrap-anywhere" data-suggested-count={count}>
      {`${count} ${count === 1 ? "suggestion" : "suggestions"} from me, not counted.`}
    </p>
  );
}
