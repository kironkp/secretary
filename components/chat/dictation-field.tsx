"use client";

// A text field with the chat composer's dictation built in: a mic at its
// right edge turns the field into the same DictationBar the chat uses (X ·
// scrolling tape · Stop · Send), so every answer box talks the same way.
// Stop drops the words into the field; Send drops them in and hands the
// whole text to onSend. The field grows with its text, since a dictated
// answer is rarely one line, but Enter never adds a line: it keeps the
// single-line field's behaviour (onKeyDown first, then submit the form).
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Mic } from "lucide-react";
import { DictationBar } from "./dictation-bar";

export function DictationField({
  value,
  onChange,
  onSend,
  fieldRef,
  maxLength,
  disabled,
  onKeyDown,
  className = "",
  ...rest
}: {
  value: string;
  onChange: (value: string) => void;
  /** Send on the dictation bar: the field's full text, dictation included. */
  onSend: (text: string) => void;
  fieldRef?: RefObject<HTMLTextAreaElement | null>;
  maxLength?: number;
  disabled?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  className?: string;
  id?: string;
  placeholder?: string;
  "aria-label"?: string;
  enterKeyHint?: "send" | "done" | "enter" | "go" | "next" | "previous" | "search";
  autoComplete?: string;
  "data-own-field"?: boolean;
}) {
  const [dictating, setDictating] = useState(false);
  const [error, setError] = useState("");
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = fieldRef ?? ownRef;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value, dictating]);

  if (dictating) {
    return (
      <div className="flex flex-col gap-1">
        <DictationBar
          onCancel={() => setDictating(false)}
          onText={(text, andSend) => {
            const joined = value.trim() ? `${value.trim()} ${text}` : text;
            const full = maxLength ? joined.slice(0, maxLength) : joined;
            setDictating(false);
            onChange(full);
            if (andSend && full.trim()) onSend(full);
          }}
          onError={(message) => {
            setError(message);
            setDictating(false);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          maxLength={maxLength}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.replace(/\n/g, " "))}
          onKeyDown={(e) => {
            onKeyDown?.(e);
            if (e.key === "Enter" && !e.shiftKey && !e.defaultPrevented) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          {...rest}
          className={`block w-full resize-none py-2.5 pr-11 leading-[1.4] ${className}`}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setError("");
            setDictating(true);
          }}
          title="Dictate"
          aria-label="Dictate your answer"
          className="absolute bottom-1 right-1 flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-card hover:text-ink disabled:opacity-50"
        >
          <Mic size={18} strokeWidth={1.75} />
        </button>
      </div>
      {error && <p className="px-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
