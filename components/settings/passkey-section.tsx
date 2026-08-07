"use client";

import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { Button, ErrorNote } from "@/components/ui";

type Passkey = { id: string; name?: string | null; createdAt: Date | string };

export function PasskeySection() {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    return authClient.passkey.listUserPasskeys().then((res) => {
      if (res.data) setPasskeys(res.data as Passkey[]);
    });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    setError("");
    setBusy(true);
    const res = await authClient.passkey.addPasskey({
      name: navigator.platform || "This device",
    });
    setBusy(false);
    if (res?.error) {
      setError(res.error.message ?? "Couldn't add passkey.");
      return;
    }
    refresh();
  };

  const remove = async (id: string) => {
    setError("");
    await authClient.passkey.deletePasskey({ id });
    refresh();
  };

  return (
    <div className="space-y-3">
      {passkeys.length > 0 && (
        <ul className="divide-y divide-edge rounded-lg border border-edge bg-surface-2">
          {passkeys.map((pk) => (
            <li key={pk.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span>🔑 {pk.name || "Passkey"}</span>
              <span className="ml-auto text-xs text-faint">
                {new Date(pk.createdAt).toLocaleDateString()}
              </span>
              <button
                onClick={() => remove(pk.id)}
                className="text-xs text-danger hover:underline"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote>{error}</ErrorNote>
      <Button variant="secondary" disabled={busy} onClick={add}>
        {busy ? "Follow your browser's prompt…" : "＋ Add a passkey"}
      </Button>
    </div>
  );
}
