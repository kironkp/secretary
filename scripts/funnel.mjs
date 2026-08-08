#!/usr/bin/env node
// Tailscale Funnel workflow: publish the dev server at a public HTTPS URL so a
// phone WITHOUT Tailscale (work phone, no VPN allowed) can open it.
//
//   npm run dev:public    → funnel up (persists in background) + next dev
//   npm run funnel:status → show what's published
//   npm run funnel:off    → tear the public URL down
//
// Funnel's public ports are limited to 443/8443/10000. We publish on 8443 so
// the public URL is the SAME https://<machine>.ts.net:8443 the tailnet has
// always used — its origin is already in TRUSTED_ORIGINS, and :443 on this
// machine belongs to the findit app. tailscaled terminates TLS with a real
// certificate, so voice (WebRTC needs a secure context) works.
//
// While Funnel is up it also serves tailnet traffic on :8443, so the old
// `npm run https-proxy` is only needed as a fallback when Funnel is off.
import { spawn, spawnSync } from "node:child_process";

const HTTPS_PORT = 8443;
const TARGET_PORT = 3000;
const PUBLIC_URL = `https://kironkps-macbook-pro-1.taildfcf4.ts.net:${HTTPS_PORT}`;
const APPROVAL_MARKER = "To enable, visit";

const CLI_CANDIDATES = [
  "tailscale", // on PATH (brew install)
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale", // macOS app bundle
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
];

function findCli() {
  for (const cli of CLI_CANDIDATES) {
    const probe = spawnSync(cli, ["version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return cli;
  }
  return null;
}

function run(cli, args) {
  const res = spawnSync(cli, args, { encoding: "utf8" });
  return { out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim(), status: res.status };
}

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

const cli = findCli();
if (!cli) {
  fail(
    "Tailscale CLI not found. Install the Tailscale app (App Store) or " +
      "`brew install tailscale`, log in, then re-run."
  );
}

const cmd = process.argv[2];

if (cmd === "status") {
  const { out } = run(cli, ["funnel", "status"]);
  console.log(out || "No funnel config.");
  process.exit(0);
} else if (cmd === "off") {
  const { out, status } = run(cli, ["funnel", "reset"]);
  if (status !== 0) fail(out || "funnel reset failed.");
  console.log("Funnel is off — the public URL no longer serves.");
  process.exit(0);
} else if (cmd === "up") {
  up();
} else {
  fail("Usage: node scripts/funnel.mjs <up|off|status>");
}

function up() {
  // `funnel --bg` persists the config and exits… unless Funnel isn't yet
  // approved for this tailnet, in which case it prints an approval link and
  // waits forever. Stream the output so the link is surfaced, and bail out
  // with instructions instead of hanging the dev workflow.
  const child = spawn(cli, ["funnel", "--bg", `--https=${HTTPS_PORT}`, String(TARGET_PORT)]);
  let sawApproval = false;

  const onData = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (text.includes(APPROVAL_MARKER) && !sawApproval) {
      sawApproval = true;
      // The CLI polls forever waiting for approval; give the link a beat to
      // finish printing, then bail with instructions instead of hanging.
      setTimeout(() => child.kill(), 1000);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const timer = setTimeout(() => {
    child.kill();
    if (sawApproval) {
      fail(
        "Funnel isn't approved for this tailnet yet. Open the link above, " +
          "enable Funnel for this machine, then re-run `npm run dev:public`."
      );
    }
    fail("`tailscale funnel` didn't respond within 30s — try `npm run funnel:status`.");
  }, 30_000);

  child.on("exit", (code) => {
    clearTimeout(timer);
    if (sawApproval) {
      fail(
        "Funnel isn't approved for this tailnet yet. Open the link above, " +
          "enable Funnel for this machine, then re-run `npm run dev:public`."
      );
    }
    if (code !== 0) fail("`tailscale funnel` failed — see output above.");

    // Trust but verify: this machine's Tailscale client has silently dropped
    // serve configs before ("No serve config" right after a successful --bg).
    const { out: status } = run(cli, ["funnel", "status"]);
    if (!status.includes(`:${HTTPS_PORT}`)) {
      fail(
        "Funnel reported success but the config didn't stick " +
          "(`tailscale funnel status` shows nothing). Update the Tailscale " +
          "app and retry, or fall back to `npm run tunnel:cf`."
      );
    }
    console.log(`\n✔ Public URL: ${PUBLIC_URL}`);
    console.log("  (first publish can take ~10 min to appear in public DNS)");
    console.log("  Turn it off with: npm run funnel:off\n");
  });
}
