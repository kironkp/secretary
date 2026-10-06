"use client";

// The bottom tab bar. SEC-A006 (Kiron: "make it make sense"): Today ·
// Dashboard · Projects · Interview · Memory · Settings. The Dashboard is the
// board he uses, and it was not on the bar at all; Projects is a plain list
// that opens each project; the Canvas is a view inside the Dashboard. The
// Workspace, Spreadsheet and Sound test are reachable from Settings ›
// More screens. Icons are drawn in one 26px 1.8-stroke hand; six tabs share
// the width, each at most 72px, so they still fit a 393px screen.
import Link from "next/link";
import { usePathname } from "next/navigation";

export const TABS = [
  {
    href: "/today",
    label: "Today",
    icon: (
      <svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="4" y="5" width="18" height="17" rx="4" />
        <path d="M4 11h18M9 3v4M17 3v4" />
        <circle cx="13" cy="16" r="2" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="4" y="4" width="8" height="8" rx="2" />
        <rect x="14" y="4" width="8" height="8" rx="2" />
        <rect x="4" y="14" width="8" height="8" rx="2" />
        <rect x="14" y="14" width="8" height="8" rx="2" />
      </svg>
    ),
  },
  {
    href: "/projects",
    label: "Projects",
    icon: (
      // A folder: a project and what it holds.
      <svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        <path d="M3.5 8.5a2.5 2.5 0 0 1 2.5-2.5h4.5l2.5 2.5h7a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5H6a2.5 2.5 0 0 1-2.5-2.5z" />
        <path d="M3.5 11.5h19" />
      </svg>
    ),
  },
  {
    href: "/interview",
    label: "Interview",
    icon: (
      // A speech bubble with a question mark: the secretary asking.
      <svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M7 4h12a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-6l-4 3.5V19H7a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" />
        <path d="M10.6 9.3a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1 .9-1 1.6v.5" strokeLinecap="round" />
        <circle cx="13" cy="16" r="0.9" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    href: "/memory",
    label: "Memory",
    icon: (
      // A book with a bookmark ribbon: kept for later.
      <svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        <path d="M7.5 3.5H21v16H7.5A2.5 2.5 0 0 0 5 22V6a2.5 2.5 0 0 1 2.5-2.5z" />
        <path d="M5 22a2.5 2.5 0 0 1 2.5-2.5H21v3H7.5" />
        <path d="M11 3.5v7l2.25-1.6 2.25 1.6v-7" />
      </svg>
    ),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: (
      <svg viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="13" cy="13" r="3.2" />
        <path d="M13 3v3M13 20v3M3 13h3M20 13h3M5.9 5.9l2.1 2.1M18 18l2.1 2.1M5.9 20.1L8 18M18 8l2.1-2.1" />
      </svg>
    ),
  },
] as const;

/**
 * The tab a path belongs to: its own section and everything under it. The
 * Canvas lives inside the Dashboard now, so its old address lights it too.
 */
export function tabFor(pathname: string): string | null {
  if (pathname === "/canvas" || pathname.startsWith("/canvas/")) return "/dashboard";
  const tab = TABS.find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`));
  return tab?.href ?? null;
}

export function TabBar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Sections"
      data-testid="tab-bar"
      className="flex justify-around px-2 pt-1"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 18px)" }}
    >
      {TABS.map((t) => {
        const on = tabFor(pathname) === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={on ? "page" : undefined}
            className={`flex min-h-11 min-w-0 max-w-[72px] flex-1 flex-col items-center justify-end gap-[3px] text-[10px] ${
              on ? "text-accent" : "text-faint"
            }`}
          >
            <span className="block h-[26px] w-[26px]">{t.icon}</span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
