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
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
