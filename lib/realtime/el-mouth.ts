// The ElevenLabs mouth: turns streamed assistant TEXT into spoken audio.
// Sentence-level pipeline: text deltas → sentence cuts → POST /api/elevenlabs/tts
// → decode → gapless queued playback via WebAudio. Barge-in flushes everything.
// Pure client-side; the API key lives behind the proxy route.

const SENTENCE_END = /([.!?…]+["')\]]?)\s+/;

/** Pure sentence cutter: returns [completeSentences, remainingBuffer]. */
export function cutSentences(buffer: string): [string[], string] {
  const sentences: string[] = [];
  let rest = buffer;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_END.exec(rest))) {
    const sentence = rest.slice(0, match.index + match[1].length).trim();
    rest = rest.slice(match.index + match[0].length);
    if (sentence) sentences.push(sentence);
  }
  return [sentences, rest];
}

export class ElevenLabsMouth {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private queue: AudioBuffer[] = [];
  private pending = 0;
  private current: AudioBufferSourceNode | null = null;
  private buffer = "";
  private generation = 0; // bumped on flush — stale fetches are dropped
  private levelData: Uint8Array<ArrayBuffer> | null = null;
  onSpeakingChange?: (speaking: boolean) => void;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.ctx.destination);
      this.levelData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    }
    void this.ctx.resume();
    return this.ctx;
  }

  /** Feed a text delta; complete sentences are spoken as they form. */
  pushDelta(delta: string) {
    const [sentences, rest] = cutSentences(this.buffer + delta);
    this.buffer = rest;
    for (const sentence of sentences) void this.speak(sentence);
  }

  /** The response is done — speak whatever remains in the buffer. */
  flushFinal() {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) void this.speak(rest);
  }

  /** Barge-in: stop everything, drop the queue and any in-flight fetches. */
  interrupt() {
    this.generation++;
    this.buffer = "";
    this.queue = [];
    this.pending = 0;
    try {
      this.current?.stop();
    } catch {
      /* already stopped */
    }
    this.current = null;
    this.onSpeakingChange?.(false);
  }

  /** 0..1 output level for the orb. */
  level(): number {
    if (!this.analyser || !this.levelData) return 0;
    this.analyser.getByteFrequencyData(this.levelData);
    let sum = 0;
    for (const v of this.levelData) sum += v;
    return sum / (this.levelData.length * 255);
  }

  get speaking(): boolean {
    return this.current !== null || this.queue.length > 0 || this.pending > 0;
  }

  private async speak(sentence: string) {
    const gen = this.generation;
    this.pending++;
    try {
      const res = await fetch("/api/elevenlabs/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sentence }),
      });
      if (!res.ok) return;
      const bytes = await res.arrayBuffer();
      if (gen !== this.generation) return; // interrupted while fetching
      const buffer = await this.ensureCtx().decodeAudioData(bytes);
      if (gen !== this.generation) return;
      this.queue.push(buffer);
      this.playNext();
    } catch (e) {
      console.warn("el-mouth speak failed:", e);
    } finally {
      this.pending = Math.max(0, this.pending - 1);
    }
  }

  private playNext() {
    if (this.current) return; // already playing; onended chains
    const next = this.queue.shift();
    if (!next) {
      this.onSpeakingChange?.(false);
      return;
    }
    const ctx = this.ensureCtx();
    const source = ctx.createBufferSource();
    source.buffer = next;
    source.connect(this.analyser!);
    source.onended = () => {
      this.current = null;
      this.playNext();
    };
    this.current = source;
    this.onSpeakingChange?.(true);
    source.start();
  }

  dispose() {
    this.interrupt();
    void this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
  }
}
