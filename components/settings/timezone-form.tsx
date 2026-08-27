"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button, ErrorNote, SuccessNote } from "@/components/ui";

// "Are we past hydration?" — a store that never changes, so the server
// snapshot is false and the client snapshot is true. This is the sanctioned
// shape; setState-in-an-effect is a React Compiler lint error.
const neverChanges = () => () => {};

export function TimezoneForm({ current }: { current: string }) {
  const router = useRouter();
  // Both the zone list and the device zone are environment-dependent: Node's
  // ICU build and the phone's disagree on Intl.supportedValuesOf("timeZone"),
  // and the server's own zone is not the user's. Rendering either during SSR
  // guarantees a hydration mismatch, so the first client render matches the
  // server's (current zone only) and the real values arrive after mount.
  const mounted = useSyncExternalStore(
    neverChanges,
    () => true,
    () => false
  );

  const zones = useMemo(() => {
    if (!mounted) return [current];
    const all = Intl.supportedValuesOf("timeZone");
    return all.includes(current) ? all : [current, ...all];
  }, [mounted, current]);
  const browserZone = mounted ? Intl.DateTimeFormat().resolvedOptions().timeZone : null;

  const [value, setValue] = useState(current);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async (tz: string) => {
    setError("");
    setSaved(false);
    setBusy(true);
    const { error } = await authClient.updateUser({ timezone: tz });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Couldn't save timezone.");
      return;
    }
    setValue(tz);
    setSaved(true);
    router.refresh();
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-lg border border-edge bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        <Button disabled={busy || value === current} onClick={() => save(value)}>
          Save
        </Button>
      </div>
      {browserZone && browserZone !== current && (
        <button
          className="text-xs text-accent hover:underline"
          onClick={() => save(browserZone)}
        >
          Use this device&apos;s timezone ({browserZone})
        </button>
      )}
      <ErrorNote>{error}</ErrorNote>
      <SuccessNote>{saved ? "Timezone updated." : ""}</SuccessNote>
    </div>
  );
}
