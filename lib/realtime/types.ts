// VoiceProvider interface — UI-free, framework-agnostic (V-5). The React app,
// and later React Native / native shells, consume this. Swapping providers
// (Gemini Live, ElevenLabs…) means implementing this interface, nothing more.

export type VoiceStatus =
  | "idle"
  | "requesting-mic"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "error";

export type VoiceErrorKind =
  | "mic-denied"
  | "quota"
  | "disabled"
  | "network"
  | "unknown";

export type ToolToast = { icon: string; text: string };

/** What a call is for, when it is not an ordinary one. "interview" is the orb
 *  on the Interview tab (lib/secretary/interview-voice.ts). Kept here, not
 *  imported from the server module, so this file stays UI- and server-free. */
export type VoiceFlavor = "interview";

/** UI-only side channel on a tool outcome (SPEC §7.6 auto-open) — the shell
 *  acts on it; the model never sees it. */
export type ToolUIAction = { type: "show_canvas" };

export type VoiceEvents = {
  status: (status: VoiceStatus, detail?: { kind?: VoiceErrorKind; message?: string }) => void;
  // id = the server's item/response id: transcript lines are keyed by it so
  // interleaved streams (barge-in) can never fragment or double.
  userTranscript: (id: string, text: string, final: boolean) => void;
  assistantTranscript: (id: string, text: string, final: boolean) => void;
  assistantSpeaking: (speaking: boolean) => void;
  /** A tool call left for the server: the model is waiting on it (the pause). */
  toolStarted: (name: string) => void;
  toolResult: (name: string, toast?: ToolToast, uiAction?: ToolUIAction) => void;
  modelChanged: (model: string) => void;
};

export interface VoiceProvider {
  connect(opts: { model: string }): Promise<void>;
  disconnect(): Promise<void>;
  setMuted(muted: boolean): void;
  switchModel(model: string): Promise<void>;
  readonly status: VoiceStatus;
  readonly model: string | null;
  readonly conversationId: string | null;
  /** Local mic stream (for level visualisation). Null until connected. */
  readonly micStream: MediaStream | null;
  /** Remote assistant audio stream. Null until first audio arrives. */
  readonly remoteStream: MediaStream | null;
  on<K extends keyof VoiceEvents>(event: K, handler: VoiceEvents[K]): () => void;
}
