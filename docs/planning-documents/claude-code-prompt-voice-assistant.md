# Prompt for Claude Code — "Secretary" Voice Personal Assistant Web App (v3)

Copy everything below the line into Claude Code as your instruction. It contains the current (July 2026) API facts inline, so Claude Code doesn't need web access to get the stack right. A companion HTML spec board (user stories + wireframes) exists — reference: `secretary-spec-board.html`.

---

## What we're building

**A genius secretary you talk to.** A voice-first personal assistant web app whose core job is running the user's "adulting" life: it listens for dates, meetings, deadlines, and to-dos *inside natural conversation*, tracks whether tasks got started or finished, proactively follows up ("Did you send that in? It was due yesterday."), and maintains a beautiful, AI-adaptive dashboard of the user's projects and obligations. The replacement for Notion/Monday/Trello — except nobody fills in forms; you just talk.

Voice quality must match ChatGPT's current voice mode (natural back-and-forth, instant interruptions). Production login and security from day one. Web first; architected so core logic ports to iOS/Android later.

**The defining interaction:** on a day with overdue items, the user says "hello" and the secretary answers "Morning. Did you send the insurance form? It was due yesterday — and your dentist appointment is at 2." Not a passive chatbot; an accountable, gently persistent secretary.

## The stack (do not substitute — these are the current best tools as of July 2026)

- **Voice engine: OpenAI Realtime API**, model **`gpt-realtime-2.1`** (default) — the same speech-to-speech model family behind ChatGPT's voice mode; natively audio-in/audio-out, handles interruptions and turn-taking natively. **`gpt-realtime-2.1-mini`** is user-selectable in a dropdown (~1/3 price).
- **Secretary reasoning + extraction (text side): OpenAI Responses API** with the current flagship text model for post-conversation extraction and dashboard-layout generation (structured outputs / JSON schema mode).
- **Transport: WebRTC** from the browser directly to OpenAI (lowest latency; do NOT proxy audio through our server).
- **Frontend: Next.js 15+ (App Router) + TypeScript + Tailwind.**
- **Auth: Better Auth** (self-hosted, open-source; we own the user data).
- **Database: Postgres + Drizzle ORM** (local via Docker; deployable to Neon/Supabase).
- **Backend: Next.js API routes** — ephemeral Realtime secrets, authenticated CRUD, extraction jobs.
- **Text-mode fallback:** the same secretary over typed chat, sharing all state.

## Key Realtime API facts (so you don't need to look them up)

1. **Ephemeral auth flow:** server route calls `POST https://api.openai.com/v1/realtime/client_secrets` with the real `OPENAI_API_KEY` for the chosen model; returns a short-lived client secret the browser uses for the WebRTC SDP exchange. Real key never reaches the client.
2. **Connection:** `RTCPeerConnection` + mic track + data channel (`oai-events`) for JSON events; remote audio track into an `<audio>` element.
3. **Session config** (`session.update`): system instructions (secretary persona + briefing context — see below), voice (`marin`/`cedar` most natural; expose all built-ins), `turn_detection: { type: "semantic_vad" }` (fallback `server_vad`), input+output transcription enabled for live transcripts.
4. **Interruptions:** barge-in must cancel assistant audio instantly (`response.cancel` + clear buffer). Single most important quality detail.
5. **Tool calling is native** in Realtime sessions: register tools, handle `response.function_call_arguments.done`, return results via `conversation.item.create`, then `response.create`.
6. If you have web access, verify endpoint shapes at `platform.openai.com/docs/guides/realtime`; the architecture above is correct.

## Login & security (required, not optional)

**Authentication — Better Auth:**

- Email + password (with verification) and **Google + Apple** social sign-in (Apple matters for the iOS roadmap)
- **Passkeys** (WebAuthn plugin) offered as preferred method after first login; **optional TOTP 2FA** in settings — 2FA ships in V1, not MVP (matches F-3 on the spec board)
- **Transactional email via Resend** for verification + forgot-password; `EMAIL_FROM` stays `onboarding@resend.dev` until we verify a domain
- **Timezone capture (load-bearing):** capture the browser timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) at signup, store it on the user record, editable in settings. Every briefing, due-date, and "overdue" computation uses this — never compute in server time.
- Secure session cookies (`httpOnly`, `Secure`, `SameSite=Lax`), rotating tokens, sane expiry/refresh; forgot-password with single-use expiring tokens
- Styled auth pages matching the app (dark-mode-first), not default forms

**API/endpoint security:**

- Every API route requires an authenticated session — above all `/api/realtime/token`
- **Per-user rate limits & quotas** on voice sessions (e.g. 30/day, 1 concurrent; env-configurable), Postgres-backed sliding window
- **Usage tracking** per user (sessions, duration, tokens from Realtime usage events) in a `usage` table; global kill-switch (`VOICE_DISABLED=true`)
- Zod validation on every route; typed errors; no stack traces in prod
- Security headers via middleware: CSP (allow OpenAI/WebRTC origins), HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors 'none'; Better Auth CSRF stays on
- Secrets only in `.env.local`; `.env.example` documented

**Data protection:**

- Every query scoped by `userId` — write a test proving user A cannot read user B's tasks/conversations
- Settings: export my data (JSON), **delete account** (hard-delete everything)
- Transcripts and tasks belong to the user

## The Secretary Brain (the core of this product)

### Data model (Drizzle/Postgres)

- `projects` — id, userId, name, color, status (active/someday/archived), createdAt
- `tasks` — id, userId, projectId?, title, notes, status (`inbox` | `todo` | `in_progress` | `blocked` | `done` | `dropped`), dueAt?, remindAt?, priority, source (`spoken` | `typed` | `inferred` | `suggested`), createdFrom (conversationId), startedAt?, completedAt?, postponedCount, lastNudgedAt?, procrastinationScore (computed)
- `events` — id, userId, title, startsAt, endsAt?, location?, source, conversationId?
- `checkins` — id, userId, taskId, type (`nudge` | `user_update` | `auto_detected`), note, at — the follow-up history ("asked about this Tue, user said Friday")
- `memories` — durable facts/preferences ("sister's name is Priya", "hates morning meetings")
- `conversations` — id, userId, mode (`voice` | `text`), startedAt, endedAt?
- `messages` — id, userId, conversationId, role (`user` | `assistant` | `tool`), content, mode (`voice` | `text`), createdAt; the message id is the **provenance anchor** — task/event provenance links deep-link to the exact message
- `layout_specs` — AI-generated dashboard layouts (JSON), versioned, per user
- `usage` — voice minutes/tokens per user

### Realtime session tools (register all of these in the voice session)

`create_task`, `update_task` (incl. status transitions + postpone with reason), `complete_task`, `create_project`, `create_event`, `get_agenda` (today/tomorrow/date), `get_overdue`, `get_tasks` (filterable), `remember_fact`, `recall_facts`, `get_current_datetime` (server truth, user's timezone), `search_history`. The model should call these mid-conversation — when the user says "I need to renew my passport before the Mexico trip in September," that's a `create_task` (+ maybe `create_event`) without being asked.

### Session-start briefing (this creates the "hello → did you do xyz?" behavior)

Before minting each voice token, the server assembles a **briefing context** injected into the session's system instructions:

- Current date/time in the user's timezone (explicit — the model must never guess the date)
- Overdue tasks (with how overdue), due today/tomorrow, today's events with times
- Stalled items (in_progress with no activity ≥ N days), top procrastinated items
- Open loops from prior conversations ("user said they'd decide on the venue by today")
- Relevant memories

Persona instructions: *a warm, sharp, lightly persistent human secretary.* Greets with the most important follow-up first when something is overdue; asks about task status naturally; never lectures; celebrates completions briefly; batches nudges (max 2–3 per greeting, tracked via `lastNudgedAt` so the same item isn't nagged twice in a day).

### Post-conversation extraction pass (safety net)

After each conversation ends (voice or text), run a background extraction job: cheap text model over the transcript with a strict JSON schema → catches any tasks/events/dates/commitments/status-updates the realtime model didn't log via tools → dedupe against existing rows (fuzzy title + date match) → upsert with `source: 'inferred'`. Also detect **status signals** ("yeah I sent that this morning" → mark done; "I'll do it Friday" → postpone + increment postponedCount + checkin row).

### Procrastination detection

Computed `procrastinationScore` per open task from: postponedCount, age vs. typical completion time, times nudged without status change, proximity/passage of due date. Surface top offenders in briefings and in a dedicated dashboard zone ("You've pushed 'call the accountant' 4 times over 3 weeks").

### Predictive/suggested tasks

A periodic (and post-conversation) job proposes tasks the user hasn't mentioned: recurring patterns ("rent reminder appeared the last 3 month-ends"), implied prerequisites ("flight booked → suggest: check passport, book airport transfer"), seasonal/annual (tax season, renewals mentioned last year). These land as `source: 'suggested'` in a "Suggested" zone — one tap/word to accept or dismiss; the secretary may mention at most one per conversation ("Want me to add travel insurance for the Mexico trip?").

## The Adaptive Dashboard (the anti-Notion)

The dashboard is **generated, not configured**. No empty states the user must design; the AI organizes it and reorganizes it as the user's life changes.

- **Layout spec system:** the layout is a JSON document (schema you define) composed from a fixed component palette: `kanban_board`, `task_list`, `timeline`, `calendar_strip`, `stat_tiles`, `overdue_callout`, `procrastination_zone`, `suggested_zone`, `project_grid`, `focus_card`. The text model generates/updates the layout spec from the user's current data shape (e.g. many due dates → calendar strip rises to top; one huge project → project gets its own board; quiet week → minimal focus view). A renderer maps spec → React components. **The AI adapts the layout; the components stay hand-built and polished** — never AI-generated HTML at runtime.
- Layout regenerates on meaningful data-shape changes (debounced) with a subtle "Layout updated — see what changed / revert" affordance; users can **pin** sections to lock them; every layout version is stored (`layout_specs`) and revertible.
- **Fixed alternate views** always available in a view switcher, spreadsheet-adjacent and fast: **Board** (Trello-style by status or project), **List** (dense, sortable/filterable table — the "spreadsheet" feel: columns for task, project, due, status, last activity, times postponed), **Calendar**, **Timeline**. Done items show crossed-off with satisfying animation; sections for pipeline/someday; overdue always visually loud.
- The dashboard is also **what the secretary reasons over** — same data, one source of truth. The user watches the board update live while talking (task cards slide in as the secretary logs them — this moment is the product's magic; make it feel great).
- Every AI-created item shows its provenance ("from Tue's conversation" — tap to jump to that transcript moment) and is editable/deletable by hand.

## Voice UI spec — mimic ChatGPT/Claude voice UX (follow closely)

Dark-mode-first, light mode supported. Minimal, generous whitespace, smooth 60fps animations, proper focus states. It should feel *better* than a demo — this is the product.

1. **App shell (signed in):** two primary surfaces — **Chat** (assistant thread) and **Dashboard** — with instant switching (tabs on mobile web, sidebar on desktop). A compact "today strip" (next event, #overdue, #due today) is always visible in the shell header.
2. **Chat input bar:** right-aligned **mic icon** (dictation) and **voice-mode icon** (audio-waveform glyph, like ChatGPT's) entering live conversation.
3. **Dictation mode (tap mic)** — exactly the ChatGPT/Claude pattern: input bar becomes a **live waveform** driven by real mic levels (Web Audio `AnalyserNode`, not canned), **✗ on the left** (cancel, discard), **✓ on the right** (accept → transcribe via the current best transcription model → text lands in input for review), subtle pulse + elapsed timer. Transcription is its own authenticated endpoint (`POST /api/transcribe`) with its own per-user rate limit — a separate path from the Realtime session.
4. **Live voice mode (tap voice-mode icon)** — full-screen takeover like ChatGPT advanced voice: centered **animated orb** (idles gently; ripples with the user's voice; pulses with assistant audio — both from real levels), status hints only when helpful, bottom controls: **mute**, **live-transcript toggle** (slide-up panel), **✗ to end** (returns to chat, transcript inserted). **Model dropdown top-corner: "GPT Realtime (best)" [default] / "GPT Realtime Mini (faster/cheaper)"** — persists per user; mid-call switch gracefully reconnects with a "switching…" toast. **Secretary extra:** while in voice mode, when a tool call creates/updates a task or event, show a small **card toast** ("✓ Added: Renew passport — due Sep 2") stacking unobtrusively; tapping opens the dashboard.
5. **Dashboard** renders the adaptive layout + view switcher (Adaptive / Board / List / Calendar / Timeline). Checking off a task anywhere animates the cross-off.
6. **Briefing moment:** when the user opens the app with overdue/due-today items, the chat shows a compact **briefing card** (same content the voice greeting uses) — so the "hello → did you do xyz" behavior exists in text too.

## Features to build (in order)

1. **Auth + database foundation:** Better Auth, full Drizzle schema above, protected shell, auth pages.
2. **Voice session core** (`lib/realtime/` — framework-agnostic, UI-free for future mobile reuse): connect/disconnect, mic permissions, session config, events, interruptions, reconnect, model selection.
3. **Chat + dictation + live voice UI** (specs above) with transcripts persisting server-side.
4. **Secretary tools v1:** the full tool list wired to Postgres; briefing context injection; date/time truth; card toasts in voice mode.
5. **Dashboard v1:** List + Board fixed views over real data, cross-off animations, provenance links.
6. **Extraction pass + checkins:** background job, dedupe, status-signal detection, postponedCount.
7. **Adaptive layout engine:** layout spec schema, generator, renderer, pin/revert, "layout updated" affordance.
8. **Procrastination scoring + suggested tasks** + their dashboard zones + nudge batching (`lastNudgedAt`).
9. **Calendar + Timeline views; search across tasks/history.**
10. **Settings:** voice picker, default model dropdown, persona editor, passkeys/2FA, data export, delete account.

## Non-functional requirements

- Time-to-first-audio after user stops speaking should feel < 1s; profile and log latency.
- Handle mic-permission denial, network drop mid-call (auto-reconnect + session resume), daily-quota-reached, and `VOICE_DISABLED` maintenance mode — each as a friendly designed state with one clear recovery action (see W7 on the spec board), never a raw error. Safari + Chrome + mobile browsers.
- Provider code behind a `VoiceProvider` interface (future Gemini Live/ElevenLabs swap without UI changes).
- Extraction/layout jobs must be idempotent (safe to re-run) and never duplicate tasks.
- README: env vars, DB migrate, OAuth app setup (Google/Apple), local dev with Docker Postgres.

## Verification

Run the dev server and walk me through: sign up → verify email → passkey sign-in → dictate a message (waveform, ✗ cancels, ✓ transcribes) → enter voice mode → say "I need to file my expense report by Friday and I'm seeing Sam for lunch Thursday at noon" → watch task+event card toasts appear → open dashboard: both items present with provenance → say "actually push the expense report to Monday" → postponedCount incremented → mark a task done by voice → cross-off animates → end call → transcript in history → **time-travel test:** manually set a task overdue in DB, start a new session, say "hello" → secretary asks about it by name → same briefing appears as a card in text chat → switch model mid-call via dropdown → second user account sees none of user 1's data → rate limit triggers at the cap.

---

## Notes for Kiron (not part of the Claude Code prompt)

**What changed in v3:** the app now has a spine — the Secretary Brain. Everything you described maps to specific mechanisms: "listens for dates/meetings/todos" = realtime tool calls + a post-conversation extraction safety net; "knows what time and date it is" = server-injected date/time (models are genuinely bad at this without it); "checks if you've finished or started" = checkins + status-signal detection + nudge batching; "hello → did you do xyz" = the briefing context injected at session start; "things you've been procrastinating" = a computed score from postpone/nudge history; "tasks you haven't even mentioned" = the suggested-tasks job; "spreadsheet-like but constantly adapting" = the layout-spec system where the AI rearranges hand-built polished components (that constraint is what keeps it beautiful *and* adaptive — pure AI-generated UI at runtime always ends up ugly and janky).

**The companion spec board** (`secretary-spec-board.html`) has the full user-story backlog (Trello-style), wireframes for every screen, and the data model — hand it to Claude Code alongside this prompt, or to any developer.

**Build order matters:** phases 1–5 are a lovable product on their own (talk → tasks appear → organized views). The adaptive layout engine (7) and predictions (8) are the moonshot features — good that they come after the foundation is solid.

**Prior stack decisions (unchanged from v2):** OpenAI Realtime `gpt-realtime-2.1` flagship default + mini in a dropdown (~$0.04–0.10/min vs ~1/3 that); Better Auth over Clerk (own your data, free, passkeys/2FA built in, Apple sign-in ready for iOS later); WebRTC direct from browser; ephemeral tokens only for logged-in users with per-user rate limits so nobody can burn your OpenAI bill.
