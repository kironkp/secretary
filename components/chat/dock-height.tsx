"use client";

// The docked chat is fixed to the bottom of every page and is as tall as its
// composer: on a phone, with the model chip and the Talk button, about 250px.
// The shell used to pad the page bottom by a fixed 96px, so the last 150px of
// every screen sat under the composer — on Today, the answer buttons of an
// opened question. The dock's real height is published here as a CSS
// variable on the root element, and the shell pads by it
// (app/(app)/layout.tsx), so whatever the composer grows to, the page bottom
// stays reachable.
import { useEffect, useRef } from "react";

export function DockHeight() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--dock-h", `${Math.ceil(host.getBoundingClientRect().height)}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--dock-h");
    };
  }, []);

  return <span ref={ref} hidden aria-hidden />;
}
