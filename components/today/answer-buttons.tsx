"use client";

// The answers under a question, shared by the hero card on Today, the opened
// question and the Interview. The mockup's rule: the choices are filled pills
// in the tint, and the last answer, the way out ("Something else", "Keep
// them"), is the grey one. Pills share the row and wrap onto the next line as
// a group; a label never wraps inside its pill, so "Lenses 2110" stays one
// shape.
//
// After the answers comes "Write your own" (the user's words, 2026-09-22:
// "if there's a yes, no, or multiple choice, there's always an extra option
// with write your own"). It is grey like the way out, because it commits to
// none of the listed writes: the server reads the words against the
// question and decides. On Today it swaps the pill row for a field; on the
// screens that already carry a note field it hands the tap to the screen,
// so there is never a second place to type.
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { DictationField } from "@/components/chat/dictation-field";
import type { AnswerResult } from "@/lib/understanding/answer";
import type { Answer } from "@/lib/understanding/types";

/**
 * The route's cap on `text` and on `note` (app/api/questions/[id]/answer):
 * one cap, because on the opened question and the Interview one field
 * carries both, and a cap that changed with the button would cut an
 * explanation off without a word.
 */
export const OWN_WORDS_MAX = 1000;

/** The answer route's body: a reply rides on an answer given in the user's own words. */
export type AnswerReply = AnswerResult & { reply?: string };

/**
 * `?own=open` shows "Write your own" already open, with nothing typed and
 * nothing sent: how e2e/screens.spec.ts photographs the field, since CI has
 * no model to answer with. It cannot be gated on NODE_ENV, because the
 * browser specs run against the production build; it is harmless anywhere,
 * since all it does is open a field. Read during render, the way the chat
 * dock reads ?c=, so the server and the client paint the same thing.
 */
export function useOwnWordsFromUrl(): boolean {
  return useSearchParams().get("own") === "open";
}

/**
 * The iOS grouped-input look the own-words field and the note fields share:
 * a grey cell of the pills' height, no border, the tint's ring on focus. The
 * caller adds the width and the type size (15px in a card, 16px across the
 * screen), which are the pills' on that screen.
 */
export const FIELD_CLASS =
  "min-h-11 min-w-0 rounded-xl bg-surface-2 px-3.5 text-ink placeholder:text-faint outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50";

export function AnswerButtons({
  answers,
  disabled,
  onAnswer,
  onOwnWords,
  onWriteYourOwn,
  selected = null,
  size = "hero",
}: {
  answers: Answer[];
  disabled: boolean;
  onAnswer: (answerId: string) => void;
  /**
   * The answer just given, by id ("own" for the user's words): that pill
   * stays filled and the others fade, from the tap until the card gives way
   * to the next question. The acknowledgement is what the thumb sees before
   * the server has said anything.
   */
  selected?: string | null;
  /**
   * Sends the user's own words. Resolving false means the screen could not
   * take them (the model could not read them, the server was unreachable):
   * the field stays open with the text still in it. Anything else closes it.
   */
  onOwnWords?: (text: string) => void | boolean | Promise<void | boolean>;
  /**
   * The opened question and the Interview already show a note field, and a
   * second field under it would be two places to type. Given this, the tap
   * on "Write your own" goes to the screen, which sends its note.
   */
  onWriteYourOwn?: () => void;
  /** hero: 15px pills in a card. page: 16px pills across the screen. Both
   *  44px tall: the mockup drew 40, Apple's minimum target is 44, and the
   *  Canvas post-mortem is why nothing tappable here goes under it. */
  size?: "hero" | "page";
}) {
  const fromUrl = useOwnWordsFromUrl();
  // null until the first tap or Cancel: until then the URL decides.
  const [opened, setOpened] = useState<boolean | null>(null);
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const ownPill = useRef<HTMLButtonElement>(null);
  const open = !!onOwnWords && !onWriteYourOwn && (opened ?? fromUrl);

  /**
   * Back to the pills without sending, from Escape or Cancel. Focus goes to
   * the "Write your own" pill the field replaced, so a keyboard user is
   * where they were and not at the top of the page; the pill is on screen
   * only after the close has rendered, hence flushSync.
   */
  const close = () => {
    flushSync(() => setOpened(false));
    ownPill.current?.focus();
  };

  // A field opened by the URL gets its focus here; a tapped one gets it
  // below, inside the gesture.
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const writeYourOwn = () => {
    if (onWriteYourOwn) {
      onWriteYourOwn();
      return;
    }
    // iOS raises the keyboard only for a focus() made inside the tap itself,
    // so the field is put on screen synchronously and focused before this
    // handler returns; left to an effect, the focus would land a frame
    // later and the keyboard would stay down.
    flushSync(() => setOpened(true));
    field.current?.focus();
  };

  const send = async (words = text) => {
    const trimmed = words.trim();
    if (!trimmed || disabled || !onOwnWords) return;
    const taken = await onOwnWords(trimmed);
    if (taken === false) return;
    setOpened(false);
    setText("");
  };

  const type = size === "hero" ? "text-[15px]" : "text-[16px]";
  // A pill is a button: Tab reaches it, Enter and Space answer, and the ring
  // shows only for a keyboard (focus-visible), never after a tap.
  const pill = `grid min-h-11 place-items-center whitespace-nowrap rounded-full px-3 font-semibold transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed ${type}`;
  // The grey pill is the card's fill inside a card, and a cell on the ground.
  const grey = size === "hero" ? "bg-surface-2 text-ink" : "bg-card text-ink";
  const filled = "bg-accent text-white active:opacity-80";
  // With an answer given, that pill holds its colour whatever `disabled`
  // says and the rest step back; with none, a disabled row simply dims.
  const state = (id: string) => (selected ? (id === selected ? "" : "opacity-40") : "disabled:opacity-50");

  if (open) {
    return (
      <form
        data-own-words
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
          <DictationField
            fieldRef={field}
            data-own-field
            value={text}
            maxLength={OWN_WORDS_MAX}
            disabled={disabled}
            onChange={setText}
            onSend={(words) => void send(words)}
            onKeyDown={(e) => {
              // Escape is the keyboard's Cancel: back to the pills, words dropped.
              if (e.key === "Escape" && !disabled) {
                e.preventDefault();
                close();
              }
            }}
            placeholder="Your answer"
            aria-label="Your answer, in your own words"
            autoComplete="off"
            enterKeyHint="send"
            className={`${FIELD_CLASS} ${type}`}
          />
          </div>
          <button
            type="submit"
            data-own-send
            disabled={disabled || !text.trim()}
            className={`${pill} ${filled} ${disabled && text.trim() ? "" : "disabled:opacity-50"}`}
          >
            Send
          </button>
        </div>
        <button
          type="button"
          data-own-cancel
          disabled={disabled}
          onClick={close}
          className={`grid min-h-11 w-full place-items-center text-accent disabled:opacity-50 ${type}`}
        >
          Cancel
        </button>
      </form>
    );
  }

  const last = answers.length - 1;
  return (
    <div className="flex flex-wrap gap-2" data-answers>
      {answers.map((a, i) => (
        <button
          key={a.id}
          type="button"
          data-answer={a.id}
          data-selected={selected === a.id || undefined}
          disabled={disabled}
          onClick={() => onAnswer(a.id)}
          className={`flex-auto ${pill} ${state(a.id)} ${
            selected === a.id || i < last || answers.length === 1 ? filled : grey
          }`}
        >
          {a.label}
        </button>
      ))}
      {(onOwnWords || onWriteYourOwn) && (
        <button
          ref={ownPill}
          type="button"
          data-write-own
          data-selected={selected === "own" || undefined}
          disabled={disabled}
          onClick={writeYourOwn}
          className={`flex-auto ${pill} ${state("own")} ${grey}`}
        >
          Write your own
        </button>
      )}
    </div>
  );
}
