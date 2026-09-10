"use client";

// Canvas performance instrumentation.
//
// The open question is whether 8–12 sandboxed frames stay smooth on a 2015-era
// iPhone. Rather than redesign the renderer on a guess, measure it: this
// records what actually happens on the device and shows it on screen with
// ?perf=1, so a two-minute test answers the question with numbers.
//
// Deliberately cheap: no network, no storage, a bounded ring of samples, and
// everything guarded so an unsupported API degrades to "not measured" rather
// than breaking the canvas.

export type PerfSnapshot = {
  blocks: number;
  frames: number;
  docsWired: number;
  checksFired: number;
  /** First block document painted, from navigation start. */
  firstRenderMs: number | null;
  /** Slowest and mean iframe load. */
  frameLoadMs: { mean: number; max: number; n: number } | null;
  /** Voice/tap → first visible movement. The headline Jarvis number. */
  opLatencyMs: { last: number | null; mean: number; max: number; n: number };
  /** Tasks over 50ms — the thing that actually makes a phone feel stuck. */
  longTasks: { count: number; totalMs: number; maxMs: number };
  /** Frames slower than ~2 display refreshes during an animation. */
  jank: { sampled: number; slow: number };
  memoryMB: number | null;
};

const MAX_SAMPLES = 60;

function ring(): { push: (v: number) => void; stats: () => { mean: number; max: number; n: number } } {
  const values: number[] = [];
  return {
    push(v) {
      values.push(v);
      if (values.length > MAX_SAMPLES) values.shift();
    },
    stats() {
      if (!values.length) return { mean: 0, max: 0, n: 0 };
      const sum = values.reduce((a, b) => a + b, 0);
      return { mean: Math.round(sum / values.length), max: Math.round(Math.max(...values)), n: values.length };
    },
  };
}

class CanvasPerf {
  blocks = 0;
  frames = 0;
  /** Documents the shell successfully attached its click handling to. If this
   *  is 0 while blocks > 0, the canvas is rendering but is not interactive —
   *  which is exactly the failure that made checkboxes unclickable. */
  docsWired = 0;
  /** Checkbox clicks that reached the handler. 0 after tapping one means the
   *  event never arrived; >0 with nothing happening means the server call is
   *  the problem. This single number separates the two. */
  checksFired = 0;
  firstRenderMs: number | null = null;
  private frameLoads = ring();
  private opLatencies = ring();
  private lastOp: number | null = null;
  private opStartedAt: number | null = null;
  longTasks = { count: 0, totalMs: 0, maxMs: 0 };
  jank = { sampled: 0, slow: 0 };
  private observer: PerformanceObserver | null = null;
  private rafId: number | null = null;
  private listeners = new Set<() => void>();

  start() {
    if (typeof window === "undefined" || this.observer) return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks.count++;
          this.longTasks.totalMs += entry.duration;
          this.longTasks.maxMs = Math.max(this.longTasks.maxMs, entry.duration);
        }
        this.emit();
      });
      // Safari has historically not supported longtask; the try/catch is why.
      this.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      this.observer = null;
    }
  }

  stop() {
    this.observer?.disconnect();
    this.observer = null;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  /** Sample frame pacing across one animation, not continuously — a permanent
   *  rAF loop would itself be the performance problem. */
  sampleFrames(durationMs = 700) {
    if (typeof window === "undefined" || this.rafId !== null) return;
    let last = performance.now();
    const until = last + durationMs;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      this.jank.sampled++;
      if (dt > 32) this.jank.slow++; // ~2 frames at 60Hz
      if (now < until) this.rafId = requestAnimationFrame(tick);
      else {
        this.rafId = null;
        this.emit();
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  frameLoaded(ms: number) {
    this.frames++;
    this.frameLoads.push(ms);
    if (this.firstRenderMs === null) this.firstRenderMs = Math.round(performance.now());
    this.emit();
  }

  /** Call the instant an operation is REQUESTED (tap, or the tool result
   *  arriving), then again when the DOM actually moves. */
  opStarted() {
    this.opStartedAt = performance.now();
    this.sampleFrames();
  }

  opPainted() {
    if (this.opStartedAt === null) return;
    const ms = performance.now() - this.opStartedAt;
    this.opStartedAt = null;
    this.lastOp = Math.round(ms);
    this.opLatencies.push(ms);
    this.emit();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  snapshot(): PerfSnapshot {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      blocks: this.blocks,
      frames: this.frames,
      docsWired: this.docsWired,
      checksFired: this.checksFired,
      firstRenderMs: this.firstRenderMs,
      frameLoadMs: this.frameLoads.stats().n ? this.frameLoads.stats() : null,
      opLatencyMs: { last: this.lastOp, ...this.opLatencies.stats() },
      longTasks: {
        count: this.longTasks.count,
        totalMs: Math.round(this.longTasks.totalMs),
        maxMs: Math.round(this.longTasks.maxMs),
      },
      jank: this.jank,
      memoryMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    };
  }
}

export const canvasPerf = new CanvasPerf();

/** ?perf=1 turns the overlay on. Off by default and zero-cost when off. */
export function perfEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("perf") === "1";
}
