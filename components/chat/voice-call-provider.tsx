"use client";

// Global voice call (multitasking): the session lives HERE, in the app shell —
// not inside the chat page — so switching tabs never hangs up. The call UI is
// either the full-screen view or a floating pill that rides above every page;
// the chat thread reads the live transcript from this context when visible.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { VoiceFlavor } from "@/lib/realtime/types";
import { useVoiceSession } from "./use-voice-session";
import { VoiceMode } from "./voice-mode";

type BeginOpts = { voice?: string; effort?: string; minimized?: boolean; flavor?: VoiceFlavor };

type VoiceCallContextValue = {
  /** A call is live (or connecting). */
  active: boolean;
  session: ReturnType<typeof useVoiceSession>;
  begin: (opts?: BeginOpts) => void;
  /** Hang up the live call, from a surface other than the call UI (the orb). */
  end: () => Promise<void>;
  /** What the live call is for; undefined for an ordinary call or none. */
  flavor: VoiceFlavor | undefined;
  /**
   * A surface that draws the call itself (the interview orb) claims it while
   * mounted, and the call UI draws nothing meanwhile. Returns the release:
   * leave the page and the call carries on in the ordinary floating pill.
   */
  hostCall: () => () => void;
  /** Bumped when a call ends; carries the conversation to reload. */
  ended: { conversationId: string | null; seq: number } | null;
};

const VoiceCallContext = createContext<VoiceCallContextValue | null>(null);

export function useVoiceCall(): VoiceCallContextValue {
  const ctx = useContext(VoiceCallContext);
  if (!ctx) throw new Error("useVoiceCall outside VoiceCallProvider");
  return ctx;
}

export function VoiceCallProvider({ children }: { children: ReactNode }) {
  const session = useVoiceSession();
  const [active, setActive] = useState(false);
  const [opts, setOpts] = useState<BeginOpts>({});
  const [ended, setEnded] = useState<VoiceCallContextValue["ended"]>(null);
  const [callKey, setCallKey] = useState(0);

  const begin = useCallback((o: BeginOpts = {}) => {
    setOpts(o);
    setCallKey((k) => k + 1); // fresh VoiceMode mount per call → clean start
    setActive(true);
  }, []);

  const close = useCallback((conversationId: string | null) => {
    setActive(false);
    setEnded((prev) => ({ conversationId, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  const { end: endSession } = session;
  const end = useCallback(async () => {
    close(await endSession());
  }, [close, endSession]);

  const [hosts, setHosts] = useState(0);
  const hostCall = useCallback(() => {
    setHosts((n) => n + 1);
    return () => setHosts((n) => Math.max(0, n - 1));
  }, []);

  const flavor = active ? opts.flavor : undefined;
  const value = useMemo(
    () => ({ active, session, begin, end, flavor, hostCall, ended }),
    [active, session, begin, end, flavor, hostCall, ended]
  );

  return (
    <VoiceCallContext.Provider value={value}>
      {children}
      {active && (
        <VoiceMode
          key={callKey}
          session={session}
          onClose={close}
          defaultVoice={opts.voice ?? "marin"}
          defaultEffort={opts.effort ?? "auto"}
          startMinimized={opts.minimized}
          flavor={opts.flavor}
          hidden={hosts > 0 && Boolean(opts.flavor)}
        />
      )}
    </VoiceCallContext.Provider>
  );
}
