"use client";

// Tab bar with a single traveling indicator (SPEC §7.7): one accent bar that
// SLIDES to the active tab on every change — click or programmatic (e.g. a
// canvas paint navigating here) — never teleports. The stretch: the edge
// facing the destination gets the faster curve, the trailing edge settles
// behind it, so the bar reaches toward the target then contracts into place.
// Chat is not a tab — it lives in the bottom dock.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const TABS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/canvas", label: "Canvas" },
  { href: "/spreadsheet", label: "Spreadsheet" },
  { href: "/soundtest", label: "Sound test" },
  { href: "/settings", label: "Settings" },
];

// Leading edge races ahead; trailing edge eases in after it.
const LEAD = "cubic-bezier(0.22, 0.9, 0.32, 1) 0ms";
const TRAIL = "cubic-bezier(0.6, 0.05, 0.35, 1) 55ms";
const DURATION = "340ms";

export function NavTabs() {
  const pathname = usePathname();
  // The positioning context is a content-sized wrapper INSIDE the scroll
  // container: `right` insets then anchor to the full tab-row width, not the
  // visible box, so the indicator stays correct while the row scrolls.
  const navRef = useRef<HTMLDivElement>(null);
  // left/right insets within the scrollable content; animating the two edges
  // independently (instead of transform+width) is what makes the stretch.
  const [edges, setEdges] = useState<{ left: number; right: number } | null>(null);
  const [movingRight, setMovingRight] = useState(true);
  // First paint places the bar without motion; `armed` (state — it drives the
  // rendered transition) flips one frame later. The ref mirrors it for the
  // measure effect's scroll behavior, where render freshness doesn't matter.
  const [armed, setArmed] = useState(false);
  const animate = useRef(false);

  const activeIndex = TABS.findIndex((t) => pathname.startsWith(t.href));

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      if (activeIndex < 0) return; // off-tab route: keep last position, fade out
      const el = nav.querySelectorAll("a")[activeIndex] as HTMLElement | undefined;
      if (!el) return;
      const left = el.offsetLeft;
      const right = nav.offsetWidth - el.offsetLeft - el.offsetWidth;
      setEdges((prev) => {
        if (prev && (prev.left !== left || prev.right !== right)) {
          setMovingRight(left >= prev.left);
        }
        return { left, right };
      });
      el.scrollIntoView({
        inline: "nearest",
        block: "nearest",
        behavior: animate.current ? "smooth" : "auto",
      });
    };
    measure();
    // font swap and container resizes shift tab widths after first paint
    document.fonts?.ready.then(measure).catch(() => {});
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [activeIndex]);

  // Arm transitions one frame AFTER the indicator first lands, so it never
  // slides in from x=0 on page load.
  useEffect(() => {
    if (edges && !animate.current) {
      const raf = requestAnimationFrame(() => {
        animate.current = true;
        setArmed(true);
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [edges]);

  return (
    // overflow-x-auto: on phones the row scrolls INSIDE itself — overflowing
    // tabs otherwise widen the mobile layout viewport (to ~519px) and push
    // everything else (voice call controls included) off-screen.
    <nav className="overflow-x-auto [scrollbar-width:none] [-webkit-overflow-scrolling:touch]">
      <div ref={navRef} className="relative flex min-w-max gap-1">
      {TABS.map((tab, i) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={`flex-none whitespace-nowrap px-3 py-2 text-sm font-semibold transition-colors ${
            i === activeIndex ? "text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {tab.label}
        </Link>
      ))}
      {edges && (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0 h-[2.5px] rounded-full bg-accent motion-reduce:transition-none"
          style={{
            left: edges.left + 8,
            right: edges.right + 8,
            opacity: activeIndex < 0 ? 0 : 1,
            transition: armed
              ? `left ${DURATION} ${movingRight ? TRAIL : LEAD}, right ${DURATION} ${
                  movingRight ? LEAD : TRAIL
                }, opacity 200ms ease`
              : "none",
          }}
        />
      )}
      </div>
    </nav>
  );
}
