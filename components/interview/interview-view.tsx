"use client";

// The Interview (the user's words: "a new tab called interview bot ... set up
// to organize the data"): the secretary asks, one question at a time, until
// the data is sorted. Built to the same system as Today: the 13px line, the
// 34px title, the 17px line under it, and the question as the very card
// Today's hero uses (kind label, 22px question, 15px reasoning, 44px pills
// with the way out in grey), with two things a hero does not carry because
// here the user has sat down for it: the evidence behind a disclosure, and a
// note. Sizes and colours are the mockup's pixel values, through the tokens.
//
// Client component: it talks to /api/interview, /api/interview/more and
// /api/questions only; every type it needs is imported as a type.
//
// Answering, as the user feels it (the same as Today): the tapped pill fills
// and the others fade at once, a line under the card says "Applying…" and
// then what was applied, and the next question takes the card as soon as
// the queue no longer has the answered one, with the thinking bars under it
// while the project is re-read. No fixed pause: the receipt stays under the
// next card until the next answer, and the bars end when a run has finished
// (lastRunAt moves) or after a minute.
//
// The queue is the server's rank order. "Skip for now" is local: the skipped
// question goes to the back of what is on this screen and nothing about it is
// written, so the next visit starts at the top again. A refresh keeps the
// skips: the fetched queue is reordered by them, so a poll cannot bring a
// skipped question straight back to the front. The one write a skip causes
// is on the question it brings forward: the refetch names it as `front`, so
// the server marks it surfaced (SPEC §5: showing a question is asking it),
// the same as it would have been had it been the queue's own front.
//
// Rendering rules the Playwright spec checks (SPEC §9 "Nothing is cut off"):
// no truncate, no line-clamp, no nowrap on any text; every tap target is 44px.
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AnswerButtons,
  FIELD_CLASS,
  OWN_WORDS_MAX,
  useOwnWordsFromUrl,
  type AnswerReply,
} from "@/components/today/answer-buttons";
import { kindClass, kindLabel, readingLabel, receiptInWords } from "@/components/today/copy";
import { Thinking, useReread } from "@/components/today/thinking";
import { ErrorNote } from "@/components/ui";
import type { EvidenceView, InterviewData, QuestionView } from "@/lib/understanding/today";
import { footerLine, progressLine } from "./words";

/** A question answered by voice or on another device disappears within this. */
const POLL_MS = 60_000;

/** What the route takes: a listed answer, with a note if there is one, or the user's own words. */
type AnswerBody =
  | { answerId: string; note?: string; source?: "interview" }
  | { text: string; source: "interview" };
/**
 * "Ask me more" can take a minute, and Heroku's router gives up on a request
 * after 30 seconds while the run goes on inside the dyno. When the POST comes
 * back without an answer, the queue is polled this often, this many times,
 * for the run to finish, and the screen fills in when it does.
 */
const RUN_POLL_MS = 5_000;
const RUN_POLLS = 18;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The source label's colour says what kind of thing it is at a glance (as on the question page). */
function labelClass(label: string): string {
  if (label.startsWith("You")) return "text-accent";
  if (label.startsWith("Still open") || label.startsWith("Expected")) return "text-warn";
  return "text-faint";
}

/** One evidence row, in the question page's style, inside the card. */
function EvidenceRow({ item }: { item: EvidenceView }) {
  const text = item.href ? (
    <Link href={item.href} className="text-accent">
      {item.text}
    </Link>
  ) : (
    item.text
  );
  // A quote the model attached is shown as "note: …"; when it is the row's
  // own title again it says nothing twice, so it is dropped here.
  const meta = (item.meta ?? "")
    .split(" · ")
    .filter((part) => part && part !== `note: ${item.text}`)
    .join(" · ");
  return (
    <li className="flex gap-2.5 py-2 text-[13px] leading-[1.35]" data-evidence={`${item.type}:${item.id}`}>
      <span
        data-evidence-label
        className={`w-[82px] flex-none text-[12px] font-semibold leading-[1.3] ${labelClass(item.label)}`}
      >
        {item.label}
      </span>
      <span className="min-w-0 flex-1 wrap-anywhere">
        <span data-evidence-text>{text}</span>
        {meta && <span className="text-faint"> · {meta}</span>}
      </span>
    </li>
  );
}

/** What a reading came back with, in words, for the line above the pills. */
function readInWords(body: { ran?: number; failed?: number; questionsCreated?: number }): string {
  const ran = body.ran ?? 0;
  const failed = body.failed ?? 0;
  const made = body.questionsCreated ?? 0;
  const parts = [`Read ${ran} ${ran === 1 ? "project" : "projects"}`];
  if (made > 0) parts.push(`${made} new ${made === 1 ? "question" : "questions"}`);
  else parts.push("nothing new to ask");
  if (failed > 0) parts.push(`${failed} could not be read`);
  return `${parts.join("; ")}.`;
}

export function InterviewView({
  initial,
  initialFooter,
}: {
  initial: InterviewData;
  /** The bottom line as the server wrote it, so the first paint and the hydration agree. */
  initialFooter: string;
}) {
  const [data, setData] = useState<InterviewData>(initial);
  const [footer, setFooter] = useState(initialFooter);
  /** Ids skipped on this screen, oldest skip first; they sit at the back in this order. */
  const [skipped, setSkipped] = useState<string[]>([]);
  /** Answered on this screen, for "Question 4 of 14". */
  const [done, setDone] = useState(0);
  const [note, setNote] = useState("");
  // "Write your own" with nothing typed asks for the words through the note
  // field. null until the user says so with a tap; before that the URL
  // (?own=open, the screenshot hook) decides.
  const [askedFor, setAskedFor] = useState<boolean | null>(null);
  const fromUrl = useOwnWordsFromUrl();
  const askedForWords = askedFor ?? fromUrl;
  const noteField = useRef<HTMLInputElement>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [answering, setAnswering] = useState(false);
  /** The answer just given, by question and id ("own" for the words), so its pill stays lit. */
  const [answered, setAnswered] = useState<{ questionId: string; answerId: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const reread = useReread();
  // When a run last finished, as this screen last read it: the stamp the
  // bars watch after an answer. A ref, so post() reads the current one.
  const lastRunAt = useRef<string | null>(initial.lastRunAt);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A refresh that lands while an answer is in flight would swap the question
  // out from under the button that was just pressed; the ref is current at once.
  const busy = useRef(false);

  /**
   * Fetch the queue and keep it, whatever else is going on. `front` is the
   * question this screen is about to show when that is not the server's own
   * front, so the server marks the right one as asked.
   */
  const load = useCallback(async (front?: string): Promise<InterviewData | null> => {
    try {
      const url = front ? `/api/interview?front=${encodeURIComponent(front)}` : "/api/interview";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      const next = (await res.json()) as InterviewData;
      lastRunAt.current = next.lastRunAt;
      setData(next);
      setFooter(footerLine(next.answeredToday, next.lastRunAt, new Date()));
      return next;
    } catch {
      // A failed poll is not worth a message; the next one is a minute away.
      return null;
    }
  }, []);

  /** The poll's refresh: never while an answer or a reading is in flight. */
  const refresh = useCallback(async () => {
    if (busy.current) return;
    await load();
  }, [load]);

  // Freshness: the poll, the window coming back, and any write the app
  // announces (a voice answer lands as "secretary:data-changed"): a question
  // answered elsewhere disappears on the next of any of them.
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

  // The queue as this screen orders it: the server's rank order, with the
  // questions skipped here at the back, in the order they were skipped.
  const byId = new Map(data.queue.map((q) => [q.id, q]));
  const queue: QuestionView[] = [
    ...data.queue.filter((q) => !skipped.includes(q.id)),
    ...skipped.flatMap((id) => {
      const q = byId.get(id);
      return q ? [q] : [];
    }),
  ];
  const current = queue[0] ?? null;

  // The card is keyed by its question, and from the second one on it rises
  // in (the hero-enter rule in globals.css). Derived during render, so the
  // class is on the new card from its first frame.
  const currentId = current?.id ?? null;
  const [shown, setShown] = useState<{ id: string | null; n: number }>({ id: currentId, n: 0 });
  if (shown.id !== currentId) setShown({ id: currentId, n: shown.n + 1 });

  // The URL-asked field (a screenshot) gets its focus here; a tap gets it in
  // writeYourOwn, inside the gesture, where iOS will raise the keyboard.
  useEffect(() => {
    if (fromUrl) noteField.current?.focus();
  }, [fromUrl]);

  /**
   * One request to the answer route: a tapped pill sends { answerId } with
   * the note if there is one, "Write your own" sends the note as { text }.
   * The pill lights and "Applying…" shows before the request leaves; the
   * next question comes with the first refresh after the reply.
   */
  const post = async (question: QuestionView, body: AnswerBody) => {
    busy.current = true;
    setAnswering(true);
    setAnswered({ questionId: question.id, answerId: "answerId" in body ? body.answerId : "own" });
    setError(null);
    setReceipt("Applying…");
    setStatus(null);
    const since = lastRunAt.current;
    try {
      const res = await fetch(`/api/questions/${question.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const reply = (await res.json().catch(() => null)) as AnswerReply | { error?: string } | null;
      if (res.ok && reply && "status" in reply && reply.status === "resolved") {
        // The receipt says only what was applied (SPEC §10, the honesty
        // rule), or what Secretary read the words as.
        setReceipt(receiptInWords(reply));
        // Any write elsewhere in the app can say so; the board updates at once.
        window.dispatchEvent(new Event("secretary:data-changed"));
        setDone((n) => n + 1);
        // The project is being re-read (SPEC §6 step 4): the bars say so
        // until a run finishes after `since`, or for a minute.
        reread.start({
          label: readingLabel(question.projectName),
          since,
          tick: async () => (busy.current ? null : ((await load())?.lastRunAt ?? null)),
        });
      } else if (res.status === 409) {
        setReceipt("That question was already answered.");
      } else if (res.status === 404) {
        setReceipt("That question is gone.");
      } else if (res.status === 503) {
        // The model could not read the words. Nothing was written, and they
        // stay in the field for another try.
        setReceipt(null);
        setAnswered(null);
        setError("Could not read that right now, try again.");
        return;
      } else {
        setReceipt(null);
        setAnswered(null);
        setError("That answer could not be applied.");
        return;
      }
      // The next question comes now: the answered one is resolved, so the
      // fetched queue no longer has it. The receipt stays under the new card.
      await load();
      setNote("");
      setAskedFor(false);
      setEvidenceOpen(false);
      setSkipped((s) => s.filter((id) => id !== question.id));
    } catch {
      setReceipt(null);
      setAnswered(null);
      setError("Could not reach the server.");
    } finally {
      busy.current = false;
      setAnswering(false);
    }
  };

  const answer = (question: QuestionView, answerId: string) => {
    const trimmed = note.trim();
    void post(question, trimmed ? { answerId, note: trimmed, source: "interview" } : { answerId });
  };

  /**
   * The note field is the field: a second one under it would be two places
   * to type. With words in it, they are sent as the answer; with none, the
   * field asks for them (focus, and "Your answer" in place of the note's
   * prompt), and Enter sends once there are some.
   */
  const writeYourOwn = (question: QuestionView) => {
    const trimmed = note.trim();
    if (trimmed) {
      void post(question, { text: trimmed, source: "interview" });
      return;
    }
    setAskedFor(true);
    noteField.current?.focus();
  };

  /**
   * To the back of this screen's queue. Nothing is written about the skipped
   * question; the one now in front is fetched as `front` so it is marked
   * surfaced, since the user is about to read it.
   */
  const skip = (question: QuestionView) => {
    setSkipped((s) => [...s.filter((id) => id !== question.id), question.id]);
    setNote("");
    setAskedFor(false);
    setEvidenceOpen(false);
    setReceipt(null);
    setError(null);
    const next = queue[1];
    if (next && !busy.current) void load(next.id);
  };

  const askMore = async () => {
    busy.current = true;
    setReading(true);
    setError(null);
    setStatus(null);
    const before = data.lastRunAt;
    let answered = false;
    try {
      const res = await fetch("/api/interview/more", { method: "POST" });
      const body = (await res.json().catch(() => null)) as
        | { ran?: number; failed?: number; questionsCreated?: number; error?: string }
        | null;
      if (res.ok && body) {
        answered = true;
        setStatus(readInWords(body));
      } else {
        setError(body?.error ?? "The reading did not finish.");
      }
    } catch {
      // No response at all: the request was cut while the run went on (see
      // RUN_POLL_MS). The poll below finds out whether it finished.
    }
    try {
      let next = await load();
      for (let i = 0; !answered && i < RUN_POLLS && next?.lastRunAt === before; i++) {
        await sleep(RUN_POLL_MS);
        next = await load();
      }
      if (!answered && next && next.lastRunAt !== before) {
        setError(null);
        setStatus(next.total > 0 ? null : "Read your projects; nothing new to ask.");
      }
    } finally {
      busy.current = false;
      setReading(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pt-1.5">
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-semibold text-faint" data-count-line>
          {progressLine(done, queue.length, current?.projectName ?? null)}
        </p>
        <h1 className="text-[34px] font-bold leading-[1.2] tracking-[-0.01em]">Interview</h1>
      </div>
      <p className="text-[17px] leading-[1.4] wrap-anywhere" data-interview-line>
        {current ? "I ask, you answer, and your data gets sorted." : "Nothing to sort out right now."}
      </p>

      {error && <ErrorNote>{error}</ErrorNote>}

      {current ? (
        <>
          <section
            key={current.id}
            data-testid="interview"
            data-question-id={current.id}
            className={`flex flex-col gap-2.5 rounded-2xl bg-card px-4 pb-3.5 pt-3.5 ${shown.n > 0 ? "hero-enter" : ""}`}
          >
            <p className={`text-[13px] font-semibold tracking-[0.01em] ${kindClass(current.kind)}`}>
              {kindLabel(current.kind)}
            </p>
            <h2
              className="text-[22px] font-bold leading-[1.25] tracking-[-0.005em] text-balance wrap-anywhere"
              data-question-text
            >
              {current.question}
            </h2>
            {current.why && <p className="text-[15px] leading-[1.4] wrap-anywhere">{current.why}</p>}

            <input
              ref={noteField}
              id="interview-note"
              type="text"
              value={note}
              maxLength={OWN_WORDS_MAX}
              disabled={answering}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends only once the field was asked for the answer:
                // a note typed to go with a pill is not sent on its own.
                if (e.key === "Enter" && askedForWords) {
                  e.preventDefault();
                  writeYourOwn(current);
                } else if (e.key === "Escape" && askedForWords) {
                  // Back to a note with a pill; the words stay typed.
                  e.preventDefault();
                  setAskedFor(false);
                }
              }}
              placeholder={askedForWords ? "Your answer" : "Add a note, if you want"}
              aria-label={askedForWords ? "Your answer, in your own words" : "A note with your answer"}
              enterKeyHint={askedForWords ? "send" : undefined}
              autoComplete="off"
              className={`w-full ${FIELD_CLASS} text-[15px]`}
            />
            <div className="mt-0.5">
              <AnswerButtons
                answers={current.answers}
                selected={answered?.questionId === current.id ? answered.answerId : null}
                disabled={answering}
                onAnswer={(id) => answer(current, id)}
                onWriteYourOwn={() => writeYourOwn(current)}
              />
            </div>

            {/* The evidence, behind a disclosure, after the answers so the
                pills stay under the thumb: the card keeps the hero's size
                until the user asks what it rests on. Closed by default, and
                closed again for every new question. */}
            <button
              type="button"
              data-evidence-toggle
              aria-expanded={evidenceOpen}
              onClick={() => setEvidenceOpen((o) => !o)}
              className="-mb-1 flex min-h-11 w-fit items-center gap-1 text-[15px] font-semibold text-faint"
            >
              What I&rsquo;m going on
              <ChevronDown
                size={16}
                strokeWidth={2}
                className={`transition-transform motion-reduce:transition-none ${evidenceOpen ? "rotate-180" : ""}`}
              />
            </button>
            {evidenceOpen &&
              (current.evidenceView.length === 0 ? (
                <p className="text-[15px] text-faint">Nothing I can still point at.</p>
              ) : (
                <ul className="ios-group [&>*+*]:before:left-0" data-evidence-list>
                  {current.evidenceView.map((item) => (
                    <EvidenceRow key={`${item.type}:${item.id}`} item={item} />
                  ))}
                </ul>
              ))}
          </section>

          {/* What the answer did, then the re-read under way: the 15px
              secondary line under the card, 12px apart, as on Today. */}
          {(receipt || reread.label) && (
            <div className="-mt-1 flex flex-col gap-3">
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
              {reread.label && <Thinking label={reread.label} />}
            </div>
          )}

          <button
            type="button"
            data-skip
            disabled={answering}
            onClick={() => skip(current)}
            className="grid min-h-11 w-full place-items-center text-[17px] text-accent disabled:opacity-50"
          >
            Skip for now
          </button>
        </>
      ) : (
        <section data-testid="interview-empty" className="flex flex-col gap-3">
          {(reading || status) && (
            <p className="px-1 text-[15px] leading-[1.4] text-faint wrap-anywhere" data-reading aria-live="polite">
              {reading ? "Reading your projects…" : status}
            </p>
          )}
          {/* The mockup's two pills across the screen: the filled one is the
              thing to do, the cell-coloured one the way out. */}
          <div className="flex gap-2">
            <button
              type="button"
              data-ask-more
              disabled={reading}
              onClick={() => void askMore()}
              className="grid min-h-11 flex-1 place-items-center rounded-full bg-accent px-3 text-[16px] font-semibold text-white active:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Ask me more
            </button>
            <Link
              href="/today"
              data-done
              aria-disabled={reading || undefined}
              className={`grid min-h-11 flex-1 place-items-center rounded-full bg-card px-3 text-[16px] font-semibold text-ink ${
                reading ? "pointer-events-none opacity-50" : ""
              }`}
            >
              Done for now
            </Link>
          </div>
        </section>
      )}

      <p className="px-1 text-[13px] text-faint" data-interview-footer>
        {footer}
      </p>
    </div>
  );
}
