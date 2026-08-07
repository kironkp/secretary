# Claude Code prompt — UI overhaul: light/dark themes, modern chat, dashboard redesign, split-screen

**Before you run this:** open the pinned **"Secretary Target Output"** artifact (Claude sidebar), download/copy its HTML, and save it as `planning-documents/secretary-target-output.html` in the repo. The prompt below has Claude Code read it as the dashboard design reference — it will stop and ask if the file is missing.

Copy everything below the line into Claude Code, run from the repo root.

---

The voice feature now works — **do not touch its plumbing** (details in Ground Rules). This task is a visual/UX overhaul with four goals:

1. **Light + dark themes, defaulting to LIGHT.** The app is currently hard-coded dark.
2. **Redesign the chat page** — it's ugly. Kill every emoji used as UI chrome (especially the old-fashioned 🎙 mic) and replace with a clean SVG icon set.
3. **Redesign the dashboard** to match my saved design reference: `planning-documents/secretary-target-output.html`. The current default (stat tiles + a mostly-empty kanban with an "AI-arranged" banner) is ugly and confusing.
4. **Split-screen mode**: chat on the left, dashboard on the right, with the dashboard updating live as the secretary logs tasks — including *during* a voice call (voice docks into the chat pane instead of covering the screen).

Work in phases, in this order, committing per phase. After each phase stop, run the app, and tell me exactly what to look at before continuing.

## Architecture map (read these first)

- `app/globals.css` — Tailwind v4 (`@import "tailwindcss"` + `@theme`) with a dark-only palette: `--color-bg/surface/surface-2/card/edge/ink/muted/faint/accent/ok/warn/danger/grape`. A comment literally says "Light mode lands later." Later is now.
- `app/layout.tsx` — root layout (fonts, body). `app/(app)/layout.tsx` — app shell: sticky header with today-strip pills + `components/shell/nav-tabs.tsx`.
- `components/ui.tsx` — Button/Input/Label/notes primitives.
- Chat: `components/chat/chat-thread.tsx` (thread + briefing card + input bar + Talk button), `components/chat/dictation-bar.tsx`, `components/chat/voice-mode.tsx` (full-screen `fixed inset-0` overlay), `components/chat/use-voice-session.ts`.
- Dashboard: `app/(app)/dashboard/page.tsx` (server component, fetches tasks/events/layout) → `components/dashboard/dashboard-views.tsx` (view switcher: adaptive/board/list/calendar/timeline) → `adaptive-view.tsx` (renders AI layout spec), `task-views.tsx` (Board/List), `zones.tsx` (StatTiles, OverdueCallout, FocusCard, CalendarStrip, ProcrastinationZone, SuggestedZone, ProjectGrid), `calendar-view.tsx`, `timeline-view.tsx`, `shared.tsx` (CheckButton ✓, ProvenanceLink 💬, formatting helpers).
- Adaptive layout engine: `lib/layout/spec.ts` (fixed component palette + `DEFAULT_SPEC`), `lib/layout/generator.ts`.
- `components/spreadsheet/search-box.tsx`, `app/(app)/spreadsheet/page.tsx`, settings pages, auth pages — all inherit the token palette; they must not break when tokens go light.

## Ground rules

- **FROZEN — restyle only, never change logic:** `lib/realtime/openai-webrtc.ts`, `lib/realtime/remote-audio.ts`, `app/api/realtime/*`, `components/chat/use-voice-session.ts`. The voice bug was just fixed; do not regress it.
- The Talk button's click handler MUST keep calling `unlockRemoteAudio()` synchronously in the tap (iOS gesture unlock), wherever the button moves or however it's restyled.
- Keep the `?voicedebug=1` overlay and `[voice-debug]` beacons working.
- Keep dictation, cross-off animation (`.cross-off`), provenance deep-links, and the anchor-highlight flash working.
- No new heavy dependencies. Allowed: `lucide-react` for icons; optionally `next-themes` (or hand-roll the theme with a cookie — your call, but no FOUC either way). No framer-motion — CSS transitions are enough.
- CSP is strict (`next.config.ts`) — no external fonts/scripts/images; everything bundled.
- `npm run build`, lint, and vitest must pass after every phase.

## Phase 1 — theme system: light + dark, default LIGHT

1. Restructure `globals.css`: define semantic CSS variables on `:root` (light values) and `[data-theme="dark"]` (current dark values), and map Tailwind tokens via `@theme inline` so existing `bg-card`/`text-ink`/`border-edge`/etc. classes keep working unchanged in both themes.
2. Light palette (tune tastefully, keep these relationships — must pass WCAG AA for text tokens on their surfaces):
   - `bg #f6f7f9` · `surface #ffffff` · `surface-2 #eef0f4` · `card #ffffff` · `edge #e4e7ee`
   - `ink #171a21` · `muted #5a6375` · `faint #8b93a5`
   - `accent #4a6fe8` (the dark theme keeps `#7aa2ff`; the light accent must be dark enough for white-on-accent buttons)
   - `ok #15803d` · `warn #b45309` · `danger #dc2626` · `grape #7e22ce` (dark theme keeps existing brighter variants)
3. Theme selection: default **light** for everyone (not system). Persist choice (cookie + localStorage), apply `data-theme` on `<html>` server-side in `app/layout.tsx` from the cookie so there's no flash. Toggle = sun/moon icon button in the app header, plus an Appearance section on `app/(app)/settings/page.tsx` (Light / Dark).
4. Sweep ALL hardcoded colors into tokens: `bg-[#26304a]` user bubble in `chat-thread.tsx` (make a `--color-bubble` token: light `#e8edff`-ish, dark `#26304a`), any inline hexes in dashboard/timeline/calendar components, scrollbar/selection if styled. The voice orb's radial gradient may stay as-is (it reads fine on both), but the voice-mode background must theme.
5. Verify every page in both themes: chat, dashboard (all 5 views), spreadsheet, settings, sign-in/up, soundtest, voice mode overlay.

**Checkpoint:** screenshots (or me looking) at chat + dashboard in light and dark. No unreadable text anywhere.

## Phase 2 — icon system + chat redesign

**Icons:** add `lucide-react`. Replace every emoji used as UI chrome, consistent sizing (16–18px, stroke ~1.75), `aria-label`s preserved:
- 🎙 dictation → `Mic`; voice-mode mute 🎙/🔇 → `Mic`/`MicOff`; transcript ☰ → `ListText`/`AlignLeft`; end-call ✕ → `X` or `PhoneOff`; send ↑ → `ArrowUp`
- CheckButton ✓ → `Check`; ProvenanceLink 💬 → `MessageSquare` (tiny, muted); 📌 pin → `Pin`; ↩ revert → `Undo2`; ✨ → `Sparkles`; ⚠ → `TriangleAlert`; 📅 → `Calendar`; ☀️ (briefing) → `Sun`; 😬 procrastinating zone → keep playful but iconify (`Flame` or `ClockAlert`)
- Emojis remain ONLY inside assistant/persona message *content*, never in UI chrome. The Talk button keeps its custom waveform SVG (it's good) — restyle sizing/weight to match the new set.

**Chat page (`chat-thread.tsx` + input bar):**
- Thread in a centered column (~`max-w-2xl` in full-width mode), generous vertical rhythm, no `h-[calc(100dvh-150px)]` hack — proper flex column with only the thread scrolling; input pinned bottom with safe-area padding.
- Bubbles: user right-aligned in `--color-bubble` with `text-ink`, assistant left-aligned on `surface` with a hairline `edge` border; radius ~14px; the tiny "🎙 voice" badge becomes a subtle `Mic` glyph + "voice" in `faint`.
- Briefing card: restyle as the day's header card — date line with `Sun` icon, overdue rows in danger, due-today in warn, events with `Calendar`, suggestions with `Sparkles`; clear hierarchy, no emoji soup.
- Input bar: single rounded container on `surface` with `edge` border, focus ring in accent; textarea placeholder in `faint`; icon buttons (Mic, Talk) with hover states; primary send button appears only when there's text (as now).
- Dictation bar: same container styling, waveform accent-colored, `X` cancel / `Check` accept as icon buttons.
- Empty state: friendlier welcome using the new icons, both themes.

**Checkpoint:** chat before/after in both themes.

## Phase 3 — dashboard redesign to match the reference

Read `planning-documents/secretary-target-output.html` — my approved visual target (**stop and ask me if it's missing**). It's a static mock: match its layout, zone structure, visual language, and density, mapped onto the real components in `zones.tsx`/`task-views.tsx` with real data. Adapt its palette to the Phase-1 tokens (it was designed dark; derive the light equivalents from the token system, don't hardcode).

Beyond matching the reference:
- The designed overview becomes the **default view**. Wire `DEFAULT_SPEC` in `lib/layout/spec.ts` (and the renderer order in `adaptive-view.tsx`) so the default arrangement reproduces the reference's zone order. Rename the "Adaptive" tab to **"Overview"**.
- Demote the AI-arranged banner: no banner in the default state. When the AI has rearranged (version > 0), show one quiet line ("Arranged for you · revert") with `Sparkles`/`Undo2` icons; pin affordance appears only on section hover.
- Kanban: hide empty columns behind a "+ n empty" hint or collapse them; never render four hollow columns for 4 tasks. Meaningful empty states for every zone (e.g. overdue zone absent when zero — not a "0 overdue" box).
- Stat tiles: compact single row, number + label + small icon, accent only where it means something (overdue tile red only when > 0).
- Keep all interactions working: cross-off animation, check buttons, provenance links, view switcher (Board/List/Calendar/Timeline stay as secondary views), pins, revert.

**Checkpoint:** dashboard vs. the reference file side by side, light + dark.

## Phase 4 — split-screen mode + live-updating dashboard + docked voice

**Layout:** on `lg+` viewports, `/chat` becomes a split workspace: chat pane left (fixed ~`30rem`, own scroll), dashboard right (fills remaining width, own scroll). A header toggle (`PanelRight` icon) switches between split and chat-only, persisted (localStorage is fine). Mobile/tablet keeps the current tabbed navigation; `/dashboard` remains a standalone route.

**Live updates — this is the product's magic moment (spec D-5: "cards slide onto the board while I'm still talking"):**
- The right pane must reflect new/changed tasks within ~2s of the secretary logging them, without a full page navigation.
- Wiring that already exists: text chat calls `router.refresh()` after sends; voice tool calls surface as `toolResult` events (the toasts) in `use-voice-session.ts` — trigger a dashboard refresh from there too (calling `router.refresh()` from the existing event subscription in the UI layer is fine and does NOT count as touching frozen voice files). Add refresh-on-window-focus. If RSC refresh proves too coarse, a small client fetch of a JSON endpoint is acceptable — your call, keep it simple.
- Newly appearing task cards get a subtle entrance animation (fade/slide + brief accent ring, CSS only). The cross-off animation must still play when a task completes from either pane.

**Docked voice (in split mode only):** instead of the `fixed inset-0` overlay, `VoiceMode` renders as a compact dock inside the chat pane (bottom, replacing the input bar): small orb (~56px, same gradient/level animation), status line, mute/transcript/end icon buttons; transcript toggle expands upward inside the pane. The dashboard stays fully visible and updates live while I talk. Non-split (mobile/chat-only) keeps the full-screen overlay. This is a **presentation-layer** change only — same `useVoiceSession` hook usage, same unlock call in the Talk tap, zero changes to the frozen files.

**Checkpoint:** side-by-side demo — start a voice call in split mode, say "remind me to buy milk tomorrow", and I should watch the task appear on the right while the call continues.

## Final QA (after Phase 4)

- Both themes × {chat, dashboard all views, split mode, spreadsheet, settings, auth pages, voice full-screen + docked, dictation}.
- Widths: 390px (iPhone), 768px, 1280px, 1600px.
- Voice regression test: start call, hear audio, barge-in works, transcript panel works, `?voicedebug=1` overlay still renders, task toast → dashboard update.
- `npm run build` + lint + vitest green. No remaining emoji in UI chrome (grep the components tree for emoji codepoints), no remaining hardcoded theme hexes outside `globals.css`.
