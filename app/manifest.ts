// PWA manifest (FindIt pattern): standalone display + icons is what makes
// iOS offer "Add to Home Screen" as a real app — and an installed PWA is the
// prerequisite for Web Push on iOS.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Secretary",
    short_name: "Secretary",
    description: "A genius secretary you talk to.",
    start_url: "/chat",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f6f7fb",
    theme_color: "#f6f7fb",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
