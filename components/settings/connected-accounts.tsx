"use client";

// Connected accounts: the site account is the login; this attaches the
// user's own API keys so the model calls run (and bill) on their accounts.
// Claude carries the brain, the understanding loop and Claude chat; OpenAI
// carries voice, GPT chat and the loop's second road. Each falls back to the
// house key when the server has one. Every route that calls a model resolves
// the connected key first (lib/anthropic.ts anthropicClientFor, lib/openai.ts
// openaiClientFor), which is what "connect your own key in Settings" on the
// thinking strip, the chat and the voice button points at.
import { useEffect, useState } from "react";
import { Link2, Unplug } from "lucide-react";

type Provider = "anthropic" | "openai";
type Connection = { provider: string; keyTail: string };
type HouseKeys = Record<Provider, boolean>;

const PROVIDERS: {
  id: Provider;
  name: string;
  placeholder: string;
  /** What runs on this key, for the connected row and the fallback note. */
  runs: string;
}[] = [
  {
    id: "anthropic",
    name: "Claude",
    placeholder: "sk-ant-…  (console.anthropic.com → API keys)",
    runs: "Claude features",
  },
  {
    id: "openai",
    name: "OpenAI",
    placeholder: "sk-…  (platform.openai.com → API keys)",
    runs: "Voice and GPT",
  },
];

export function ConnectedAccounts() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [houseKeys, setHouseKeys] = useState<HouseKeys>({ anthropic: false, openai: false });

  const load = async () => {
    const res = await fetch("/api/connections");
    if (!res.ok) return;
    const body = (await res.json()) as { connections: Connection[]; houseKeys?: Partial<HouseKeys> };
    setConnections(body.connections);
    setHouseKeys({ anthropic: Boolean(body.houseKeys?.anthropic), openai: Boolean(body.houseKeys?.openai) });
  };
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, []);

  if (!connections) return <p className="text-xs text-faint">Loading…</p>;

  return (
    <div className="space-y-3">
      {PROVIDERS.map((p) => (
        <ProviderRow
          key={p.id}
          provider={p}
          connection={connections.find((c) => c.provider === p.id) ?? null}
          houseKey={houseKeys[p.id]}
          onChange={() => void load()}
        />
      ))}
    </div>
  );
}

function ProviderRow({
  provider,
  connection,
  houseKey,
  onChange,
}: {
  provider: (typeof PROVIDERS)[number];
  connection: Connection | null;
  houseKey: boolean;
  onChange: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const connect = async () => {
    setBusy(true);
    setError("");
    const res = await fetch("/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: provider.id, apiKey: key.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? "Couldn't connect.");
      return;
    }
    setKey("");
    onChange();
  };

  const disconnect = async () => {
    setBusy(true);
    await fetch("/api/connections", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: provider.id }),
    });
    setBusy(false);
    onChange();
  };

  if (connection) {
    return (
      <div
        data-connection={provider.id}
        className="flex items-center gap-3 rounded-xl border border-edge bg-card px-3 py-2.5"
      >
        <Link2 size={16} className="flex-none text-ok" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{provider.name} connected</p>
          <p className="text-xs text-faint">
            Key ····{connection.keyTail} — {provider.runs.toLowerCase()} bill to your account
          </p>
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
    );
  }

  return (
    <div data-connection={provider.id}>
      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={provider.placeholder}
          aria-label={`${provider.name} API key`}
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
          ? `Not connected — ${provider.runs} currently run on this server's shared key.`
          : `Not connected — ${provider.runs} are off for your account until you connect.`}{" "}
        Your key is encrypted at rest and never shown again.
      </p>
    </div>
  );
}
