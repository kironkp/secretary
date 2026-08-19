"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/chat", label: "Chat" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/canvas", label: "Canvas" },
  { href: "/spreadsheet", label: "Spreadsheet" },
  { href: "/soundtest", label: "Sound test" },
  { href: "/settings", label: "Settings" },
];

export function NavTabs() {
  const pathname = usePathname();
  return (
    // overflow-x-auto: on phones the row scrolls INSIDE itself — overflowing
    // tabs otherwise widen the mobile layout viewport (to ~519px) and push
    // everything else (voice call controls included) off-screen.
    <nav className="flex gap-1 overflow-x-auto [scrollbar-width:none] [-webkit-overflow-scrolling:touch]">
      {TABS.map((tab) => {
        const active = pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`flex-none whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition-colors ${
              active
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
