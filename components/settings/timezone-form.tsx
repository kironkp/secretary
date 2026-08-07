"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button, ErrorNote, SuccessNote } from "@/components/ui";

export function TimezoneForm({ current }: { current: string }) {
  const router = useRouter();
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  const browserZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );
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
      {browserZone !== current && (
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
