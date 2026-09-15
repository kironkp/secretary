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

**Adaptive-UI track** (docs/adaptive-ui/SPEC.md, Aug 2026) — all phases in:

| Phase | What | Status |
|---|---|---|
| 0 | Recon → INTEGRATION.md | done |
| 1 | LayoutPlan v2: registry, validator, rules planner, signals, renderer | done |
| 2 | LLM planner (background refinement) + chat layout tools (tier 1) | done |
| 2.5 | The Canvas: model-painted, sanitized, sandboxed + floating chat | done |
| 3 | Slow loop: wishlist → `claude -p` build → approval → hot-register | done |
| §11 ×5 | Agent layer: persona/stakes/pipelines · nag engine · entities/clarifications · ASR lexicon · voice fast/slow split | done |

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

## Testing from a phone (no Tailscale)

`npm run dev:public` — publishes the dev server with **Tailscale Funnel** at

    https://kironkps-macbook-pro-1.taildfcf4.ts.net:8443

Open that in any phone browser — cellular or Wi-Fi, no VPN or client app
needed. Sign in with email/password (passkeys are currently bound to the
localhost origin, so they won't prompt here).

- **First run**: Funnel needs a one-time tailnet approval — the script prints
  the approval link; open it, enable Funnel for this machine, re-run. Public
  DNS for the URL can take ~10 min to propagate on the first publish.
- **Known issue**: some macOS Tailscale builds accept the Funnel config and
  then silently drop it — `dev:public` detects this and tells you. Update the
  Tailscale app (menu bar icon → Check for Updates) and re-run; until then
  `npm run tunnel:cf` is the working public path.
- **Check / stop**: `npm run funnel:status` · `npm run funnel:off`. While
  Funnel is on the URL is reachable by anyone — the app is sign-in-gated and
  voice minting is quota'd, but treat the URL as private and run
  `npm run funnel:off` when you're done testing.
- On the tailnet, Funnel serves the same `:8443` URL, so `npm run https-proxy`
  is only needed as a fallback when Funnel is off.
- **Fallback for networks that block `*.ts.net`**: `npm run tunnel:cf`
  (requires `brew install cloudflared`) prints a random
  `https://<something>.trycloudflare.com` URL. Append that origin to
  `TRUSTED_ORIGINS` in `.env.local` for the run and restart the dev server,
  or sign-in POSTs from it will be rejected.

## Deployment — Heroku is the source of truth

**As of 2026-09-15 this reversed.** Heroku
(`https://secretary-kiron-606a3b1e1a65.herokuapp.com`) holds the real data and
is the app you use. The Mac is for development and beta testing only; its
database is a scratch copy and nothing there is authoritative.

- Code: private GitHub repo (`kironkp/secretary`).
- CI runs from `.github/workflows/deploy.yml` on every push and PR: Postgres
  service, schema push, tsc, lint, tests, production build.
- Heroku's dashboard GitHub integration deploys `main` automatically once
  those checks pass ("Wait for GitHub checks to pass before deploy" must stay
  ticked). It is connected to `kironkp/secretary`; it was once pointed at the
  wrong repo (`kironkp/personal-assistant`, no start script, crash-loop), so
  check the Deploy tab if a release looks alien.
- The workflow also carries a dormant deploy job. Leave `DEPLOY_ENABLED` and
  `HEROKU_API_KEY` unset while the dashboard deploys, or the two race.
- The dashboard's GitHub connect popup loops in Firefox and Safari (it needs a
  cross-site cookie both block by default). The link is usually created
  anyway; Heroku's API shows it even when the page does not.
- Pull requests run the full CI without deploying, so a beta branch is checked
  before it ever reaches `main`.
- Heroku-side Postgres backups: `heroku pg:backups -a secretary-kiron`.

### The nightly local → Heroku sync is gone

`scripts/sync-to-heroku.mjs` copied local over Heroku every night (16 of 29
tables, and it had failed silently since 2026-08-19). It is deleted. The launchd
job `com.secretary.dailysync` that ran it stays unloaded, plist renamed
`.disabled`. Do not resurrect either: Heroku is the truth now, and a copy in
that direction would wipe a day of production.

The one-time cutover copy ran on 2026-09-15 with `scripts/copy-db.ts`: every
public table, foreign-key order, one transaction, counts verified before
commit. It is the tool for any future whole-database move (either direction —
it is just `--from` and `--to`), and it refuses to run if the two schemas
differ. It never runs on a schedule.

A separate launchd job, `com.kironkp.secretary-nightly-push`, still runs
`git push origin main` at 02:00. Harmless before; now that Heroku auto-deploys
`main`, **a commit left on local `main` deploys overnight.** Keep unfinished
work on a branch.

### Still outstanding on Heroku

- 10 config vars have local values but are not set there: `ANTHROPIC_API_KEY`,
  `CLAUDE_BRAIN`, `ADAPTIVE_V2`, `ELEVENLABS_*`, `REALTIME_MODEL_*`, `VAPID_*`.
  Until they are, every turn falls back to OpenAI and the dashboard renders the
  old v0 layout. `SHOP_DISABLED=true` belongs in the same `config:set`.
- The Shop and the sim harness spawn headless Claude Code against this checkout
  and cannot run on a dyno. They stay on the Mac and need to point at the
  Heroku database.

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
