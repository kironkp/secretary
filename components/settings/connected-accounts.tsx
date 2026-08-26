"use client";

// Connect-your-Claude section: the site account is the login; this attaches
// the user's own Anthropic API key so brain features run (and bill) on their
// account. Falls back to the house key when the server has one.
import { useEffect, useState } from "react";
import { Link2, Unplug } from "lucide-react";

type Connection = { provider: string; keyTail: string };

export function ConnectedAccounts() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [houseKey, setHouseKey] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    const res = await fetch("/api/connections");
    if (!res.ok) return;
    const body = (await res.json()) as { connections: Connection[]; houseKey: boolean };
    setConnections(body.connections);
    setHouseKey(body.houseKey);
  };
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, []);

  const claude = connections?.find((c) => c.provider === "anthropic");

  const connect = async () => {
    setBusy(true);
    setError("");
    const res = await fetch("/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", apiKey: key.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? "Couldn't connect.");
      return;
    }
    setKey("");
    void load();
  };

  const disconnect = async () => {
    setBusy(true);
    await fetch("/api/connections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "anthropic" }),
    });
    setBusy(false);
    void load();
  };

  if (!connections) return <p className="text-xs text-faint">Loading…</p>;

  return (
    <div>
      {claude ? (
        <div className="flex items-center gap-3 rounded-xl border border-edge bg-card px-3 py-2.5">
          <Link2 size={16} className="flex-none text-ok" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Claude connected</p>
            <p className="text-xs text-faint">Key ····{claude.keyTail} — brain features bill to your account</p>
          </div>
          <button
            onClick={() => void disconnect()}
            disabled={busy}
            title="Disconnect"
            className="flex items-center gap-1.5 rounded-full border border-edge px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
          >
            <Unplug size={12} aria-hidden /> Disconnect
          </button>
        </div>
      ) : (
        <div>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-ant-…  (console.anthropic.com → API keys)"
              className="min-w-0 flex-1 rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
              autoComplete="off"
            />
            <button
              onClick={() => void connect()}
              disabled={busy || key.trim().length < 20}
              className="flex-none rounded-full bg-accent px-4 py-2 text-xs font-bold text-bg disabled:opacity-50"
            >
              {busy ? "Checking…" : "Connect"}
            </button>
          </div>
          {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
          <p className="mt-2 text-[11px] text-faint">
            {houseKey
              ? "Not connected — Claude features currently run on this server's shared key."
              : "Not connected — Claude features are off for your account until you connect."}
            {" "}Your key is encrypted at rest and never shown again.
          </p>
        </div>
      )}
    </div>
  );
}
