# Claude Code prompt — fix silent assistant audio in voice mode

**✅ UPDATED VERSION (v2)** — revised after confirming the assistant's transcript appears (playback-side failure). This is the one to use.

Copy everything below the line into Claude Code, run from the repo root.

---

Voice mode (OpenAI Realtime over WebRTC) produces **zero assistant audio** on every platform — macOS browsers AND iOS Safari — while audio **input works perfectly** (my speech is transcribed live and accurately) **and the assistant's own transcript appears too**.

That last fact is decisive. The client only renders assistant lines from `…audio_transcript.delta/.done` events, which exist only when the model is generating **audio** output. So: the session is healthy, responses are succeeding, audio IS being generated server-side, and the data channel delivers events fine. **The failure is confined to the delivery/playback half: RTP audio → `ontrack` → `<audio>` element → speaker.** Since it fails identically in every browser on two OSes, suspect deterministic app logic (attach/play path) or missing RTP, before per-browser autoplay policy. The `/soundtest` page plays all three of its test sounds fine on the same devices, so element playback itself works.

Your job: (1) read the evidence that already exists, (2) instrument the playback path so the failure names itself, (3) build a minimal known-good `/voicetest` harness so we have "basic GPT realtime audio working" as a baseline, (4) fix the main flow. Do NOT rewrite the architecture.

## Architecture (read these files first)

- `app/api/realtime/token/route.ts` — mints ephemeral client secret via `POST https://api.openai.com/v1/realtime/client_secrets`; session config baked in server-side: model `gpt-realtime-2.1` / `-mini`, voice `marin`, `semantic_vad`, input transcription (`gpt-4o-transcribe`), tools from `lib/secretary/tool-schemas.ts`, instructions from `lib/secretary/persona.ts` + briefing.
- `lib/realtime/openai-webrtc.ts` — browser provider: getUserMedia → RTCPeerConnection → `addTrack` → data channel `oai-events` → SDP POST to `https://api.openai.com/v1/realtime/calls` → `ontrack` stores `remoteStream`.
- `lib/realtime/remote-audio.ts` — singleton hidden `<audio autoplay playsinline>`, gesture-unlocked by playing a silent WAV from the Talk button tap (`components/chat/chat-thread.tsx`).
- `components/chat/voice-mode.tsx` — UI; polls every 300 ms after status `connected` and calls `playRemoteStream(remoteStream)`.
- `app/api/realtime/debug/route.ts` — client already beacons 3 diagnostic snapshots per call to the server log as `[voice-debug]` lines.

## Weak points I've verified in the playback path (one of these is almost certainly it)

1. **Remote audio is attached only by a 300 ms poll** (`voice-mode.tsx`) that starts after status becomes `connected`, reading `provider.remoteStream` set in `ontrack`. The documented pattern attaches directly in `ontrack` (`pc.ontrack = e => audioEl.srcObject = e.streams[0]`). Attach in `ontrack` too; keep the poll as backup.
2. **Every `audioEl.play()` rejection is swallowed** (`.catch(() => {})` in `remote-audio.ts`). If the element is stuck paused (`NotAllowedError`, `AbortError` from the src→srcObject swap, etc.), nothing ever reports it.
3. **Nothing verifies RTP is actually flowing**: `ontrack` firing, `track.muted`/`onunmute` (a remote track staying `muted: true` forever = RTP never arrived), and inbound `bytesReceived` are never asserted or surfaced anywhere. If OpenAI generates audio but the negotiated m-line doesn't carry it back, the element "plays" a silent track identically in every browser — which matches the symptom exactly.
4. **Dev-only hazard:** Next dev runs React StrictMode double-mount. On VoiceMode's simulated unmount, `stopRemoteAudio()` runs (pauses + clears the gesture-unlocked element) and `use-voice-session`'s cleanup calls `disconnect()` mid-`connect()`. Calls demonstrably connect anyway, but the element-clearing could sabotage playback **in dev only** — so testing the prod build is a mandatory early check (see Phase 0).

Hardening issues (real, but can't be the root cause given transcripts work — fix in Phase 4): `error` events and `response.done.status`/`status_details` are silently dropped; the manual barge-in `response.cancel` duplicates semantic_vad's built-in `interrupt_response` and can race; `output_modalities: ["audio"]` isn't set explicitly; `usage.output_token_details.audio_tokens` never checked.

Important protocol fact: over WebRTC, assistant audio arrives as an **RTP media track**, not as `response.output_audio.delta` data-channel events — never expect audio deltas on the data channel; judge delivery by `ontrack`/`track.muted`/inbound-rtp `bytesReceived`.

## Phase 0 — evidence that already exists (do this before touching code)

1. **Read the `[voice-debug]` beacon lines** in the dev-server terminal/logs (`app/api/realtime/debug/route.ts` logs three snapshots per call at 3s/9s/20s). Decision table on the fields:
   - `audioEl.hasStream: false` → the stream was never attached → poll/`remoteStream`/`ontrack` problem (fix #1).
   - `hasStream: true, paused: true` → `play()` is being rejected → surface the rejection (fix #2), attach in `ontrack`, re-check gesture unlock.
   - `hasStream: true, paused: false, readyState < 2` or `remoteBytesReceived ≈ 0` (not growing between the 3s and 20s snapshots) → **RTP never arrives** → dump the answer SDP + `ontrack`/`track.muted` evidence (fix #3); compare against the `/voicetest` baseline.
   - `paused: false, readyState 4, remoteBytesReceived` growing, `remote` audioLevel > 0 → audio is arriving and "playing"; problem is element/routing (muted/volume/sink) — verify `muted:false`, `volume:1`, try a visible `<audio controls>` element.
   - If there are no `[voice-debug]` lines at all, run one call on the Mac first to generate them.
2. **Run the prod build once** (`npm run build && npm start`, over the same Tailscale HTTPS setup) and test voice on the Mac. If prod plays but dev doesn't, it's the StrictMode double-mount artifact (weak point #4) — still fix the element lifecycle, but the investigation changes completely.
3. Check `.env.local` for `REALTIME_MODEL_DEFAULT`/`REALTIME_MODEL_MINI` overrides (code defaults `gpt-realtime-2.1`/`-mini` are valid current models).
4. Report which branch of the decision table the evidence points to before writing any code.

## Phase 1 — make the playback path name its own failure (small, surgical changes)

In `lib/realtime/openai-webrtc.ts`:
- Log `ontrack` firing: timestamp, `e.track.muted`, `e.streams.length`; register `track.onunmute`/`onmute` and record whether unmute ever fires (remote track never unmuting = RTP never arrived — the key signature).
- After `setRemoteDescription`, capture the answer SDP's audio m-line + `a=sendrecv|sendonly|recvonly|inactive` lines (and keep the offer's for comparison) for the beacon.
- In `remote-audio.ts`: log every `play()` rejection with `err.name: err.message` instead of swallowing; record the last rejection for the beacon.
- Keep a timestamped ring buffer (last ~200) of every data-channel event **type**, plus full payloads for `error` and `response.done` (log `response.status`, `status_details`, `usage.output_token_details.audio_tokens`).
- Extend the `[voice-debug]` beacon payload with all of the above: ontrack/unmute evidence, SDP directions, last play() rejection, `audio_tokens` totals, last error event, last 15 event types.

In `components/chat/voice-mode.tsx`:
- Add an on-screen debug overlay gated behind `?voicedebug=1` (the iPhone has no console): live pc/dc state, `ontrack`/`track.muted` status, inbound audio `bytesReceived` + delta/sec, remote `audioLevel`, `audioEl` state, last play() rejection, last ~10 event types. Tap-to-copy as JSON. Keep it ugly and tiny; it's a tool, not UI.

## Phase 2 — minimal known-good baseline: `/voicetest`

This is the "just make basic GPT realtime work" milestone. New page `app/(app)/voicetest/page.tsx` + new route `app/api/realtime/token-test/route.ts` (same auth/session guard and env key handling as the real token route, but no quota/DB writes needed):

- Mint the **simplest possible session**: `{ type: "realtime", model: <env default>, output_modalities: ["audio"], audio: { output: { voice: "marin" } } }` — NO instructions, NO tools, NO input transcription, NO turn_detection override.
- Page behavior, following OpenAI's documented WebRTC sample as literally as possible:
  - One **Connect** button (the user gesture) → `getUserMedia({audio:true})` → `new RTCPeerConnection()` → `addTrack` → `pc.ontrack = e => { audioEl.srcObject = e.streams[0]; audioEl.play() }` → `createDataChannel("oai-events")` → offer → POST SDP to `https://api.openai.com/v1/realtime/calls` with the ephemeral secret → set answer.
  - A **visible** `<audio controls>` element on the page (not hidden — we want to watch `paused`/`readyState` with our eyes).
  - On-page scrolling log of every data-channel event type (full payload for `error` / `response.done`).
  - Live stats line updated every second from `getStats()`: inbound-rtp `bytesReceived`, `audioLevel`.
  - Buttons: **"Say hi"** (sends `{type:"response.create"}` over the data channel — forces a response without relying on VAD), **"Test tone"** (plays a short oscillator/wav through the SAME audio element as a sanity check).
- **Exit criteria: the assistant is audibly heard on Mac Chrome, Mac Safari, and iOS Safari.** If even this minimal page is silent, iterate HERE (report exactly what the event log + stats show — ontrack fired? track unmuted? bytes growing? play() rejected?) before touching the main flow. Once it plays, this page doubles as the reference: **diff its answer SDP and stats against the production flow's** to find what differs.

## Phase 3 — close the gap between baseline and production

The baseline differs from production in two dimensions — session config (instructions, tools, transcription, semantic_vad) and client playback plumbing (direct `ontrack` attach + visible element vs. singleton hidden element + poll). Since responses and transcripts already succeed in production, **suspect the plumbing dimension first**: port the baseline's attach approach into the production flow and re-test before bisecting session config. Only if that doesn't fix it, bisect session layers one at a time on `/voicetest` (query-param toggles): ① instructions → ② tools + `tool_choice:"auto"` → ③ input transcription → ④ `semantic_vad` → ⑤ the barge-in `response.cancel` behavior. Report the first thing that kills audio.

## Phase 4 — fix the main flow (minimal diff, informed by Phase 0–3)

Expected shape of the fix (adjust to what the evidence actually showed):
- `lib/realtime/openai-webrtc.ts`: attach the stream in `ontrack` directly (emit an event or call `playRemoteStream` right there; keep the poll as backup); surface `error` events and failed responses through the existing status/error event path.
- `lib/realtime/remote-audio.ts`: keep the gesture unlock exactly as is; ensure `muted=false`, `volume=1` when the live stream is swapped in; keep logging play() rejections. If StrictMode's `stopRemoteAudio` proved to be the dev-only culprit, make the element lifecycle idempotent/re-unlockable instead of removing StrictMode.
- Hardening while you're in there: `app/api/realtime/token/route.ts` — add `output_modalities: ["audio"]` explicitly; remove or guard the manual barge-in `response.cancel` (semantic_vad already interrupts server-side; tolerate "no active response" errors).
- Keep the Phase 1 instrumentation permanently (cheap, and this app is debugged from a phone).

## Constraints

- Do NOT break dictation (`components/chat/dictation-bar.tsx`) or text chat.
- Preserve the iOS rules already encoded in code comments: never attach Web Audio nodes to the mic stream mid-call (it silences the WebRTC sender on iOS Safari); levels come from `getStats()` only; keep the Talk-button gesture unlock.
- `npm run build`, lint, and the existing vitest suite must pass after each phase.
- Testing is manual on my devices (Mac + iPhone over the Tailscale HTTPS dev setup, `scripts/https-proxy.mjs`). After each phase, STOP and tell me exactly: what URL to open, what to click, what I should hear, and what to paste back to you (server log lines / overlay JSON).
- Commit per phase with clear messages.

## Current-API reference notes (verified Aug 2026)

- `gpt-realtime-2.1` and `gpt-realtime-2.1-mini` are valid current models (released July 2026).
- GA WebRTC flow: SDP POST to `https://api.openai.com/v1/realtime/calls` with `Authorization: Bearer <ephemeral secret>`, `Content-Type: application/sdp`; docs attach output in `ontrack` to an `autoplay` audio element.
- GA event names: `conversation.item.input_audio_transcription.delta/.completed`, `response.output_audio_transcript.delta/.done`, `response.output_text.delta`, `response.function_call_arguments.done`, `response.created/.done`, `error`. (Beta names without `output_` are gone; the code's `endsWith("audio_transcript.delta")` matching is compatible.)
- `semantic_vad` options: `eagerness`, `create_response` (default true), `interrupt_response` (default true).
