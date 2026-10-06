"use client";

// Google Calendar in Settings (SEC-A002): whether events the secretary makes
// reach the user's Google Calendar, and the button that grants or renews it.
// Connect is a plain navigation to /api/google/calendar/connect, which
// leaves for Google's consent page and comes back here with ?calendar=….
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarCheck, CalendarX, Unplug } from "lucide-react";

type Status =
  | { state: "not-connected" }
  | { state: "connected"; calendar: boolean; connectedAt: string }
  | { state: "disconnected"; reason: string | null; calendar: boolean };

const OUTCOMES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Calendar is connected." },
  denied: { ok: false, text: "Google Calendar was not connected: access was declined on Google's page." },
  "scope-missing": {
    ok: false,
    text: "Google Calendar was not connected: calendar access was unticked on Google's page. Connect again and leave it ticked.",
  },
  failed: { ok: false, text: "Google Calendar could not be connected. Try again." },
  unavailable: { ok: false, text: "Google sign-in is not set up on this server (GOOGLE_CLIENT_ID)." },
};

const CONNECT_HREF = "/api/google/calendar/connect";

export function GoogleCalendarSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const outcomeKey = useSearchParams().get("calendar");
  const outcome = !dismissed && outcomeKey ? (OUTCOMES[outcomeKey] ?? null) : null;

  useEffect(() => {
    fetch("/api/google/calendar")
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Status | null) => setStatus(s))
      .catch(() => setStatus(null));
  }, []);

  async function disconnect() {
    setBusy(true);
    try {
      const r = await fetch("/api/google/calendar", { method: "DELETE" });
      if (r.ok) setStatus({ state: "not-connected" });
      setDismissed(true);
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.state === "connected" && status.calendar;
  const dead = status?.state === "disconnected" || (status?.state === "connected" && !status.calendar);

  return (
    <div>
      {outcome && <p className={`mb-3 text-xs ${outcome.ok ? "text-ok" : "text-danger"}`}>{outcome.text}</p>}
      {status === null ? (
        <p className="text-xs text-faint">Checking…</p>
      ) : connected ? (
        <div className="flex items-center gap-3 rounded-xl border border-edge bg-card px-3 py-2.5">
          <CalendarCheck size={16} className="flex-none text-ok" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Google Calendar connected</p>
            <p className="text-xs text-faint">
              Events you ask for by voice or chat go straight to your primary calendar.
            </p>
          </div>
          <button
            type="button"
            onClick={disconnect}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
          >
            <Unplug size={13} aria-hidden /> Disconnect
          </button>
        </div>
      ) : dead ? (
        <div className="flex items-center gap-3 rounded-xl border border-edge bg-card px-3 py-2.5">
          <CalendarX size={16} className="flex-none text-danger" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Google Calendar is disconnected</p>
            <p className="text-xs text-faint">New events stay in Secretary until you reconnect.</p>
          </div>
          <a href={CONNECT_HREF} className="flex-none rounded-full bg-accent px-4 py-2 text-xs font-bold text-bg">
            Reconnect
          </a>
        </div>
      ) : (
        <a href={CONNECT_HREF} className="inline-block rounded-full bg-accent px-4 py-2 text-xs font-bold text-bg">
          Connect Google Calendar
        </a>
      )}
    </div>
  );
}
