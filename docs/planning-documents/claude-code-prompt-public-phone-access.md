# Claude Code prompt — public access for a phone that can't join Tailscale

Copy everything below the line into Claude Code, run from the repo root.

---

I need to test this app from a phone that CANNOT join my tailnet (work phone, no VPN/profile installs allowed). Today the dev app is reachable only inside the tailnet at `https://kironkps-macbook-pro-1.taildfcf4.ts.net:8443` via a custom TLS proxy. I want to publish it with **Tailscale Funnel** so the same machine serves a public HTTPS URL that any phone can open in a browser — no client app, no VPN.

Set this up as a clean, documented dev workflow. Small task — don't over-engineer it.

## Current setup (read these first)

- `scripts/https-proxy.mjs` — custom HTTPS proxy on :8443 using certs in `.certs/` (tailscale-issued for `kironkps-macbook-pro-1.taildfcf4.ts.net`), forwarding to the Next dev server on :3000.
- `next.config.ts` — `allowedDevOrigins` is derived from the `TRUSTED_ORIGINS` env var; strict CSP (`connect-src 'self' https://api.openai.com`) — same-origin app traffic, so a new public origin needs no CSP change.
- `lib/auth.ts` + `.env.local` — Better Auth; `TRUSTED_ORIGINS` feeds auth CSRF trust. Check how `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` are used before touching them; multiple trusted origins must keep working (localhost, the :8443 tailnet URL, and the new public URL).
- Voice (OpenAI Realtime over WebRTC) requires a secure context — Funnel's real TLS cert satisfies this. **Do not touch any voice/realtime code.**

## What to build

1. **Funnel workflow.** Add an npm script (e.g. `npm run dev:public`) that starts the Next dev server and exposes it via `tailscale funnel --bg 3000` → `https://kironkps-macbook-pro-1.taildfcf4.ts.net` (port 443; Funnel only supports external ports 443/8443/10000, TLS terminated by tailscaled). Companion scripts: `funnel:off` (`tailscale funnel reset`) and `funnel:status` (`tailscale funnel status`). Idempotent: safe to re-run, clear error if the `tailscale` CLI is missing or Funnel isn't yet approved for the tailnet (first run prints an approval link — surface it, don't swallow it).
2. **Port conflict decision.** The custom :8443 proxy and Funnel are independent paths. Either keep both (tailnet via :8443, public via :443) or, if simpler, note that Funnel on 443 makes the custom proxy redundant and document how to run either. Do NOT configure Funnel on 8443 while the proxy binds it.
3. **Env/config.** Add the no-port public origin (`https://kironkps-macbook-pro-1.taildfcf4.ts.net`) to `TRUSTED_ORIGINS` in `.env.local` AND to the documented example in `.env.example` (as a comment showing the pattern). Verify sign-in, session cookies, and passkey/WebAuthn flows work from the public origin — check `lib/auth.ts` origin/`rpID` handling for WebAuthn specifically; if passkeys are origin-bound such that the new origin breaks them, document that email/password sign-in is the path on the phone rather than hacking rpID.
4. **Fallback script (optional, 10 lines).** `npm run tunnel:cf` using `cloudflared tunnel --url http://localhost:3000` for networks that block `*.ts.net`, with a comment that the random trycloudflare URL must be appended to `TRUSTED_ORIGINS` per run.
5. **Docs.** Add a short "Testing from a phone (no Tailscale)" section to `README.md`: the one command, the URL, the first-run approval step, DNS can take up to ~10 min on first publish, how to turn it off, and a security note (URL is publicly reachable — the app is sign-in-gated and voice minting is quota'd, but treat the URL as private and run `npm run funnel:off` when done).

## Constraints

- Don't modify voice/realtime code, CSP, or auth logic beyond origin/trust configuration.
- Don't commit `.env.local` (it's gitignored — keep it that way); example values go in `.env.example` only.
- Existing access paths must keep working: `http://localhost:3000` on the Mac and the `:8443` tailnet URL (if you keep the proxy).
- `npm run build`, lint, vitest green.

## Verify (tell me the exact steps, then I'll do them on the phone)

1. `npm run dev:public` on the Mac → paste me the public URL and `funnel:status` output.
2. On the phone (cellular first, then work Wi-Fi): open the URL → sign in → send a text message → open the dashboard → start a voice call and confirm mic prompt + audible reply (secure context proof).
3. `npm run funnel:off` → confirm the URL stops resolving/serving.
