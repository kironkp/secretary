# Secretary

A genius secretary you talk to. Voice-first personal assistant: it captures
tasks, dates, and meetings from natural conversation, follows up on what you
owe, and keeps an AI-adaptive dashboard of your life.

Spec lives in `planning-documents/` — the build order is the numbered
"Features to build" list in `claude-code-prompt-voice-assistant.md`; the
user-story backlog, wireframes, and data model are in
`secretary-spec-board.html`.

## Build progress

All nine phases are in.

| # | Phase | Status |
|---|---|---|
| 1 | Auth + database foundation | done |
| 2 | Voice session core (`lib/realtime/`) | done |
| 3 | Chat + dictation + live voice UI | done |
| 4 | Secretary tools v1 + briefing injection | done |
| 5 | Dashboard v1 (List + Board) | done |
| 6 | Extraction pass + checkins | done |
| 7 | Adaptive layout engine | done |
| 8 | Procrastination scoring + suggested tasks | done |
| 9 | Calendar + Timeline views; search | done |

Beyond the spec: a **Spreadsheet** page (`/spreadsheet`) shows everything the
secretary has captured — every task/event/fact with its source (spoken, typed,
inferred, suggested), the accountability log of check-ins, full conversation
transcripts, and cross-entity search.

UI (Aug 2026 redesign): light + dark themes (light default, cookie-persisted,
toggle in header/settings); lucide icon system (no emoji in chrome); dashboard
default is the designed **Overview** (stat tiles · next-up hero · 5-week
pressure timeline · project cards · open-loops table — see
`planning-documents/secretary-target.html`); on large screens `/chat` is a
split workspace with a live-updating dashboard pane and voice docked into the
chat column (toggle: panel icon in the header).

How the background intelligence runs (no cron needed):
- **Extraction** (`lib/secretary/extraction.ts`) fires via `after()` when a
  voice session ends and after each text turn; `conversations.extracted_at` is
  the high-water mark so nothing is scanned twice.
- **Suggestions** (`lib/secretary/suggestions.ts`) piggyback on extraction, at
  most once per 24h; they wait as `source='suggested'` + `status='inbox'` until
  accepted/dismissed on the dashboard.
- **Procrastination scores** (`lib/secretary/procrastination.ts`) refresh at
  every briefing build (pure math, no model call).
- **Adaptive layout** (`lib/layout/`) regenerates in the background on
  dashboard load when the data shape changes (bucketed hash, ≥1h apart);
  the page always renders the stored spec synchronously.

Keep this section current as things land.

## Stack

Next.js (App Router) · TypeScript · Tailwind · Better Auth · Drizzle ORM ·
Postgres · Resend · OpenAI Realtime

## Local setup

1. **Env** — copy `.env.example` to `.env.local` and fill in values (each var is
   documented in the file). Minimum to boot: `DATABASE_URL` (default works),
   `BETTER_AUTH_SECRET` (pre-generated), `RESEND_API_KEY` (or leave empty —
   verification links then print to the server console). Voice and dictation
   also need `OPENAI_API_KEY`.

2. **Database** — either:
   - `npm run db:local` — real Postgres via embedded binaries, no Docker/admin
     needed (data in `.pgdata/`), or
   - `docker compose up -d` — if Docker is installed.

   Both serve `postgresql://postgres:postgres@localhost:5432/secretary`.

3. **Schema** — `npm run db:push` (drizzle-kit pushes `lib/db/schema.ts`).

4. **Run** — `npm run dev` → http://localhost:3000

## Tests

`npm test` — user-scoping (user A can never read user B's data), extraction
dedupe + apply (fuzzy matching, status signals, idempotency), and the
procrastination scorer. Needs the database running.

## OAuth setup (optional until you want social login)

- **Google**: console.cloud.google.com/apis/credentials → OAuth client ID (Web)
  → redirect URI `http://localhost:3000/api/auth/callback/google` → paste
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` into `.env.local`. The button
  appears automatically once the keys exist.
- **Apple**: needs an Apple Developer account and an **https** deploy (Apple
  rejects http://localhost). Same pattern: keys in env → button appears.

## Conventions

- Every domain query goes through `lib/db/queries.ts` and takes `userId` first.
  Never query domain tables directly from routes/components.
- The user's IANA timezone (captured at signup, editable in settings) is the
  only timezone briefings and due-date math may use.
- Voice logic lives in `lib/realtime/`, UI-free and behind a `VoiceProvider`
  interface, so React Native can reuse it later.
- Update the build progress table above whenever a phase lands.
