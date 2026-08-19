"use client";

// Voice timbre picker — persisted to the persona (server-side), so it applies
// to every chat window and device, and can still be switched mid-call.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
];

export function VoicePicker({ initial }: { initial: string }) {
  const router = useRouter();
  const [voice, setVoice] = useState(initial);
  const [elAvailable, setElAvailable] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/elevenlabs/tts");
        if (res.ok)
          setElAvailable(Boolean(((await res.json()) as { configured: boolean }).configured));
      } catch {
        /* option stays hidden */
      }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const pick = async (next: string) => {
    setVoice(next);
    setSaving(true);
    const res = await fetch("/api/persona", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: next }),
    });
    setSaving(false);
    if (!res.ok) setVoice(initial);
    else router.refresh();
  };

  return (
    <select
      value={voice}
      disabled={saving}
      onChange={(e) => void pick(e.target.value)}
      className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none focus:border-accent"
      aria-label="Voice"
    >
      {VOICES.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
      {elAvailable && <option value="elevenlabs">sassy (ElevenLabs beta)</option>}
    </select>
  );
}
