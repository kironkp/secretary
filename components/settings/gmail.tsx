"use client";

// Gmail in Settings (SEC-A005): whether the secretary can read your inbox on
// request and save replies as drafts. It never sends. Connect is the same
// round trip as Calendar, asking for the Gmail scopes on top of what was
// granted (/api/google/calendar/connect?feature=gmail).
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Mail, MailX } from "lucide-react";

type Status =
  | { state: "not-connected" }
  | { state: "connected"; gmail: boolean }
  | { state: "disconnected"; gmail: boolean };

const OUTCOMES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Gmail is connected." },
  denied: { ok: false, text: "Gmail was not connected: access was declined on Google's page." },
  "scope-missing": {
    ok: false,
    text: "Gmail was not connected: a permission was unticked on Google's page. Connect again and leave both ticked.",
  },
  failed: { ok: false, text: "Gmail could not be connected. Try again." },
  unavailable: { ok: false, text: "Google sign-in is not set up on this server (GOOGLE_CLIENT_ID)." },
};

const CONNECT_HREF = "/api/google/calendar/connect?feature=gmail";

export function GmailSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const key = useSearchParams().get("gmail");
  const outcome = key ? (OUTCOMES[key] ?? null) : null;

  useEffect(() => {
    fetch("/api/google/calendar")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  const connected = status?.state === "connected" && status.gmail;
  const dead = status?.state === "disconnected" && status.gmail;

  return (
    <div>
      {outcome && <p className={`mb-3 text-xs ${outcome.ok ? "text-ok" : "text-danger"}`}>{outcome.text}</p>}
      {status === null ? (
        <p className="text-xs text-faint">Checking…</p>
      ) : connected ? (
        <div className="flex items-center gap-3 rounded-xl border border-edge bg-card px-3 py-2.5">
          <Mail size={16} className="flex-none text-ok" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Gmail connected</p>
            <p className="text-xs text-faint">Read on request; replies are saved as drafts. It never sends.</p>
          </div>
        </div>
      ) : dead ? (
        <div className="flex items-center gap-3 rounded-xl border border-edge bg-card px-3 py-2.5">
          <MailX size={16} className="flex-none text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Gmail is disconnected</p>
          </div>
          <a href={CONNECT_HREF} className="flex-none rounded-full bg-accent px-4 py-2 text-xs font-bold text-bg">
            Reconnect
          </a>
        </div>
      ) : (
        <a href={CONNECT_HREF} className="inline-block rounded-full bg-accent px-4 py-2 text-xs font-bold text-bg">
          Connect Gmail
        </a>
      )}
    </div>
  );
}
