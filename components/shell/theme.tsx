"use client";

// Theme switching: data-theme on <html>, persisted in a cookie (read
// server-side in app/layout.tsx — no flash) + localStorage. Default is light.
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.cookie = `theme=${t};path=/;max-age=31536000;SameSite=Lax`;
  try {
    localStorage.setItem("theme", t);
  } catch {
    /* private mode */
  }
}

function useTheme() {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    const t = setTimeout(
      () => setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light"),
      0
    );
    return () => clearTimeout(t);
  }, []);
  const set = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
  };
  return { theme, set };
}

/** Sun/moon icon button for the app header. */
export function ThemeToggle() {
  const { theme, set } = useTheme();
  const next: Theme = theme === "light" ? "dark" : "light";
  return (
    <button
      onClick={() => set(next)}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
      className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {theme === "light" ? <Moon size={16} strokeWidth={1.75} /> : <Sun size={16} strokeWidth={1.75} />}
    </button>
  );
}

/** Light/Dark picker for the settings page. */
export function AppearancePicker() {
  const { theme, set } = useTheme();
  return (
    <div className="flex gap-2">
      {(["light", "dark"] as const).map((t) => (
        <button
          key={t}
          onClick={() => set(t)}
          className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm capitalize transition-colors ${
            theme === t
              ? "border-accent bg-accent/10 font-semibold text-accent"
              : "border-edge bg-surface-2 text-muted hover:text-ink"
          }`}
        >
          {t === "light" ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />}
          {t}
        </button>
      ))}
    </div>
  );
}
