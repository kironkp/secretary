"use client";

// Server-component data (tasks, strips, briefing) refreshes when the window
// regains focus — cheap way to keep the dashboard honest across tabs/devices.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function RefreshOnFocus() {
  const router = useRouter();
  useEffect(() => {
    const onFocus = () => router.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [router]);
  return null;
}
