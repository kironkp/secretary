"use client";

// The Attach sheet from the "Secretary on iPhone" mockup: the plus in the ask
// bar opens it. A dim over the page, and at the bottom, iOS action-sheet
// style, a white group — "Add to your message", then Photo Library, Take
// Photo, Choose File in the tint — a second group with the Model row, and a
// separate Cancel. The mockup's numbers, in pixels: 8px side insets, 10px
// bottom inset, 14px radius, a 13px title, 56px rows at 19px with a 24px
// icon, a 0.5px hairline between rows, a 17px grey value on the Model row.
//
// The Model row's "›" leads to a second page of the same sheet, in the same
// system: a "Model" group and an "Effort" group of 56px rows with a check on
// the chosen one, and "Back" where Cancel was. The composer's chip shows the
// same choice (model-chip.tsx useChatModel); a pick here is persisted the
// same way, so nothing on this page is styled as the chip's popover.
//
// Rendered through a portal: the dock it is opened from sits in a
// backdrop-blur slab, and a blurred ancestor is the containing block for a
// fixed child, so drawn in place the sheet would be clipped to the dock.
//
// Three hidden file inputs, one per row, because the row is what decides what
// iOS presents: `accept="image/*"` is the photo library, `capture` is the
// camera, and no accept at all is the Files app with every type selectable
// (an accept entry iOS cannot map to a UTI greys the file out — that is why
// .xlsx used to be unpickable).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { CHAT_MODEL_OPTIONS, type ChatModelSelection } from "./model-chip";

/** How long the sheet takes to slide; the unmount waits this long after close. */
const SLIDE_MS = 200;

/** The mockup's icons, 24px, stroke 1.8. Redrawn here rather than pulled from
 *  lucide so the sheet is the picture the user approved, glyph for glyph. */
function PhotoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5-8 8" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden
    >
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden
    >
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5M10 13h6M10 17h6" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      aria-hidden
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}

/** A 56px row: icon, label, optional value. Rows after the first carry the
 *  hairline on their top edge, full width, the way the mockup draws it. */
const ROW =
  "relative flex h-14 w-full items-center gap-3 px-[18px] text-left text-[19px] leading-none " +
  "[&+&]:before:absolute [&+&]:before:inset-x-0 [&+&]:before:top-0 [&+&]:before:h-[0.5px] [&+&]:before:bg-sep " +
  "active:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";
/** A group's title: the mockup's 13px grey line, centred, above the rows. */
const TITLE = "pb-1.5 pt-3 text-center text-[13px] leading-none text-faint";
/** The stand-alone button under the groups (Cancel, Back): 56px, 19px semibold tint. */
const PILL =
  "grid h-14 place-items-center rounded-[14px] bg-card text-[19px] font-semibold leading-none text-accent " +
  "active:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";
const GROUP = "overflow-hidden rounded-[14px] bg-card";

/** The check on the chosen row, or its 24px space, so labels line up across rows. */
function Chosen({ on }: { on: boolean }) {
  return (
    <span className="grid w-6 flex-none place-items-center text-accent" aria-hidden>
      {on && <Check size={22} strokeWidth={2.2} />}
    </span>
  );
}

export function AttachSheet({
  open,
  onClose,
  onFiles,
  selection,
  restoreFocusTo,
}: {
  open: boolean;
  onClose: () => void;
  /** A pick from any of the three rows; the sheet closes itself after. */
  onFiles: (files: File[]) => void;
  /** The thread's chat model, shared with the composer's chip. */
  selection: ChatModelSelection;
  /** The plus that opened the sheet: focus goes back there on close. */
  restoreFocusTo: React.RefObject<HTMLElement | null>;
}) {
  // `mounted` lags `open` on the way out so the slide-down can play; `shown`
  // lags it on the way in by one frame so the slide-up has a start position
  // to transition from. Both flip in callbacks, never in the effect body.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  // Which page the sheet is on; every opening starts on the attach page.
  const [page, setPage] = useState<"attach" | "model">("attach");
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setMounted(true);
      setPage("attach");
    } else {
      setShown(false);
    }
  }

  const sheetRef = useRef<HTMLDivElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const firstRowRef = useRef<HTMLButtonElement>(null);
  const firstModelRef = useRef<HTMLButtonElement>(null);
  // The close-side of the effect below must not run on first render — the
  // sheet starts closed, and "restore focus to the plus" then would steal
  // focus on page load.
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      // Focus lands on the first row of whichever page is showing: the sheet
      // is modal, and a page change is a new set of rows for the keyboard.
      const frame = requestAnimationFrame(() => {
        setShown(true);
        (page === "model" ? firstModelRef : firstRowRef).current?.focus({
          preventScroll: true,
        });
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const timer = setTimeout(() => setMounted(false), SLIDE_MS);
    // Focus returns to the plus that opened the sheet, if it is still on the
    // screen — after a file pick the composer replaces the ask bar, and then
    // there is nothing to return to.
    const plus = restoreFocusTo.current;
    if (plus?.isConnected) plus.focus({ preventScroll: true });
    return () => clearTimeout(timer);
  }, [open, page, restoreFocusTo]);

  // Escape closes; Tab stays inside the sheet (it is modal, and the page under
  // the dim must not take focus).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !sheetRef.current) return;
      const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !sheetRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !sheetRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted || typeof document === "undefined") return null;

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Copy the list before the reset: `input.files` is live, and clearing the
    // value empties it. The reset is what lets the same file be picked twice.
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length > 0) onFiles(files);
    onClose();
  };

  const motion = `transition-transform duration-200 ease-out motion-reduce:transition-none`;

  return createPortal(
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-40 bg-black/[0.38] transition-opacity duration-200 ease-out motion-reduce:transition-none ${
          shown ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={page === "model" ? "Model and effort" : "Add to your message"}
        data-testid="attach-sheet"
        data-page={page}
        className={`fixed inset-x-2 z-40 mx-auto flex max-w-2xl flex-col gap-2 overflow-y-auto ${motion}`}
        style={{
          bottom: "calc(env(safe-area-inset-bottom, 0px) + 10px)",
          // The Model page is ten rows tall; on a short phone it scrolls
          // inside the sheet rather than running under the status bar.
          maxHeight: "calc(100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 20px)",
          transform: shown
            ? "translateY(0)"
            : "translateY(calc(100% + env(safe-area-inset-bottom, 0px) + 10px))",
        }}
      >
        <input ref={libraryRef} type="file" accept="image/*" multiple className="hidden" onChange={pick} />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={pick}
        />
        <input ref={fileRef} type="file" multiple className="hidden" onChange={pick} />

        {page === "attach" ? (
          <>
            <div className={GROUP}>
              <p className={TITLE}>Add to your message</p>
              <button
                ref={firstRowRef}
                type="button"
                onClick={() => libraryRef.current?.click()}
                className={`${ROW} text-accent`}
              >
                <PhotoIcon />
                <span className="flex-1">Photo Library</span>
              </button>
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                className={`${ROW} text-accent`}
              >
                <CameraIcon />
                <span className="flex-1">Take Photo</span>
              </button>
              <button type="button" onClick={() => fileRef.current?.click()} className={`${ROW} text-accent`}>
                <FileIcon />
                <span className="flex-1">Choose File</span>
              </button>
            </div>

            <div className={GROUP}>
              <button
                type="button"
                onClick={() => setPage("model")}
                data-model-row
                className={`${ROW} text-ink`}
              >
                <ClockIcon />
                <span className="flex-1">Model</span>
                <span className="text-[17px] text-faint">
                  {selection.current.label}, {selection.effortLabel} ›
                </span>
              </button>
            </div>

            <button type="button" onClick={onClose} className={PILL}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <div className={GROUP}>
              <p className={TITLE}>Model</p>
              {CHAT_MODEL_OPTIONS.map((m, i) => (
                <button
                  key={m.id}
                  ref={i === 0 ? firstModelRef : undefined}
                  type="button"
                  onClick={() => selection.pickModel(m.id)}
                  aria-pressed={m.id === selection.model}
                  className={`${ROW} text-ink`}
                >
                  <span className="flex-1">{m.label}</span>
                  <span className="text-[17px] text-faint">{m.hint}</span>
                  <Chosen on={m.id === selection.model} />
                </button>
              ))}
            </div>

            <div className={GROUP}>
              <p className={TITLE}>Effort</p>
              {selection.ladder.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => selection.pickEffort(e.id)}
                  aria-pressed={e.id === selection.effort}
                  className={`${ROW} text-ink`}
                >
                  <span className="flex-1">{e.label}</span>
                  <Chosen on={e.id === selection.effort} />
                </button>
              ))}
              <p className="px-[18px] pb-3 pt-2 text-[13px] leading-[1.3] text-faint">
                Higher effort thinks longer before answering.
              </p>
            </div>

            <button type="button" onClick={() => setPage("attach")} data-model-back className={PILL}>
              Back
            </button>
          </>
        )}
      </div>
    </>,
    document.body,
  );
}
