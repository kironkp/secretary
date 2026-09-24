"use client";

// A question, opened (docs/understanding/SPEC.md §9), built to the mockup's
// "A question, opened" frame: the way back, the card with the kind and the
// question and the reasoning, the answers as pills with a line per answer
// saying what it writes, and "What I'm going on" as a grouped list with a
// source label in a fixed column and the whole text beside it.
//
// The answers come straight after the reasoning, above the evidence, so
// they are under the thumb without a scroll; the evidence follows. It is
// still the point of this screen: a question the user cannot check is a
// question they cannot trust, so every row shows its source label ("You,
// Sep 1", "Done Sep 1", "Still open") next to the whole text, never a summary.
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DictationField } from "@/components/chat/dictation-field";
import { ErrorNote } from "@/components/ui";
import type { EvidenceView, QuestionView as QuestionData } from "@/lib/understanding/today";
import {
  AnswerButtons,
  FIELD_CLASS,
  OWN_WORDS_MAX,
  useOwnWordsFromUrl,
  type AnswerReply,
} from "./answer-buttons";
import { kindClass, kindLabel, receiptInWords, writesInWords } from "./copy";
import { ThinkingStrip, type StripActivity } from "./thinking-strip";

/** What the route takes: a listed answer, with a note if there is one, or the user's own words. */
type AnswerBody =
  | { answerId: string; note?: string; source?: "today" }
  | { text: string; source: "today" };

/** The source label's colour says what kind of thing it is at a glance. */
function labelClass(label: string): string {
  if (label.startsWith("You")) return "text-accent";
  if (label.startsWith("Still open") || label.startsWith("Expected")) return "text-warn";
  return "text-faint";
}

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
    <li className="flex gap-2.5 px-3.5 py-2 text-[13px] leading-[1.35]" data-evidence={`${item.type}:${item.id}`}>
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

export function QuestionView({ initial }: { initial: QuestionData }) {
  const [question, setQuestion] = useState<QuestionData>(initial);
  const [note, setNote] = useState("");
  // "Write your own" with nothing typed asks for the words through the note
  // field. null until the user says so with a tap; before that the URL
  // (?own=open, the screenshot hook) decides.
  const [askedFor, setAskedFor] = useState<boolean | null>(null);
  const fromUrl = useOwnWordsFromUrl();
  const askedForWords = askedFor ?? fromUrl;
  const noteField = useRef<HTMLTextAreaElement>(null);
  const [answering, setAnswering] = useState(false);
  /** The answer just given, by id ("own" for the words), so its pill stays lit. */
  const [selected, setSelected] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What the strip says on this screen's own account: the answer in flight, then its receipt. */
  const [activity, setActivity] = useState<StripActivity | null>(null);

  const open = question.status === "open" || question.status === "asked";

  // The URL-asked field (a screenshot) gets its focus here; a tap gets it in
  // writeYourOwn, inside the gesture, where iOS will raise the keyboard.
  useEffect(() => {
    if (fromUrl) noteField.current?.focus();
  }, [fromUrl]);

  /**
   * One request to the answer route: a tapped pill sends { answerId } with
   * the note if there is one, "Write your own" sends the note as { text }.
   * The pill lights and the strip says "Applying your answer" before the
   * request leaves. A 503 is the model unable to read the words: nothing was
   * written, so the words stay in the field for another try.
   */
  const post = async (body: AnswerBody) => {
    setAnswering(true);
    setSelected("answerId" in body ? body.answerId : "own");
    setError(null);
    setReceipt(null);
    const started: StripActivity = {
      line: "Applying your answer",
      startedAt: Date.now(),
      projectId: question.projectId,
    };
    setActivity(started);
    try {
      const res = await fetch(`/api/questions/${question.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const reply = (await res.json().catch(() => null)) as AnswerReply | { error?: string } | null;
      if (res.ok && reply && "status" in reply && reply.status === "resolved") {
        // What was applied, or what Secretary read the words as; never more.
        // The same words on the strip, until the server says what it is
        // doing with the answer (SPEC §6 step 4: the project is re-read).
        const words = receiptInWords(reply);
        setReceipt(words);
        setActivity({ ...started, line: words });
        setQuestion((q) => ({ ...q, status: "resolved" }));
        // Any write elsewhere in the app can say so; the board updates at once.
        window.dispatchEvent(new Event("secretary:data-changed"));
      } else if (res.status === 409) {
        setReceipt("This question was already answered.");
        setActivity({ ...started, status: "done" });
        setQuestion((q) => ({ ...q, status: "resolved" }));
      } else if (res.status === 404) {
        setActivity({ ...started, status: "done" });
        setSelected(null);
        setError("This question is gone.");
      } else if (res.status === 503) {
        // The server says why when it can (the model has no credits); the
        // strip shows the same standing condition as the paused state.
        setActivity({ ...started, status: "done" });
        setSelected(null);
        setError((reply && "error" in reply && reply.error) || "Could not read that right now, try again.");
      } else {
        setActivity({ ...started, status: "done" });
        setSelected(null);
        setError("That answer could not be applied.");
      }
    } catch {
      setActivity({ ...started, status: "done" });
      setSelected(null);
      setError("Could not reach the server.");
    } finally {
      setAnswering(false);
    }
  };

  const answer = (answerId: string) => {
    const trimmed = note.trim();
    void post(trimmed ? { answerId, note: trimmed, source: "today" } : { answerId });
  };

  /**
   * The note field is the field: a second one under it would be two places
   * to type. With words in it, they are sent as the answer; with none, the
   * field asks for them (focus, and "Your answer" in place of the note's
   * prompt), and Enter sends once there are some.
   */
  const writeYourOwn = (words = note) => {
    const trimmed = words.trim();
    if (trimmed) {
      void post({ text: trimmed, source: "today" });
      return;
    }
    setAskedFor(true);
    noteField.current?.focus();
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pt-1.5">
      <Link
        href="/today"
        data-back
        className="inline-flex min-h-11 w-fit items-center text-[17px] text-accent"
      >
        <ChevronLeft size={22} strokeWidth={2.2} className="-ml-1.5" />
        Today
      </Link>

      {/* What Secretary is doing with the data, above the question it bears on. */}
      <ThinkingStrip activity={activity} />

      <section
        data-testid="question"
        data-question-id={question.id}
        data-status={question.status}
        className="flex flex-col gap-2.5 rounded-2xl bg-card px-4 pb-3.5 pt-3"
      >
        <p className={`text-[13px] font-semibold tracking-[0.01em] ${kindClass(question.kind)}`}>
          {kindLabel(question.kind)}
          {question.projectName && (
            <span className="font-normal text-faint"> · {question.projectName}</span>
          )}
        </p>
        <h1
          className="text-[22px] font-bold leading-[1.25] tracking-[-0.005em] text-balance wrap-anywhere"
          data-question-text
        >
          {question.question}
        </h1>
        {question.why && <p className="text-[15px] leading-[1.4] wrap-anywhere">{question.why}</p>}
      </section>

      <section className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1 px-1 text-[15px] leading-[1.4] text-faint wrap-anywhere" data-answer-effects>
          {question.answers.map((a) => (
            <li key={a.id} data-answer-effect={a.id}>
              <span className="font-semibold text-ink">{a.label}</span> {writesInWords(a.writes)}
            </li>
          ))}
        </ul>

        {open ? (
          <>
            <DictationField
              fieldRef={noteField}
              id="answer-note"
              value={note}
              maxLength={OWN_WORDS_MAX}
              disabled={answering}
              onChange={setNote}
              onSend={(words) => writeYourOwn(words)}
              onKeyDown={(e) => {
                // Enter sends only once the field was asked for the answer:
                // a note typed to go with a pill is not sent on its own.
                if (e.key === "Enter" && askedForWords) {
                  e.preventDefault();
                  writeYourOwn();
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
            <AnswerButtons
              answers={question.answers}
              selected={selected}
              disabled={answering}
              onAnswer={answer}
              onWriteYourOwn={writeYourOwn}
              size="page"
            />
          </>
        ) : (
          <Link
            href="/today"
            className="grid min-h-11 place-items-center rounded-full bg-card text-[16px] font-semibold text-ink"
          >
            Back to Today
          </Link>
        )}

        {/* What the answer did: the mockup's 15px secondary line, 12px under
            the pills, once the reply has landed. The strip above announces
            the phases, so this line is not a live region twice. */}
        {receipt && (
          <p data-receipt className="px-1 text-[15px] leading-[1.4] text-faint wrap-anywhere">
            {receipt}
          </p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
        {!open && !receipt && (
          <p className="px-1 text-[15px] text-faint" data-closed>
            {question.status === "resolved"
              ? "You answered this one already."
              : question.status === "superseded"
                ? "Another answer changed what this one rested on."
                : "This one resolved itself when the data changed."}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="px-1 text-[15px] font-semibold text-faint">What I&rsquo;m going on</h3>
        <div className="overflow-hidden rounded-xl bg-card">
          {question.evidenceView.length === 0 ? (
            <p className="px-4 py-3 text-[15px] text-faint">Nothing I can still point at.</p>
          ) : (
            <ul className="ios-group [&>*+*]:before:left-[14px]" data-evidence-list>
              {question.evidenceView.map((item) => (
                <EvidenceRow key={`${item.type}:${item.id}`} item={item} />
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
