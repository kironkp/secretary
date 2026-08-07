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

export type VoiceEvents = {
  status: (status: VoiceStatus, detail?: { kind?: VoiceErrorKind; message?: string }) => void;
  userTranscript: (text: string, final: boolean) => void;
  assistantTranscript: (text: string, final: boolean) => void;
  assistantSpeaking: (speaking: boolean) => void;
  toolResult: (name: string, toast?: ToolToast) => void;
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
