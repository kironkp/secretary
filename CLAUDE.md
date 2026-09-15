# secretary

## READ FIRST (2026-09-15 handoff)

> **Production was down when this was written.** Heroku is crash-looping on a
> deploy of an unrelated repository (`kironkp/personal-assistant`, release v8,
> commit `9701f7d9` — not in this repo). Check `heroku ps -a secretary-kiron`
> before assuming it was fixed. `docs/HANDOFF.md` §Heroku has the sequence.

1. `docs/HANDOFF.md` — what is genuinely broken, ranked, and what to do first.
   The user's own verdict on this build: **"the flaws are horrendous, canvas is
   virtually unusable."** Take that at face value; do not defend the code.
2. `docs/LOGBOOK.md` — what changed this session and why, per version.
3. This file — the standing rules below still hold.

**Do not start new features until the Canvas is genuinely usable.** The canvas
checkbox alone took four attempts and was still reported broken. All four
targeted the *wiring*, which is now correct. A later audit found the probable
real causes in layers the test suite cannot see: **no `<meta name="viewport">`
in the canvas iframe** (so iOS applies its ~350 ms tap delay) and an **18×18 px
tap target** sitting on a `data-link` row, so a near-miss navigates away.
**Nothing here was ever verified in a real browser** — there was no browser
automation available. Verify before building.

**Heroku is the source of truth as of 2026-09-15.** The Mac is for development
and beta testing only; nothing in the local database is authoritative. Deploys
run from `.github/workflows/deploy.yml`, not Heroku's dashboard integration. The
3:00 AM `com.secretary.dailysync` job overwrote Heroku from local and is
DISABLED — re-enabling it would destroy production nightly. See the README's
Deployment section for what still has to happen before Heroku can take over.

**The Canvas target is the `canvas-board` design artifact**, which the user
endorsed. Its thesis: *"Stop painting one picture. Start arranging a board of
things. The shell owns the frame — position, size, order, type scale, every
animation. The model owns the fill."* Judge the Canvas against that, not against
whether the code runs.


## North star: JARVIS
- The goal is ONE persistent intelligent system you talk to — it knows the
  user's information, can act on it, and fluidly manipulates a visual
  workspace while you talk. Not "a good dashboard" plus "a good voice
  assistant". The UI is the visual extension of the conversation.
- Voice is the PRIMARY interaction; touch complements it. Never build separate
  "voice state" and "touch state" — a spoken move and a dragged move are the
  same operation on the same object.
- Whatever voice provider is active (OpenAI Realtime today, Hume later) uses
  the SAME Secretary tool system. Never a second set of business logic.
- The Canvas is a WORKSPACE, not a picture. Shell owns geometry: position,
  size, order, z-order, spacing, type scale, visibility, scroll, expansion,
  selection, interaction state, animation, drag, transitions, viewport state.
  The model owns the CONTENT inside visual objects. "Move the album up",
  "make these smaller", "hide the finished ones" must require NO model call.
- PERCEIVED CONTINUITY beats literal patching. A full rebuild is acceptable
  internally if the user never experiences one. Never: blank → partial HTML →
  layout jump → scroll reset. Always: current state → objects move → new
  state. Motion communicates continuity and causality, never decoration —
  reuse the app's real language (340ms, the nav-tabs easing pair, leading edge
  first). Honor prefers-reduced-motion.
- Do NOT build a rigid component registry for the Canvas. Widget/type ids may
  exist as metadata, but shell code must never become an `if type === …` tree.
  A conversation might become a priority stack, a timeline, a cluster of
  notes, a comparison, one giant card, or something not yet designed.
- Judge success by feel, not by exit codes: time to first visible response,
  whether old state stayed stable during generation, whether scroll and
  expansion and object identity survived, whether interruption and undo work.
  The metric is "does this feel like a living workspace I manipulate with my
  voice", not "did the model return HTML".
- Migration is incremental; never throw away the working backend, database,
  tools, or visual capability to get there.

## Adaptive dashboard (LayoutPlan system)
- Dashboard layout is data: a LayoutPlan rendered by the layout renderer.
  Never hardcode section order; change DEFAULT_PLAN or the planner instead.
- The component registry is the only UI vocabulary. New components = registry
  version bump + SPEC table update. Generated code never registers itself.
- The validator is load-bearing. Planner/chat output is DATA; it never reaches
  innerHTML/JSX unescaped. Never skip or weaken validation to make a test pass.
- The Spreadsheet view never adapts. Do not add adaptive behavior to it.
- Emphasis changes are free; SYSTEM-initiated reordering needs
  days_since_layout_change >= 1 plus a user-visible why. USER-initiated changes
  apply immediately.
- The Canvas is the only surface where the model writes markup: sanitized
  static HTML in a sandboxed iframe, no scripts/handlers/forms/external loads
  ever. The shell owns all interactivity (data-expand, data-link, data-check —
  the last is the one sanctioned write: tap an open task to mark it done, ids
  from SIGNALS.tasks only). Everywhere else, model output is data.
  `class` is namespaced to `cv-`/`sl-` by the sanitizer: the same sanitizer
  guards the one path that renders model markup INLINE in the app document
  (approved slow-loop templates), where a free-form Tailwind class would be an
  app-covering overlay that never passes through safeStyle.
- Changing what is already on the canvas is `edit_canvas`, never
  `paint_canvas`. A canvas operation must never blank the canvas: the new
  snapshot is seeded with what is on screen, an edit holds it until the
  replacement completes, and a failed generation leaves it untouched.
- Full spec: docs/adaptive-ui/SPEC.md — source of truth. To change behavior,
  update the spec first, then the code.
