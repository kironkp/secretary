"use client";

// The thinking strip: the one place a screen shows what Secretary is doing
// with the data. Kiron's words: "There should be an interface above the
// questions that shows what the agent is thinking. It animates and moves
// after each answer to show that it's parsing that data." Above the hero on
// Today, above the card on the Interview and on an opened question.
//
// The server authors every line (GET /api/understanding/progress): what is
// being read, thought about, checked and written, and how the last run
// ended. The screen adds only the lines it alone knows, "Applying your
// answer" and the receipt, in the moment before the server has anything;
// they arrive as `activity`, and the server's lines take over from them.
// The strip never blocks: the pills stay live under it.
//
// Four states, on data-phase: idle (the last run, faint and still), active
// (the bars bobbing in the tint under the current line), failed (the newest
// run that failed in the last 5 minutes, in the warn colour, with the way to
// fix it), paused (the model cannot be called, with the same way out). Each
// change of the main line is a swap: the old line rises 8px and fades over
// 200 ms, the new one rises from 8px below over 340 ms on the nav-tabs
// easing (globals.css, "The thinking strip"); a line holds for a beat before
// the next replaces it, so a run that fails in a second still reads as a
// sequence. Reduced motion makes the swap instant and stills the bars.
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
// Types only from the server's modules: erased at build time, so nothing
// server-side crosses into this client component, and the contract has one
// definition, the server's.
import type { ActiveEntry, RecentEntry } from "@/lib/understanding/progress";
import type { ProviderHealth, ProviderStatus } from "@/lib/understanding/provider-health";
import type { LastRun } from "@/lib/understanding/sweep";
import { agoInWords } from "./copy";

// --- The contract: GET /api/understanding/progress -------------------------

export type ProviderState = ProviderStatus["state"];
export type ProviderSide = ProviderStatus;

export type Progress = {
  /** The runs in flight, oldest first. */
  active: ActiveEntry[];
  /** Finished in the last 5 minutes, newest first. */
  recent: RecentEntry[];
  /** The newest run of this user, whatever its age. */
  lastRun: LastRun | null;
  provider: ProviderHealth;
};

export const PROGRESS_URL = "/api/understanding/progress";
/** Where the action line points: the Model row at the top of Settings' Understanding section. */
export const SETTINGS_HREF = "/settings#understanding";

/** While something is under way the server is asked this often; otherwise this. */
export const FAST_POLL_MS = 1_500;
export const SLOW_POLL_MS = 30_000;
/** How long the screen's own answer keeps the strip live without a word from the server. */
export const ACTIVITY_MS = 90_000;
/** A line is on screen at least this long before the next one replaces it. */
export const DWELL_MS = 1_200;
/** The main line's swap (globals.css): the old line is gone after this. */
const LEAVE_MS = 200;
const GLIDE_MS = 340;
const GLIDE_EASE = "cubic-bezier(0.22, 0.9, 0.32, 1)";

/**
 * What the screen itself knows: the answer it just sent, or the reading it
 * asked for. A new `startedAt` is a new activity and shows at once (the
 * acknowledgement within 200 ms of the tap); a changed `line` on the same
 * activity is the next thing to say. `done` closes the window before the
 * server has said anything (nothing was written, or the summary landed);
 * `failed` is the screen's own failure, shown in the failed state with the
 * server's way out.
 */
export type StripActivity = {
  line: string;
  detail?: string | null;
  startedAt: number;
  /** The project being re-read, so the strip follows that entry when several are under way. */
  projectId?: string | null;
  status?: "active" | "failed" | "done";
};

export type StripPhase = "idle" | "active" | "failed" | "paused";

type Shown = {
  phase: StripPhase;
  line: string;
  detail: string | null;
  /** The way out, as a link to Settings. */
  action: string | null;
  /** The main line's colour: the warn tone for a failure the user can act on. */
  tone: "ink" | "warn";
  /** Whose words: the screen's own two lines each get their beat; the server's collapse to the latest. */
  source: "local" | "server";
};

const NOTHING: Shown = { phase: "idle", line: "", detail: null, action: null, tone: "ink", source: "server" };

/** What the screenshot hooks show, with nothing polled (see `preview` below). */
const PREVIEW: Record<string, Shown> = {
  open: {
    phase: "active",
    line: "Reading Caltrans",
    detail: "43 tasks, 12 messages",
    action: null,
    tone: "ink",
    source: "server",
  },
  failed: {
    phase: "failed",
    line: "Could not read Caltrans",
    detail: "the model has no credits",
    action: "Add credits, raise the limit, or connect your own key in Settings.",
    tone: "warn",
    source: "server",
  },
};

const HEIGHTS = [10, 22, 16, 26, 14, 20];

/** The newest finished stamp the payload carries; what an answer's watch is measured from. */
function latestStamp(p: Progress): string | null {
  const stamps = [p.lastRun?.finishedAt ?? null, ...p.recent.map((r) => r.finishedAt)].filter(
    (s): s is string => !!s
  );
  return stamps.length ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
}

/** A run finished after the watch began: the payload carries a stamp later than `since`. */
function landedSince(p: Progress, since: string | null): boolean {
  const latest = latestStamp(p);
  if (!latest) return false;
  return since === null ? true : latest > since;
}

/**
 * The server's entry to follow: the answered project's when it is under way,
 * else the one touched last (a reading of every project runs them in turn).
 */
function pickActive(entries: Progress["active"], projectId: string | null | undefined) {
  if (entries.length === 0) return null;
  const own = projectId ? entries.find((e) => e.projectId === projectId) : null;
  return own ?? entries.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));
}

/**
 * The answer's watch: from the moment the screen's activity began, what
 * "finished since then" is measured against. `since` is the newest stamp the
 * strip had seen at that moment (a stamp, not a clock, so the phone's and
 * the server's clocks never have to agree); unknown until the first payload
 * when the tap came before one. `sawActive` says the server has shown this
 * run under way, so its going quiet is the run being over.
 */
type Watch = { startedAt: number; since: string | null | undefined; sawActive: boolean };

function isOver(activity: StripActivity, watch: Watch, progress: Progress | null, now: number): boolean {
  if (activity.status === "done") return true;
  if (now - activity.startedAt >= ACTIVITY_MS) return true;
  if (!progress) return false;
  if (watch.sawActive && progress.active.length === 0) return true;
  if (watch.since === undefined) return false;
  return landedSince(progress, watch.since);
}

function derive(progress: Progress | null, activity: StripActivity | null, watch: Watch | null, now: number): Shown {
  const server = { action: null, tone: "ink", source: "server" } as const;
  const entry = pickActive(progress?.active ?? [], activity?.projectId);
  if (entry) return { ...server, phase: "active", line: entry.line, detail: entry.detail };
  if (activity && watch && !isOver(activity, watch, progress, now)) {
    if (activity.status === "failed") {
      return {
        phase: "failed",
        line: activity.line,
        detail: activity.detail ?? null,
        action: progress?.provider.action ?? null,
        tone: "warn",
        source: "local",
      };
    }
    return { ...server, phase: "active", line: activity.line, detail: activity.detail ?? null, source: "local" };
  }
  if (!progress) return NOTHING;
  const newest = progress.recent[0];
  if (newest?.status === "failed") {
    return {
      ...server,
      phase: "failed",
      line: newest.line,
      detail: newest.detail,
      action: progress.provider.action,
      tone: "warn",
    };
  }
  if (!progress.provider.ok) {
    return {
      ...server,
      phase: "paused",
      line: progress.provider.line ?? "Reading is paused.",
      detail: null,
      action: progress.provider.action,
      tone: "warn",
    };
  }
  const last = progress.lastRun;
  if (!last) return { ...server, phase: "idle", line: "Nothing read yet", detail: null };
  const ago = agoInWords(last.finishedAt, now);
  return {
    ...server,
    phase: "idle",
    line: last.line,
    detail: last.detail ? `${last.detail}, ${ago}` : ago,
    tone: last.status === "failed" ? "warn" : "ink",
  };
}

/**
 * The poll. Every FAST_POLL_MS while `fast`, every SLOW_POLL_MS otherwise;
 * at once on focus and on "secretary:data-changed" (an answer just sent, a
 * voice answer landing); paused while the tab is hidden. When a run has
 * finished since the last look, the questions it wrote are on the server,
 * so the strip says "data changed" and every screen listening refreshes.
 */
function useProgress(fast: boolean, enabled: boolean): Progress | null {
  const [progress, setProgress] = useState<Progress | null>(null);
  const seen = useRef<Progress | null>(null);
  const inflight = useRef(false);

  const fetchNow = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const res = await fetch(PROGRESS_URL, { cache: "no-store" });
      if (!res.ok) return;
      const next = (await res.json()) as Progress;
      const prev = seen.current;
      seen.current = next;
      setProgress(next);
      if (prev && next.lastRun && next.lastRun.finishedAt !== prev.lastRun?.finishedAt) {
        window.dispatchEvent(new Event("secretary:data-changed"));
      }
    } catch {
      // Nothing to say; the next poll is soon.
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const pause = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const run = () => {
      pause();
      timer = setInterval(() => void fetchNow(), fast ? FAST_POLL_MS : SLOW_POLL_MS);
    };
    const resume = () => {
      if (document.hidden) return;
      void fetchNow();
      run();
    };
    const onVisibility = () => (document.hidden ? pause() : resume());
    const onChanged = () => void fetchNow();
    resume();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", resume);
    window.addEventListener("secretary:data-changed", onChanged);
    return () => {
      pause();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", resume);
      window.removeEventListener("secretary:data-changed", onChanged);
    };
  }, [enabled, fast, fetchNow]);

  return progress;
}

/**
 * The clock the strip reads. A render must be pure, so the time is an
 * external store: it moves every half minute for the "12 min ago" line
 * (while any strip is mounted), and when a strip asks (`bump`) at the
 * moment its answer's window closes. Before hydration it reads 0.
 */
const clock = (() => {
  let value = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<() => void>();
  const bump = () => {
    value = Date.now();
    listeners.forEach((l) => l());
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        bump();
        timer = setInterval(bump, SLOW_POLL_MS);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    read: () => value,
    server: () => 0,
    bump,
  };
})();

export function ThinkingStrip({
  activity = null,
  className = "",
}: {
  activity?: StripActivity | null;
  className?: string;
}) {
  // `?thinking=open` and `?thinking=failed` show the active and the failed
  // state with nothing polled and nothing sent: how e2e/screens.spec.ts
  // photographs them, since CI has no model. Like ?own=open it cannot be
  // gated on NODE_ENV (the browser specs run the production build) and is
  // harmless anywhere: it shows two lines.
  const preview = PREVIEW[useSearchParams().get("thinking") ?? ""] ?? null;
  const startedAt = activity?.startedAt ?? null;

  // The answer's window: the strip is live, and polls fast, until this.
  const cap = activity && activity.status !== "done" ? activity.startedAt + ACTIVITY_MS : null;
  const now = useSyncExternalStore(clock.subscribe, clock.read, clock.server);
  const progress = useProgress(cap !== null && now < cap, !preview);
  // The window closing on its own (nothing from the server) is a timed change.
  useEffect(() => {
    if (cap === null) return;
    const t = setTimeout(clock.bump, Math.max(0, cap - Date.now()) + 10);
    return () => clearTimeout(t);
  }, [cap]);

  // The answer's watch, begun with each new activity (derived during render,
  // so the acknowledgement is in the same commit as the tap's state).
  const [watch, setWatch] = useState<Watch | null>(null);
  if (activity && (!watch || watch.startedAt !== activity.startedAt)) {
    setWatch({ startedAt: activity.startedAt, since: progress ? latestStamp(progress) : undefined, sawActive: false });
  } else if (watch && progress) {
    // The first payload after a tap that came before one: measured from here.
    if (watch.since === undefined) setWatch({ ...watch, since: latestStamp(progress) });
    else if (!watch.sawActive && progress.active.length > 0) setWatch({ ...watch, sawActive: true });
  }

  const want = preview ?? derive(progress, activity, watch, now);

  // The dwell: a line stays at least DWELL_MS before the next replaces it,
  // so a run that fails in a second still reads as a sequence. Lines wait
  // their turn in a short queue: the screen's own two ("Applying your
  // answer", the receipt) each get their beat, the server's collapse to the
  // latest, and a new activity (a fresh tap) drops the queue and shows at
  // once. A change of detail alone (the count, "attempt 2 of 2", the
  // minutes) shows at once. A layout effect, so the acknowledgement is
  // painted in the tap's frame.
  const [held, setHeld] = useState<Shown>(want);
  const dwell = useRef<{
    shown: Shown;
    since: number;
    startedAt: number | null;
    pending: Shown[];
    timer: ReturnType<typeof setTimeout> | null;
    /** The screen's own lines already shown for this tap, so each gets one beat and no more. */
    localShown: Set<string>;
  }>({ shown: want, since: 0, startedAt, pending: [], timer: null, localShown: new Set() });
  const { phase, line, detail, action, tone, source } = want;
  useLayoutEffect(() => {
    const next: Shown = { phase, line, detail, action, tone, source };
    const st = dwell.current;
    const sameLine = (a: Shown, b: Shown) => a.line === b.line && a.phase === b.phase;
    const show = (item: Shown) => {
      st.shown = item;
      st.since = Date.now();
      st.startedAt = startedAt;
      if (item.source === "local") st.localShown.add(item.line);
      setHeld(item);
    };
    const pump = () => {
      st.timer = null;
      const item = st.pending.shift();
      if (!item) return;
      show(item);
      if (st.pending.length) st.timer = setTimeout(pump, DWELL_MS);
    };
    const schedule = () => {
      if (st.timer) return;
      const wait = st.since + DWELL_MS - Date.now();
      if (wait <= 0) pump();
      else st.timer = setTimeout(pump, wait);
    };
    if (startedAt !== st.startedAt) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      st.pending = [];
      st.localShown = new Set();
      show(next);
      return;
    }
    // The screen's own line when the server has already taken the floor:
    // derive() prefers the server's entry, so the receipt ("Closed 1 task")
    // would never be asked for once a poll has shown the run under way. It
    // still gets its beat, ahead of whatever the server says next.
    const own =
      activity && activity.startedAt === startedAt && (activity.status ?? "active") === "active"
        ? activity.line
        : null;
    if (
      next.source === "server" &&
      own &&
      !st.localShown.has(own) &&
      own !== st.shown.line &&
      !st.pending.some((p) => p.line === own)
    ) {
      const item: Shown = {
        phase: "active",
        line: own,
        detail: activity?.detail ?? null,
        action: null,
        tone: "ink",
        source: "local",
      };
      const firstServer = st.pending.findIndex((p) => p.source === "server");
      if (firstServer === -1) st.pending.push(item);
      else st.pending.splice(firstServer, 0, item);
      schedule();
    }
    const tail = st.pending[st.pending.length - 1];
    if (tail ? sameLine(next, tail) : sameLine(next, st.shown)) {
      if (tail) st.pending[st.pending.length - 1] = next;
      else if (
        next.detail !== st.shown.detail ||
        next.action !== st.shown.action ||
        next.tone !== st.shown.tone
      ) {
        st.shown = next;
        setHeld(next);
      }
      return;
    }
    if (tail && tail.source === "server" && next.source === "server") st.pending[st.pending.length - 1] = next;
    else st.pending.push(next);
    schedule();
  }, [phase, line, detail, action, tone, source, startedAt, activity]);
  useEffect(() => {
    const st = dwell.current;
    return () => {
      if (st.timer) clearTimeout(st.timer);
    };
  }, []);

  const shown = held;
  const live = shown.phase === "active";

  // --- The main line's swap: the old line fades up over the new one. ---
  const [swap, setSwap] = useState<{ line: string; ghost: string | null; n: number; animate: boolean }>({
    line: shown.line,
    ghost: null,
    n: 0,
    animate: false,
  });
  if (swap.line !== shown.line) {
    // The first real line (the payload landing on an empty strip) is not a change to animate.
    setSwap({ line: shown.line, ghost: swap.line || null, n: swap.n + 1, animate: swap.line !== "" });
  }
  useEffect(() => {
    if (!swap.ghost) return;
    const t = setTimeout(() => setSwap((s) => (s.n === swap.n ? { ...s, ghost: null } : s)), LEAVE_MS);
    return () => clearTimeout(t);
  }, [swap.n, swap.ghost]);

  // The text block's height glides between lines (a detail appearing, a
  // line wrapping, the way out arriving), so the card below moves with it
  // instead of jumping. A CSS transition: reduced motion makes it instant.
  const textRef = useRef<HTMLDivElement>(null);
  const lastHeight = useRef<number | null>(null);
  const shape = `${swap.n}|${shown.detail ?? ""}|${shown.action ?? ""}`;
  const committed = useRef(shape);
  useLayoutEffect(() => {
    if (committed.current === shape) return;
    committed.current = shape;
    const block = textRef.current;
    const from = lastHeight.current;
    const to = block?.offsetHeight ?? null;
    if (!block || from === null || to === null || from === to) return;
    block.style.transition = "none";
    block.style.overflow = "hidden";
    block.style.height = `${from}px`;
    void block.offsetHeight; // commit the starting height before it moves
    block.style.transition = `height ${GLIDE_MS}ms ${GLIDE_EASE}`;
    block.style.height = `${to}px`;
    const done = () => {
      block.style.transition = "";
      block.style.overflow = "";
      block.style.height = "";
    };
    const t = setTimeout(done, GLIDE_MS + 40);
    return () => {
      clearTimeout(t);
      done();
    };
  }, [shape]);
  useLayoutEffect(() => {
    lastHeight.current = textRef.current?.offsetHeight ?? null;
  });

  const lineTone = shown.tone === "warn" ? "text-warn" : "text-ink";

  return (
    <section
      data-thinking-strip
      data-phase={shown.phase}
      className={`flex items-center gap-3 rounded-2xl bg-card px-4 py-3 ${className}`}
    >
      <span
        className={`flex h-7 flex-none items-center gap-[5px] ${live ? "thinking-live" : ""}`}
        aria-hidden
      >
        {HEIGHTS.map((h, i) => (
          <span
            key={i}
            className={`thinking-bar block w-[5px] rounded-[3px] transition-colors duration-200 ${
              live ? "bg-accent" : "bg-faint/40"
            }`}
            style={{ height: h, animationDelay: `${i * 0.12}s` }}
          />
        ))}
      </span>
      <div ref={textRef} className="min-w-0 flex-1">
        <p
          role="status"
          aria-live="polite"
          data-line={shown.line}
          className={`relative text-[15px] leading-[1.3] wrap-anywhere ${lineTone}`}
        >
          {swap.ghost && (
            <span aria-hidden className="strip-line-leave block">
              {swap.ghost}
            </span>
          )}
          {/* A non-breaking space holds the line's height before the first payload. */}
          <span key={swap.n} className={`block ${swap.animate ? "strip-line-enter" : ""}`}>
            {shown.line || " "}
          </span>
        </p>
        {/* The detail line keeps its height when there is nothing to say, so
            the strip stays one size through "Applying your answer", the
            receipt and the server's phases, and the card below stays put. */}
        <p
          key={`d-${shown.detail ?? ""}`}
          data-detail={shown.detail ?? undefined}
          className={`min-h-[1.3em] text-[13px] leading-[1.3] text-faint wrap-anywhere ${
            swap.animate && shown.detail ? "strip-detail-enter" : ""
          }`}
        >
          {shown.detail ?? "\u00a0"}
        </p>
        {shown.action && (
          <Link
            href={SETTINGS_HREF}
            data-action
            className="-my-2 inline-flex min-h-11 items-center text-[13px] leading-[1.3] text-accent wrap-anywhere"
          >
            {shown.action}
          </Link>
        )}
      </div>
    </section>
  );
}
