"use client";

// Today (docs/understanding/SPEC.md §9), built to the "Secretary on iPhone"
// mockup: the date line, the large title, the line about the day, the one
// question whose answer changes tomorrow as a card with its answers, the
// other questions as a grouped list with the kind of each in front, then
// past due and coming up. Sizes and spacing are the mockup's, in pixels: a
// 34px title, 22px question, 15px reasoning, 16px rows, 20px section titles.
//
// Answering, as the user feels it: the tapped pill fills and the others fade
// the moment it is pressed, a line under the card says "Applying…" and then
// what was applied, the thinking bars come on while the project is re-read,
// and the next question takes the card's place with the old one fading out
// and the new one rising in. The page is never rebuilt: every change is a
// state update on the same tree, keyed by question id, so scroll, the
// sections below and the other rows stay exactly where they are.
//
// Client component: it talks to /api/today and /api/questions only. Every
// type it needs is imported as a type, so nothing server-only crosses over.
//
// Rendering rules the Playwright spec checks (§9 "Nothing is cut off"): no
// truncate, no line-clamp, no nowrap on any text; every tap target is 44px.
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openDetail } from "@/components/dashboard/shared";
import { ErrorNote } from "@/components/ui";
import type { QuestionView, TodayData } from "@/lib/understanding/today";
import type { BoundRow } from "@/lib/workspace/types";
import { AnswerButtons, type AnswerReply } from "./answer-buttons";
import { dateLine, kindClass, kindLabel, lateInWords, readingLabel, receiptInWords, updatedLine } from "./copy";
import { Thinking, useReread } from "./thinking";

/** A question answered by voice or on another device disappears within this. */
const POLL_MS = 60_000;
/** The app's motion language (CLAUDE.md, components/shell/nav-tabs.tsx): one swap takes this long. */
const SWAP_MS = 340;
const SWAP_EASE = "cubic-bezier(0.22, 0.9, 0.32, 1)";

const isSuggested = (row: BoundRow) => row.fields.source === "suggested";

/** The answer just given, so its pill stays lit until the card gives way. */
type Answered = { questionId: string; answerId: string };

/** The outgoing card, kept for one swap while it fades over the incoming one. */
type Ghost = { hero: QuestionView; selected: string | null };

/**
 * The rows the list shows: the server's list, with any row that just left it
 * kept in place for one swap while it fades and closes. `source` is the
 * server's array by reference, so a new payload is noticed during render.
 */
type Rows = { source: QuestionView[]; shown: QuestionView[]; leaving: Set<string> };

const selectedFor = (answered: Answered | null, questionId: string) =>
  answered?.questionId === questionId ? answered.answerId : null;

/**
 * `?thinking=open` shows the bars under the hero as if a re-read were under
 * way, with nothing polled and nothing sent: how e2e/screens.spec.ts
 * photographs them, since CI has no model to answer with. Like ?own=open it
 * cannot be gated on NODE_ENV (the browser specs run the production build)
 * and is harmless anywhere: it shows a line.
 */
function useThinkingFromUrl(): boolean {
  return useSearchParams().get("thinking") === "open";
}

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
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reread = useReread();
  const thinkingFromUrl = useThinkingFromUrl();
  // A refresh that lands while an answer is in flight would swap the hero out
  // from under the button that was just pressed; the ref is current at once.
  const busy = useRef(false);
  // When a run last finished, as this screen last read it: the stamp the
  // bars watch after an answer (the same one the Interview watches). A ref,
  // because state would be a render behind inside post().
  const lastRunAt = useRef<string | null>(initial.lastRunAt);

  /** One read of /api/today applied in place; the server's run stamp, or null when nothing was read. */
  const load = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch("/api/today", { cache: "no-store" });
      if (!res.ok) return null;
      const next = (await res.json()) as TodayData;
      lastRunAt.current = next.lastRunAt;
      setData(next);
      setToday(dateLine(new Date(), timezone));
      return next.lastRunAt;
    } catch {
      // A failed poll is not worth a message; the next one is a minute away.
      return null;
    }
  }, [timezone]);

  /** The poll's refresh: never while an answer is in flight. */
  const refresh = useCallback(async () => {
    if (busy.current) return;
    await load();
  }, [load]);

  // Freshness: the poll, the window coming back, and any write the app
  // announces (a voice answer lands as "secretary:data-changed"): a stale
  // question answered elsewhere disappears on the next of any of them.
  useEffect(() => {
    const id = setInterval(() => void refresh(), POLL_MS);
    const onFocus = () => void refresh();
    const onChanged = () => void refresh();
    window.addEventListener("focus", onFocus);
    window.addEventListener("secretary:data-changed", onChanged);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("secretary:data-changed", onChanged);
    };
  }, [refresh]);

  /**
   * One request to the answer route: a tapped pill sends { answerId }, the
   * "Write your own" field sends { text }. Resolves true when the question
   * took the answer or is gone either way, false when the words should stay
   * in the field for another try (the model could not read them, or the
   * server was out of reach); the field closes only on true.
   *
   * The pill lights and "Applying…" shows before the request leaves; the
   * pills stay held until the refresh after the reply has swapped the card,
   * so the acknowledged state never flickers back to a live row of pills.
   */
  const post = async (
    question: QuestionView,
    body: { answerId: string } | { text: string; source: "today" }
  ): Promise<boolean> => {
    busy.current = true;
    setAnswering(true);
    setAnswered({ questionId: question.id, answerId: "answerId" in body ? body.answerId : "own" });
    setError(null);
    setReceipt("Applying…");
    const since = lastRunAt.current;
    let taken = false;
    try {
      const res = await fetch(`/api/questions/${question.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const reply = (await res.json().catch(() => null)) as AnswerReply | { error?: string } | null;
      if (res.ok && reply && "status" in reply && reply.status === "resolved") {
        // What was applied, or what Secretary read the words as; never more.
        setReceipt(receiptInWords(reply));
        // The questions the answer set aside leave the list now, in the same
        // moment the receipt names them, not on the refresh that follows.
        const gone = new Set(reply.superseded ?? []);
        if (gone.size > 0) {
          setData((d) => {
            const questions = d.questions.filter((q) => !gone.has(q.id));
            const left = d.questions.length - questions.length;
            return left === 0
              ? d
              : { ...d, questions, counts: { ...d.counts, questions: d.counts.questions - left } };
          });
        }
        // Any write elsewhere in the app can say so; the board updates at once.
        window.dispatchEvent(new Event("secretary:data-changed"));
        // The project is being re-read (SPEC §6 step 4): the bars say so
        // until a run finishes after `since`, or for a minute.
        reread.start({
          label: readingLabel(question.projectName),
          since,
          tick: async () => (busy.current ? null : load()),
        });
        taken = true;
      } else if (res.status === 409) {
        setReceipt("That question was already answered.");
        taken = true;
      } else if (res.status === 404) {
        setReceipt("That question is gone.");
        taken = true;
      } else if (res.status === 503) {
        // Nothing was written; the words are still in the field.
        setReceipt(null);
        setError("Could not read that right now, try again.");
      } else {
        setReceipt(null);
        setError("That answer could not be applied.");
      }
    } catch {
      setReceipt(null);
      setError("Could not reach the server.");
    }
    if (!taken) setAnswered(null);
    // Whatever happened, the screen should now say what is true: the
    // answered question leaves and the next one takes the card.
    await load();
    busy.current = false;
    setAnswering(false);
    return taken;
  };

  const { hero, questions, counts, pastDue, comingUp } = data;
  const heroId = hero?.id ?? null;

  // --- The card's swap: the outgoing hero fades over the incoming one. ---
  // Derived during render, so the ghost and the new card land in one commit
  // and the swap has no frame that shows neither. `shown` is the hero whose
  // card was rendered last; a different hero now means a swap, and the one
  // rendered last becomes the ghost.
  const [swap, setSwap] = useState<{ shown: QuestionView | null; ghost: Ghost | null; n: number }>({
    shown: hero,
    ghost: null,
    n: 0,
  });
  if ((swap.shown?.id ?? null) !== heroId) {
    const prev = swap.shown;
    setSwap({
      shown: hero,
      ghost: prev ? { hero: prev, selected: selectedFor(answered, prev.id) } : null,
      n: swap.n + 1,
    });
  }
  // The ghost has faded by the end of the swap; drop it then.
  useEffect(() => {
    if (!swap.ghost) return;
    const t = setTimeout(() => setSwap((s) => (s.n === swap.n ? { ...s, ghost: null } : s)), SWAP_MS);
    return () => clearTimeout(t);
  }, [swap.n, swap.ghost]);

  // The card slot's height glides from the old card's to the new one's, so
  // the sections below move with the swap instead of jumping at it. A CSS
  // transition, so reduced motion (globals.css, last block) makes it instant.
  const stackRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const lastHeight = useRef<number | null>(null);
  const committed = useRef(heroId);
  useLayoutEffect(() => {
    if (committed.current === heroId) return;
    committed.current = heroId;
    const stack = stackRef.current;
    const from = lastHeight.current;
    const to = cardRef.current?.offsetHeight ?? null;
    if (!stack || from === null || to === null || from === to) return;
    stack.style.transition = "none";
    stack.style.overflow = "hidden";
    stack.style.height = `${from}px`;
    void stack.offsetHeight; // commit the starting height before it moves
    stack.style.transition = `height ${SWAP_MS}ms ${SWAP_EASE}`;
    stack.style.height = `${to}px`;
    const done = () => {
      stack.style.transition = "";
      stack.style.overflow = "";
      stack.style.height = "";
    };
    const t = setTimeout(done, SWAP_MS + 40);
    return () => {
      clearTimeout(t);
      done();
    };
  }, [heroId]);
  useLayoutEffect(() => {
    lastHeight.current = cardRef.current?.offsetHeight ?? null;
  });

  // --- The list: rows that leave fade and close; the rest never move. ---
  const [rows, setRows] = useState<Rows>({ source: questions, shown: questions, leaving: new Set() });
  if (rows.source !== questions) {
    const ids = new Set(questions.map((q) => q.id));
    const shown = [...questions];
    const leaving = new Set<string>();
    // A row that is gone keeps its old place among the new rows while it fades.
    rows.shown.forEach((q, i) => {
      if (ids.has(q.id)) return;
      shown.splice(Math.min(i, shown.length), 0, q);
      leaving.add(q.id);
    });
    setRows({ source: questions, shown, leaving });
  }
  useEffect(() => {
    if (rows.leaving.size === 0) return;
    const gone = rows.leaving;
    const t = setTimeout(
      () =>
        setRows((s) =>
          s.leaving === gone
            ? { ...s, shown: s.shown.filter((q) => !gone.has(q.id)), leaving: new Set() }
            : s
        ),
      SWAP_MS
    );
    return () => clearTimeout(t);
  }, [rows.leaving]);

  // The server already leaves suggestions out of `pastDue` and counts them in
  // `counts.pastDueSuggested` (SPEC §10); the split here is only a guard, so a
  // suggested row can never be shown as the user's own if that ever changes.
  const ownPastDue = pastDue.filter((r) => !isSuggested(r));
  const suggestedPastDue = pastDue.filter(isSuggested);
  const updated = updatedLine(data.updatedAt, timezone);
  const thinking = reread.label ?? (thinkingFromUrl ? readingLabel(null) : null);
  const entering = swap.n > 0;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pt-1.5">
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-semibold text-faint">{today}</p>
        <h1 className="text-[34px] font-bold leading-[1.2] tracking-[-0.01em]">Today</h1>
      </div>
      <p className="text-[17px] leading-[1.4] wrap-anywhere" data-today-line>
        {data.todayLine}
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex flex-col gap-3">
        <div ref={stackRef} className="swap-stack">
          {swap.ghost && (
            <HeroCard
              key={`ghost-${swap.ghost.hero.id}-${swap.n}`}
              hero={swap.ghost.hero}
              selected={swap.ghost.selected}
              ghost
            />
          )}
          {hero ? (
            <HeroCard
              key={hero.id}
              ref={cardRef}
              hero={hero}
              selected={selectedFor(answered, hero.id)}
              disabled={answering}
              entering={entering}
              onAnswer={(id) => void post(hero, { answerId: id })}
              onOwnWords={(text) => post(hero, { text, source: "today" })}
            />
          ) : (
            <section
              key="empty"
              ref={cardRef}
              data-testid="today-hero-empty"
              className={`rounded-2xl bg-card px-4 py-3.5 text-[15px] text-faint ${entering ? "hero-enter" : ""}`}
            >
              No questions right now.
            </section>
          )}
        </div>

        {/* What the answer did, then the re-read under way: the mockup's
            15px secondary line under the card, 12px apart. The receipt is
            one element from "Applying…" on, so the announcement is one. */}
        {(receipt || thinking) && (
          <div className="flex flex-col gap-3">
            {receipt && (
              <p
                role="status"
                aria-live="polite"
                data-receipt
                className="px-1 text-[15px] leading-[1.4] text-faint wrap-anywhere"
              >
                {receipt}
              </p>
            )}
            {thinking && <Thinking label={thinking} />}
          </div>
        )}
      </div>

      {/* The hero is the only question: no section saying "nothing else",
          which read as a contradiction under a count of 1. The empty state
          with no hero at all is the hero slot's own, above. */}
      {hero && rows.shown.length === 0 ? null : (
        <Section title="Questions" count={questions.length}>
          {rows.shown.length === 0 ? (
            <Empty>No questions right now.</Empty>
          ) : (
            <ul className="ios-group">
              {rows.shown.map((q) => {
                const leaving = rows.leaving.has(q.id);
                return (
                  <li key={q.id} className={leaving ? "row-leave" : undefined} aria-hidden={leaving || undefined}>
                    <div>
                      <Link
                        href={`/today/${q.id}`}
                        data-question-row={leaving ? undefined : q.id}
                        tabIndex={leaving ? -1 : undefined}
                        className="flex min-h-12 items-center gap-3 py-2.5 pl-4 pr-3.5 active:bg-surface-2"
                      >
                        <span className="min-w-0 flex-1 text-[16px] leading-[1.3] wrap-anywhere">
                          <span className={`mr-1 text-[13px] font-semibold ${kindClass(q.kind)}`}>
                            {kindLabel(q.kind)}
                          </span>
                          {q.question}
                        </span>
                        <ChevronRight size={16} strokeWidth={2} className="flex-none text-faint" />
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}

      <Section title="Past due" count={counts.pastDue} tone={counts.pastDue > 0 ? "red" : undefined}>
        {ownPastDue.length === 0 && counts.pastDueSuggested === 0 ? (
          <Empty>Nothing past due.</Empty>
        ) : (
          <ul className="ios-group">
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
          <ul className="ios-group">
            {comingUp.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  data-coming-up-row={row.id}
                  onClick={() => openDetail("event", row.id)}
                  className="flex min-h-12 w-full items-center gap-3 py-2.5 pl-4 pr-4 text-left active:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 text-[16px] leading-[1.3] wrap-anywhere">
                    <span data-field="title">{row.fields.title}</span>
                    {row.fields.location && (
                      <span className="block text-[13px] text-faint">{row.fields.location}</span>
                    )}
                  </span>
                  <span className="flex-none text-[15px] text-faint">{row.fields.when}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {updated && <p className="px-1 text-[13px] text-faint">{updated}</p>}
    </div>
  );
}

/**
 * The hero card: the kind, the question (the way into its evidence), the
 * reasoning, the answers. As a `ghost` it is the outgoing card during a
 * swap: the same picture with its lit pill, fading, with none of the test
 * hooks and nothing to press, so the incoming card is the only hero.
 */
function HeroCard({
  ref,
  hero,
  selected,
  disabled = true,
  entering = false,
  ghost = false,
  onAnswer,
  onOwnWords,
}: {
  ref?: React.Ref<HTMLElement>;
  hero: QuestionView;
  selected: string | null;
  disabled?: boolean;
  entering?: boolean;
  ghost?: boolean;
  onAnswer?: (answerId: string) => void;
  onOwnWords?: (text: string) => Promise<boolean>;
}) {
  return (
    <section
      ref={ref}
      data-testid={ghost ? undefined : "today-hero"}
      data-question-id={ghost ? undefined : hero.id}
      aria-hidden={ghost || undefined}
      className={`flex flex-col gap-2.5 rounded-2xl bg-card px-4 pb-3.5 pt-3.5 ${
        ghost ? "hero-leave" : entering ? "hero-enter" : ""
      }`}
    >
      <p className={`text-[13px] font-semibold tracking-[0.01em] ${kindClass(hero.kind)}`}>
        {kindLabel(hero.kind)}
      </p>
      {/* The question is the way into the evidence page: no link text. */}
      <Link href={`/today/${hero.id}`} className="block" tabIndex={ghost ? -1 : undefined}>
        <h2
          className="text-[22px] font-bold leading-[1.25] tracking-[-0.005em] text-balance wrap-anywhere"
          data-question-text={ghost ? undefined : true}
        >
          {hero.question}
        </h2>
      </Link>
      <p className="text-[15px] leading-[1.4] wrap-anywhere">{hero.why}</p>
      <div className="mt-0.5">
        {/* Keyed by the question: the next hero starts with its pills,
            not with the last one's field still open. */}
        <AnswerButtons
          key={hero.id}
          answers={hero.answers}
          selected={selected}
          disabled={disabled}
          onAnswer={onAnswer ?? (() => {})}
          // The ghost keeps its "Write your own" pill (the row wraps the
          // same way), but nothing on it can send.
          onOwnWords={onOwnWords ?? (() => false)}
        />
      </div>
    </section>
  );
}

function Section({
  title,
  count,
  tone,
  children,
}: {
  title: string;
  count: number;
  tone?: "red";
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between px-1">
        <h3 className="text-[20px] font-bold">{title}</h3>
        <span className={`text-[15px] ${tone === "red" ? "text-danger" : "text-faint"}`} data-count>
          {count}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl bg-card">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-3 text-[15px] text-faint">{children}</p>;
}

/** A past-due task: the full title, its project, and how late, as digits. */
function TaskRow({ row, suggested = false }: { row: BoundRow; suggested?: boolean }) {
  const late = lateInWords(row.fields.due ?? "");
  const under = [row.fields.project, suggested ? "my suggestion" : ""].filter(Boolean).join(", ");
  return (
    <button
      type="button"
      data-past-due-row={row.id}
      onClick={() => openDetail("task", row.id)}
      className="flex min-h-12 w-full items-center gap-3 py-2.5 pl-4 pr-4 text-left active:bg-surface-2"
    >
      <span className="min-w-0 flex-1 text-[16px] leading-[1.3] wrap-anywhere">
        <span data-field="title">{row.fields.title}</span>
        {under && <span className="block text-[13px] text-faint">{under}</span>}
      </span>
      <span className="flex-none text-[15px] font-semibold text-danger" data-field="late">
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
    <p className="px-4 py-3 text-[15px] text-faint wrap-anywhere" data-suggested-count={count}>
      {`${count} ${count === 1 ? "suggestion" : "suggestions"} from me, not counted.`}
    </p>
  );
}
