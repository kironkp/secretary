import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// CSP notes: connect-src allows the OpenAI Realtime API (WebRTC SDP exchange is
// an https POST to api.openai.com; media itself flows peer-to-peer over SRTP,
// outside CSP). blob:/data: in media-src cover recorded dictation playback.
// 'unsafe-eval' is required by Next.js dev tooling only.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://api.openai.com",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

// Hostnames (from TRUSTED_ORIGINS URLs) allowed to load dev assets
// cross-origin — needed when opening the dev server via Tailscale.
const allowedDevOrigins = (process.env.TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((u) => {
    try {
      return new URL(u).hostname;
    } catch {
      return u;
    }
  });

const nextConfig: NextConfig = {
  devIndicators: false,
  // The simulation harness runs a second dev server from this checkout —
  // separate dist dirs keep the two Next processes from fighting over .next.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      {
        // Attachment bytes are untrusted user content served from our own
        // origin. This entry MUST come after the catch-all: for a duplicate
        // header key the last matching entry wins, and a route handler cannot
        // set its own CSP at all (the config's value replaces it). Keys the
        // catch-all sets and this one doesn't — nosniff, Referrer-Policy,
        // X-Frame-Options — still reach this path. `default-src 'none'` covers
        // script-src, so a stored HTML file navigated to directly cannot run
        // its own inline script. No `sandbox` token: it adds opaque-origin
        // isolation we don't need once the bytes are octet-stream, and it
        // breaks the built-in PDF viewer.
        source: "/api/attachments/:id",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
      {
        // The compiled packet is built from the same untrusted uploads, so it
        // gets the same lock (docs/understanding/SPEC.md §6, packets).
        source: "/api/tasks/:id/packet/pdf",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
