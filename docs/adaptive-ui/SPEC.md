# Adaptive Dashboard — LayoutPlan System (SPEC v1.1)

**Status:** approved design. This document is the source of truth. If code and spec
disagree, the spec wins; if the spec is wrong, change the spec first, then the code.

**For the implementing agent:** you have not chosen this architecture — it was
researched and decided (receipts at the bottom). Your job is to fit it into the
existing codebase with the smallest footprint, matching existing conventions
(framework, styling, state, storage) rather than introducing new ones.

---

## 1. What this is

The dashboard's layout becomes **data**: a `LayoutPlan` JSON object that a
deterministic renderer executes against a fixed **component registry**. A
**planner** produces the plan from the user's current situation ("signals").

Two loops, two clocks:

- **Fast loop (runtime, every session open):** planner → LayoutPlan → validate →
  render. In v1 the planner is hand-written rules; in v2 it becomes a small-model
  LLM call behind the same interface. ~1s worst case. Failure = fall back to the
  previous good plan, then to DEFAULT_PLAN.
- **Slow loop (offline, nightly):** when the planner wants a component that
  doesn't exist, it logs a **wishlist entry** instead of improvising. A separate
  coding-agent job turns accumulated wishes into new registry components — 
  versioned, previewed, human-approved. Runtime never executes generated code.

Non-negotiable invariants (from adaptive-UI research — Findlater & McGrenere
CHI'09, Lavie & Meyer IJHCS'10, Google A2UI's declarative-over-codegen design):

1. **App chrome (tabs, search, provenance UI) is never controlled by the planner.**
2. **The Spreadsheet view never adapts.** It is the audit floor.
3. **Emphasis is free; movement is rationed — for the system.** Variant/accent/
   expand may change every render. *System-initiated* reordering requires
   `days_since_layout_change >= 1` AND a user-visible `why` string on the moved
   section. **User-initiated changes (a chat request, a pin, a tap) apply
   immediately, always.** The rationing exists to protect spatial memory from
   surprises; nothing the user asked for is a surprise.
   **A project card is never "moved by the system"** (v1.02): the system does
   not place cards at all (§2, composition), so a card changing place because
   the data changed needs no why, is not rationed, and does not count as a
   layout change for `days_since_layout_change`. Movement means the sections
   that are not cards and that the user has not placed.
4. **Nothing urgent disappears.** A project is *urgent* when it has late open
   work or `days_left <= 7`. A list is never urgent.
   - **Presence.** An urgent project always has a card. A plan the SYSTEM
     writes (rules, planner) without one is rejected. A user's request that
     would leave an urgent project without a card (hiding it) is refused. A
     card the user hid earlier is back on the board while its project is
     urgent, with a user-visible `why`, in its place by the data.
   - **Order.** The system never places a card (§2, composition): the cards
     the user did not place are in the default order at every render, urgent
     first. So no plan the system produces can have a card that is not urgent
     ahead of an urgent one, unless the user put it there.
   - There is no fixed position. Until v1.02 the rule was "above the fold"
     (the first 8 sections): with six urgent projects no plan could meet it,
     so the default and the rules plan were themselves refused, and it
     refused the user's own requests ("put the shopping list at the top").
5. **At most one `accent: true` project card per plan.** Accent = attention.
   Color meaning (deadline pressure) is fixed by the design system, never by the planner.
6. **Model output is data, never markup.** No planner string may reach
   `innerHTML`/JSX children unescaped. Unknown components/props are rejected.
7. **User overrides beat the planner:** a section the user placed stays at
   its place on the board he was told (§2, composition: his placements are
   applied to every plan, not checked against it). A place is a position
   only; emphasis (variant, accent, what is unfolded) stays the system's on
   a placed card too. The user's own request may move anything, placed or
   not;
   in `calm_mode` the system plan is DEFAULT_PLAN unconditionally (no rules,
   no planner), composed like any other: what he placed, hid and banned
   still holds (v1.02; until then calm mode dropped his arrangement while it
   was on, and a tool that moved a section answered "applied" to nothing);
   one-tap revert to previous plan.
   Every revert is logged (it's a labeled wrong prediction — our accuracy metric).
8. **Mid-session mutation is diff-shaped.** While the dashboard is open, new plans
   apply as animated in-place diffs (sections fade/slide, numbers tick). System-
   initiated mid-session diffs may only be additive or emphasis-level (accent,
   expand, inline, append a section, update values); reorders and removals wait
   for the next session open — unless user-initiated, in which case the whole
   change applies live.

---

## 2. Component registry v1

The only building blocks the planner may reference. Registry lives in code with a
version number; the validator loads prop-schemas from it.

| component      | props                                                                 | notes |
|----------------|-----------------------------------------------------------------------|-------|
| `focus_banner` | `text: string`, `tone: "info"\|"serious"\|"critical"`                 | one line, top of canvas only |
| `hero_next_up` | `event_id: string`                                                    | next hard commitment card |
| `stat_row`     | `tiles: {value, label, tone?}[]` (max 5)                              | |
| `project_card` | `project_id`, `variant: "full"\|"compact"\|"nested"`, `accent?: bool`, `inline_loops?: bool` | `nested` renders subprojects with own progress; `inline_loops` embeds that project's open items |
| `timeline`     | `span_days: 14\|21\|35`, `expanded: bool`                             | since registry v3 (SEC-A007): the projects progress strip, one chip per project (progress, "3/7", next date, late); a tap opens Dashboard › Timeline filtered to it. `expanded` shows every project as a grid; `span_days` is kept for old plans and ignored |
| ~~`open_loops`~~ | —                                                                   | retired in registry v3 (SEC-A007): it repeated every task on the project cards, and it is the List view. A stored plan carrying it drops the section; its removal or pin never blocks a plan |
| `date_chase`   | `item_ids: string[]`                                                  | the "needs a date" strip |
| `people_index` | —                                                                     | |

`DEFAULT_PLAN` (also the fallback and calm mode), since registry v3:
`[hero_next_up, stat_row, timeline(21, false), project_card × each active project (full), project_card × each list, date_chase(all missing), people_index]`

The project cards: urgent projects first (invariant 4's meaning of urgent),
then the rest, each group in the one urgency order every screen uses
(`lib/project-order.ts`: late first by how late, then the nearest date or
deadline, then no date, then name); lists after them.

A plan whose head is the default (nobody arranged it) is measured against the
NEW default for movement and removals (§3 invariants 3 and 8): a product
change to the default is not a system-initiated move.

### Composition (v1.02 r5): a render is composed, not chosen

What is on screen is put together at every render. Three rounds of this rule
were offered on examples and failed on states no example had; since r5 the
gate is a property test, `tests/board-walk.test.ts`, a seeded random walk over
every way the board can change, with a model of its own.

**What a render is made of, in this order.**

1. **Today's system plan**: the planner's plan for exactly these signals when
   there is one, else the rules plan, else (when a move of the system's own
   was refused) the stored board's own sections that are not cards, held,
   with today's rules cards; else DEFAULT_PLAN. From it come the emphasis,
   the whys, the banner and the order of the sections that are not cards.
   Whatever card order it carries is ignored: the system never places a card.
2. **Everything that belongs is drawn.** A card for every active project and
   list; every section of the default board; every section he added. A
   planner cannot drop a default section, as it cannot drop a card. A
   section of the default board that the plan being composed lacks (it was
   hidden or banned when that board was stored and is not now; a planner
   left it out; it was his and he let it go) is put in among the system's
   sections where the rules would keep it (one rule, below),
   BEFORE the place for the cards is worked out (3): nothing of the
   system's is added after the count.
3. **The cards he did not place, in data order** (urgent first, then the one
   urgency order, lists last), in one run where the system's plan has it.
   The right way up, whatever that plan says: **the cards go where the
   fewest of the system's sections end up on the wrong side of them.** Take
   the system's own sections that are not cards, in its order: the ones
   that will be drawn (his left out; one he hid or banned left out too,
   because the stored board does not have it and has to compose to
   itself). Next up and the tiles belong above the cards;
   Needs a date and People belong below; the strip is neither. For each
   place the run could go, count the above-sections that would be under
   the cards plus the below-sections that would be over them. The run goes
   at a place with the lowest count; among those, the nearest to where the
   plan had it (its first own card; a plan with no card of its own, under
   the strip); at equal distance, the upper one. Worked out in one place
   (`runPlace`), which the held path asks too. Total: nothing is refused,
   and a planner keeps its freedom to move one of the system's sections
   with a reason.
   With the system's order the usual one, that is: never above next up or
   the tiles, never below Needs a date or People, and a plan that lists its
   cards first has them right under the tiles, above the strip. With a
   crossing (a planner raises Needs a date above next up, or sinks the
   tiles to the bottom) no place has a count of zero, and the run stays as
   near as it can to where the plan had it: the tiles sunk and the cards
   left where they were is a board that is right, and is left alone.
   (Why: a planner on main put urgent cards above next up; read as "the run
   starts at the first card", such a plan put every card above next up, and
   cards listed last went under People. On the day this version lands, with
   main's row held, the run under the tiles and the strip under the cards
   is main's own look; the next rules plan has the strip above the cards,
   with no reason given, because the cards are outside the movement
   measure.)
4. **What he placed, at its place.** A place is a position on the board he
   was last told (below). Top-counted sections go in in place order, each at
   its place; then bottom-counted ones, each at its place from the end. On a
   board too short for a place they keep the order he was told: none goes in
   front of one already put in.
5. **His hides and bans.** Nothing he hid is drawn, nor any component he
   banned, on any path. One exception (invariant 4, presence): a card he hid
   is back while its project is urgent, saying so.

**A place is a position on the board he was told.** Every request of his goes
through ONE function (`lib/layout/request.ts`): both tools, the pin button,
unpin, Put it back, the Settings page lifting a hide or a ban or removing a
pin, and the preference tool's pin and its ban. It starts from what an open shows now;
changes the state in memory; runs on that state exactly what an open runs;
checks that the board bears out what is about to be said (the section is on
the board, or off it); and only then writes, and answers with that board. If
the check fails, nothing is written and the reply says why in the section's
name, never its key.

- Up one and down one swap with the neighbour, whatever it is. The top is the
  first place under the banner. The bottom is the end.
- After every request, the place of EVERY section he has placed is read again
  from the board he was just told. So places are distinct: they are positions
  on one real board. There is no tie to break and no special "last".
- A place counts from the bottom when nothing "upper" stands below it on that
  board, where upper means a card he has not placed, or one of the system's
  sections that belong above the cards (next up, the tiles, the strip).
  Otherwise it counts from the top. So "to the bottom" stays the bottom when
  a project is added, and "to the top" stays the top. On a board with
  nothing upper at all, everything counts from the bottom; a project made
  later has its card above.
- Known cost, accepted: a place remembered past the end of a board that has
  grown short is read again as where the section stands the next time he
  speaks.
- **After a request the cards stand where the rule puts them.** Everything
  else keeps the order he saw; the cards he has not placed stand where the
  rule above puts them on the board as it now is. On the usual order
  nothing moves. On a board where the system has moved the tiles under the
  cards, or Needs a date above them, a request that takes away one of next
  up, the tiles, Needs a date or People (hide, ban, pin, remove) can move
  the cards to the other side of the tiles. Pin is the oddest of these:
  "Pin this section here" on Needs a date makes it his, so it is no longer
  one of the system's sections the cards are counted against. A section
  that comes back (show, lift, unpin, add back) moves no card on any board:
  it comes back on its own side of the cards (below). The reply shows him
  the board he gets. The plain consequence: the system can keep the tiles under the
  cards only while Needs a date or People stands between them. A limit
  until the split (1.07), when a section a planner moved with a reason can
  be told apart. This is for the cards only: what he placed goes with the
  neighbour it had (below).
- **A place is a position, not a neighbour, between his requests.** When
  the SYSTEM moves the card run or a section at an open (a rule sending the
  strip up, a planner's answer, the data sorting the cards again), a
  section he placed in the middle of the board keeps its count from the top
  or the bottom and may get new neighbours. (The cards on top, a card of
  his second among them; a rule sends the strip up: the strip is first, and
  his card, still second, stands under the strip and above the first card.)
  At a request of HIS it keeps the neighbour it had (below): the limit is
  gone there, and stays here until the split (1.07).
- **Rows main wrote.** A component retired since (main still stored it, the
  page draws nothing for it) is taken out of a stored row wherever the row
  is read as a board: at the composition's door, for the row as the system
  plan and for the row as where his places are, so it is on no board, in no
  count of places, and not told to the model. What he placed with the
  voice tool or the pin button is on the row's pins and stays where he put
  it; its place is read once from that stored order. A card he moved above next up
  with main's chat tool was never pinned on main: it is read as the
  system's, follows the data, and does not say where the run goes. Main
  lost that move at the next change in his data anyway. The same for
  People or Needs a date that stood above the cards on main's row without
  a pin (moved with main's chat tool): at the first open it goes under the
  cards.
- **A place goes with its section.** When a section he placed leaves the
  board (its project is archived, its component banned, he hides it), its
  place is gone for good, with the first board worked out without it.
  Brought back, a card follows the data and a section of the usual board
  goes where the rules would keep it (below).
- Rows stored before r5, and a pin kept as a `pin_section` preference: the
  place is read once from the stored order at the first open and written
  back. It is the only read of the stored order for a place. The preference
  row is then marked and no longer read as a pin (it is left, not deleted).
  A pin has one home: the place written on the section in the stored board,
  with its key in the row's `pinned`. Settings lists pins from there, and its
  remove is a request like any other.

**A section of the system's that a list lacks goes where the rules would
keep it.** One rule, decided in one place (`withSystems` and `systemsPlace`,
`lib/layout/compose.ts`), for both ways a list can lack a section of the
default board: a board being composed that does not have it (2, above), and
a request of his that brings one back (show, add back, unpin, a hide or a
ban lifted).

*It takes its place in the first order the rules can produce that is
accepted against the list as it stands, the clock a day on (the usual order
first, then the others in the rules' own order; today the strip sent up).
If none is accepted, it goes by today's order, and a tie is read against the
section that carries a reason on the board, or else one the rules can move.*

- The orders the rules can produce are said where the rules live
  (`ordersTheRulesCanProduce`: the default board; the strip sent up by rule
  3, with its reason), built from the same lines the rule uses, next to the
  sections the rules can move (`RULES_CAN_MOVE`: the strip). A test fails if
  a rule produces an order, or moves a section, that is not there.
- "Accepted against the list" is the validator's own verdict
  (`movementReasons`) on that order against the system's own sections on
  the list as it stands before the section is put in (what he placed, hid
  or banned is not the system's), a day on: the layout clock past its day
  and nothing new today, which is every day the rules can produce the order
  on. A banner new today does not say where a section goes.
- The place in an order: take the system's sections on the list (not the
  banner, not what he placed). The ones that stand in step with the order
  are the ones a plan in that order would not itself move: the validator's
  own reading (`lib/layout/in-step.ts`: the longest run in step), called,
  not written a second time, so the two cannot disagree. And the run of the
  system's cards counts as a section of the order, between the strip and
  Needs a date: next up, the tiles and the strip have the cards below them,
  Needs a date and People have them above. The cards are never asked which
  sections are in step (with the strip under the cards, asked, they put
  Needs a date above the strip) and are never read as moved. The section
  goes under everything that precedes it in the order: the sections in
  step, and the cards when they precede it. With nothing before it, above
  everything that follows it. With nothing of the system's on the list at
  all, first under the banner. Next to a section in step, never next to one
  the order would move.
- Where "next to its section in step" and its side of the cards cannot both
  hold, the side of the cards wins, both ways: next up, the tiles and the
  strip never go below the first card of the run, Needs a date and People
  never above its last. (A planner has the tiles above next up, the cards
  under both; Needs a date comes back behind the cards, not between the
  two.) For next up, the tiles and the strip it comes to this: when the
  section in step it would go under stands under the first card, it goes
  directly in front of that card instead. Three kinds: next up under the
  strip (next up and the tiles hidden, a planner has the cards above the
  strip, he talks dates so the strip is first in today's order; next up
  comes back in front of the cards); the tiles under next up or the strip
  (a planner has Needs a date and next up under the cards; the tiles come
  back in front of the cards, above both); the strip under next up or the
  tiles (the same board; the strip comes back in front of the cards). For
  Needs a date and People nothing more is needed: the cards already count
  among what precedes them. So a section that comes back
  stands on its own side of the cards, the count that follows (3) has
  nothing to put right, and no card moves for it. The two can fail to hold
  together only on a board no order of the rules is accepted against, so
  no accepted order is lost by it (shown by the same tests as the rest).
  Taking a section away can still move the cards on a crossed board
  (above), which is why a request does not read his places off its list
  ("What he placed keeps the neighbour it had", below).
- When no order of the rules is accepted (a planner has moved something,
  and it stays), today's order is the rules plan's (the default's in calm
  mode, where no plan is asked for), and two readings of what is out of
  step can be equally long. A section could be read as the one out of step
  when a run just as long stands without it. Then a section that carries a
  reason on the board is the one read as moved; with no such section, one
  the rules can move. If a run just as long does not stand without all the
  sections of that kind (both sections of the tie carry a reason), or
  neither is of either kind, the validator's reading stands. (A reason is
  on a section only when it changed something: the validator takes one off
  a section whose props are the default's.)

What follows from it, each a test and not a sentence of its own:
- **His request leaves no hold.** No order the rules can produce that was
  accepted against the board he had is refused against the board he has.
  For the order the place was taken from, that is how the place is made;
  for the other it is shown for every list and every section (975 cases,
  the validator as judge), and it rests on how the validator reads a tie:
  two sections tie, and the one standing later on the stored board is read
  as moved. A test pins that reading by name, with the eleven boards it
  decides (the usual order with exactly one of next up and the tiles above
  the strip, against the strip sent up: the strip is the one read as moved,
  and the strip has the reason).
- **His "show" does not perform the system's move.** A section the rules
  are about to move is no guide for the others while it waits (he asked
  about dates on a day a banner was new; a day later the stored board is
  still served, the strip still to go up): next up comes back above the
  tiles, Needs a date under the strip, each where it stood. And when the
  strip itself is the one that comes back, it comes back to its usual
  place, and the rule's move lands by itself, with its reason, at the next
  open that is not served from the stored board. The same on a board where
  the strip was sent up and is held there after the talk stopped: hidden
  and shown, the strip goes to its usual place, and the stuck move is
  undone. That is intended.
- The strip sent up and still there (he still talks dates, or the talk has
  stopped, or it is the very day it rose): "the strip sent up" is the order
  accepted, so the tiles come back under next up and next up under the
  strip. On the day it rose, a section hidden and shown froze the system's
  plan from the next day on until this rule (472c2a7).

What it cannot do, named, under the same limit as the cards after a request
(above): nothing remembers where a section stood.
- The strip sent up, and only ONE of next up and the tiles among the
  system's sections (the other hidden, or his). He hides that one and shows
  it. The list left behind is the strip, Needs a date, People: it shows no
  move at all, the usual order is accepted against it, and the section
  comes back ABOVE the strip. A board he did not have before, and harmless:
  both orders stay accepted, and the rule sends the strip up again at the
  first change in his data after a day.
- A planner moved one section, and the list left behind is in an order the
  rules can produce: the returning section goes by that order, and the
  planner's move is stepped over. (Needs a date raised above the strip
  with a reason; he hides the strip and shows it: the strip comes back
  above Needs a date.)
- A planner's answer that leaves a default section out, on a board whose
  order an earlier planner's answer changed, can be refused for where the
  section is put. The answer is thrown away: that one call, and none after
  it for the same situation. As measured, on a board where an earlier
  answer raised Needs a date above the strip: an answer that leaves out
  the strip (which stood under the raised section) is thrown away; one
  that leaves out next up, the tiles or People lands.
- The system's strip under the cards (a planner listed the cards above
  it): he hides the strip and shows it, and it comes back in front of the
  cards. The sentence working (the strip has the cards below it), not a
  defect; but he will see it.
- Needs a date raised above next up by a planner, the cards on top of
  both, and the tiles come back: in front of the cards, so above next up.
  Its side of the cards has won over its section in step.
- He hides a section and shows it, and something he placed stood right
  beside it. The section comes back right beside its neighbour (the section
  in step, or the first or last card of the run), so his thing may be on
  the other side of it than before. Until the split (1.07).

(Three earlier rules, each of which left a hold: the default place
regardless, which with the strip sent up by a rule put the tiles above the
strip in a way the rules plan was refused for; under the nearest section
above it, cards counted, which with the strip under the cards put Needs a
date above the strip; and where today's rules plan alone would keep it,
which was accepted that day and refused once the talk stopped.)

A card that comes back goes where the data puts it. (Where a planner had a
section is not kept for one that was his while the plan was made; that
returns with the split below.) Everything else keeps the order he saw. What
a request brings back is put onto the list after everything else it asked
for (when it brings back several, the order they are put in does not change
where any of them goes). Nothing remembers the index a section had when it
was hidden. A
section he ADDED (or any section outside the default board that he has
placed) is always placed: unpin does not apply to it and says so; hidden and
shown again it comes back placed at the end, as the bare component, because
its props lived only on the board.

**What he placed keeps the neighbour it had.** A place is stored as a count,
and a count read off the list a request builds is right only while that list
is the board. So a request does it in this order, in one place (`settle`,
`lib/layout/request.ts`): the composition and its count settle the system's
sections and the cards FIRST (in calm mode, the default board's order);
then each thing of his is stood next to the neighbour it had on the list;
and his places are read off THAT board and stored. It is the list and the
board. The stored form does not change.

- One neighbour each, by the test a place already uses (above). Counted
  from the top (a card of the run, or next up, the tiles or the strip,
  stands somewhere below it): the nearest thing above it that is not his;
  with none, the top. Counted from the bottom: the nearest thing below it
  that is not his; with none, the bottom. So what he sent to the top or
  the bottom is first or last, and stays so.
- Two things of his side by side are not each other's neighbour: each looks
  past the other, and their order is kept.
- The section the request names: if it stays the system's (show, unpin) it
  is a neighbour like any other. If the request takes it out of the
  system's (hide; a pin or a move makes it his) it is no neighbour, and the
  next thing that is not his serves.
- A move puts his thing on the list where he said, and it takes its
  neighbour there. Calm mode: the same steps; only the board the system's
  sections and the cards settle into differs.
- A card that comes back (shown again, or let go) is not put on the list
  at all. The composition draws it in the run by the data, and it is
  nobody's neighbour: what he placed above the first card stays under the
  section it stood under when the first card comes back. A card let go
  keeps the emphasis it had: it is in the draft the composition is asked
  with, last, where it does not say where the run goes. (The request used
  to guess a place for the card on its list; that guess is gone.)
- The guard (below) tries its other places through the same steps.

(The cause this takes out, found three times in r5 and once in 472c2a7: a
place said in two places. With nothing of the system's above the strip, the
strip came back under the cards and stayed. On the plainest board, Needs a
date came back onto the list above the cards, the count put the cards
right, and a card he had placed among them moved down one. On a board a
planner had rearranged, next up came back under the strip and so under the
cards, the count moved the cards under it, and his card was left behind
under the strip (next up now comes back in front of the cards there, and
nothing moves). And on a
board where a planner had Needs a date above next up, with the cards on
top, he hid Needs a date, the cards went under next up, and his card stayed
on top: that one 472c2a7 already had.)

**The guard: his request leaves no hold.** Before it writes, a request asks
two things of the board he is about to be told, against the board as it is.
What a new open would be served today (the rules chain, in memory, no model
call): the rules plan now and held after is a hold. And each order the
rules can produce, a day on: accepted now and refused after is a hold left
for a later day. If his request would leave either, a section it brought
back is tried at the other places among the system's sections, nearest
first (of two as near the upper one: they are tried in order from the top),
and the first place that leaves no hold is taken. If no place does, or nothing was brought back, his
request is applied all the same (it is never refused for this) and one line
goes to the server log, with counts only. Not for Put it back (it puts the
system's own order back, and that may hold the plan for the day like any
change of the system's order), and not in calm mode (no plan is asked for
there). With the rules as they are the guard never fires: the rule above is
the same question read the other way. It fires only if a rule ever SINKS a
section with a reason; a test makes such a rule, as today's plan and as an
order the rules can produce, to show the next place taken and the line
written. Not covered, and named: a planner's next answer. A request of his
cannot be held to every plan a planner might write.

**Lifting a hide when there is nothing to show.** The project was archived
or deleted since, or the component retired: the hide simply goes (it must not
sit in Settings for good because the board cannot draw what it hid). A card
whose project is deleted is called "a project that is no longer there".

**A ban is a request too**, and works like a hide of that component's
section: the board he saw without it, everything else in order. Nothing can
be shown, moved or added while he has banned it; the reply says so. The ban
remembers a section he had put on the board himself, so lifting it (by voice
or in Settings) brings that section back, placed at the end; a section of
the usual board comes back where the system has it.

**The stored row, and the one door.** The stored row is still a composed
board. It is read through one door, and this is everything that comes
through it:
- the places written on what he placed;
- the system's own order of the sections that are not cards: the board
  without the banner, without the cards and without what he placed
  (`ownSections`);
- when the stored board is served again for the same signals: its emphasis,
  its banner, its reason line, and a size he set with `set_props`.
Two properties are required and tested at every step of the walk: composing
the board that was just stored gives that same board, section for section;
and an open with nothing changed writes nothing. Every why the composition
itself writes (the count under a deadline, "Back on your board") is written
and recognised in one place and written again or dropped at each render; it
is never read back as the system's.
The split of this row into the system's plan and his placements, with the
composed board never read back, is the next Overview task. It also takes
"Put it back" stepping through data re-sorts and the extra planner call.

**Rationing (invariants 3 and 8) measures the system against the system.**
Only sections that were the system's in the stored row AND are the system's
now are compared. A section that changes hands in either direction (he pins
it, unpins it, hides it, shows it) is neither moved nor removed, so none of
his own requests gets a plan refused or held. The rules plan has banned
components taken out before it is judged, so a ban does not hold the plan
either.

**The layout clock** (`days_since_layout_change`) is read on the same
projection (`layoutChanged`, `lib/layout/signals.ts`): a stored row changes
the layout when the sections that are the system's on it and on the row
before are in a different ORDER. Not counted: the project cards (they
follow the data); the banner (always first when there is one); anything he
placed; a section coming or going, whoever did it. So his own request does
not spend the system's daily ration, and a request is stored under the hash
the next open works out (`hashOnceStored`), so the planner is not asked
about a board it has already answered. Counted, the banner made a planner
that writes one every time it is asked a paid call a day for ever: its row
reset the clock, and the clock turning over a day later was a new
situation.

The clock reads every stored row of the last two days (and the row the
oldest of them follows), not the newest ten: ten rows in one day used to
push that day's change out of sight, the clock read "never", and the ration
was open again the same day.

**What the system added today stays today (invariant 8)** is no longer read
off that clock. The signals carry `sections_new_today`: the sections that
are not cards which the system put on the board less than a day ago (a
banner, a section a planner added). A system plan without one of them is
refused that day, so the rules plan does not take a planner's banner off at
the next change in his data; a day later it may. The list is not in the
signals hash: a day going by is not a new situation.

**A stated limit: what the system moved does not go back by itself.** After
the strip has been sent to the top it stays there when the talk about dates
stops, still giving that reason, and a planner's banner stays past its day
if that plan had also moved a section: going back has no why, and a move
without one is refused. As before v1.02 for the strip. Task 1.06.

**Put it back** is a request: the earlier row's board, with what he had
placed on it at the places that row wrote, on today's data and under today's
hides; through an open, written, answered, and every place read again.
It does not step behind the first board stored under this version: a row
written before it is not a board Put it back returns to, and the request is
refused in plain words with nothing written (every row stored since carries
a mark, `composed`, and a row without it is from before). The first open
after the update was not a request of his, and reading main's row as a
board through this path lost a pin he had. One undo step is lost at the
update. It
does not bring back what he hid: **Put it back does not undo a hide or a
show**; hides live outside the versions. A section he had added that the
earlier board does not have goes with it, whether he added it since or only
had it hidden then. He will meet the asymmetry, so it is written down: add
kanban, hide it, show it, Put it back, and kanban is gone, not hidden ("show
kanban" says there is none; he adds it again); hide the tiles, show them,
Put it back, and the tiles stay shown, because a section of the usual board
that is not hidden is always drawn.

No tool answers that a change was applied when the next render will not show
it. A size or accent set with `set_props` is checked on the board like any
other claim: it lasts until his data next changes, and the tool says so; in
calm mode, where every section is shown the plain way, it is refused.

Adding a component = bump registry version + add prop schema + add render fn +
mention in planner prompt. Never mid-session.

**v1.2 refinements (Phase 1 implementation):** (a) all props are optional — a
section with omitted props renders its computed-from-data default, which is
what DEFAULT_PLAN relies on; the planner sets props only to deviate. (b) Per
INTEGRATION Decision 2, the registry also carries this app's five pre-existing
zones (`documents`, `coming_up`, `kanban`, `procrastination_zone`,
`suggested_zone`), props-less; v0's `overdue_callout` retires into
`focus_banner`.

**SEC-A006 (2026-10-06, Kiron: "make it make sense"):** the Dashboard is on
the tab bar (Today · Dashboard · Projects · Interview · Memory · Settings),
and the Canvas is one of its views (Overview, Board, List, Calendar,
Timeline, Canvas; `?view=` opens one, `/canvas` lands on it). The Canvas
itself is unchanged. Every date the views show comes from one place,
`lib/due.ts`, worked out on the server in the user's timezone by calendar
day: the same "past due" and "N days late" as Today and the Workspace. On
Board, List, Calendar and Timeline the old red box is `PastDueChip`, "N
past due", which opens the list and can be hidden until something new goes
past due; `suggested_zone` shows one suggestion at a time (Add, Not now)
and folds to "See suggestions (N)" until a new one arrives. Nothing that
looks tappable is a dead end: a project card's header, a stat tile's rows,
the Needs-a-date chips and the procrastination rows each open what they
name, at 44 px or more. The 5-week chart is untouched (SEC-A007/A009
replace it).

**SEC-A007 (2026-10-06, Kiron: "make it make sense"; sec rev's round 2, "a
clear Overview"):** Overview reads top to bottom as the next commitment and
its tiles, the projects progress strip (in place of the 5-week chart), the
project cards, the lists, then Needs a date. No task appears twice: the
WHAT / WHEN / HEARD table is gone from Overview (it is the List view, whose
headers now read Task / Due / Added). The shell owns the geometry:
consecutive project cards render as one grid, two across on an iPad and
three on a desktop, each card the full width of its cell (an accented one
takes a whole row). `inline_loops` unfolds the card's own list of open items
instead of adding a second table of them. Needs a date
sets a date where it stands: a tap opens Today / Tomorrow / Next week /
Pick… and the choice saves at once through `update_task` (the same move
route as the Timeline, with Undo). Board, List and Calendar get project
filter chips (All, then projects by most recent activity), remembered per
device; the Timeline keeps its own (the strip). The Spreadsheet view is
untouched.

**SEC-A009 (2026-10-06, Kiron: "make it usable… progress per project…
filters… like notion, you should be able to move things on it… extending
start dates, due dates"):** Dashboard › Timeline is a board you move things
on (`components/dashboard/timeline-board.tsx`, geometry and date math in
`lib/timeline.ts`). One lane per active project, late projects first, each
with its progress ("3/7 done", every task but dropped ones, whatever the
filter shows) and its deadline as a flag (red committed, amber not). A task
with a planned start (`tasks.start_at`, new) is a bar from start to due; a
task with only a due date is a diamond; a one-off event is a bar; a
repeating event is locked (tap to edit; v1 moves repeats by asking). A red
Today line and a Today button; Week / Month (default) / Quarter. Filters:
the progress strip above picks a project (its chip clears it), Open / Late
/ Done / All, and events on or off; zoom, filters and folded lanes are
remembered per device. On a phone the strip swipes and the controls scroll
sideways in one row, so the board stays near the top. Open tasks with no date wait in a No date (N)
tray. Moves: drag a bar's body (both dates and every reminder shift by the
same whole calendar days, keeping the time of day across DST), its left
edge (the start), its right edge (the due), a diamond's small left handle
(pulls out a start), or a tray task onto a day (5 PM that day); arrow keys
move the focused item a day; touch drags after a long press; a phone shows
the board and taps to edit, but does not drag. Every move is the same
operation as saying it: `POST /api/timeline/move` calls `update_task` or
`update_event` through `executeTool` in a live turn, so a Google-synced
event is patched on Google, a later due counts as postponed, and a start
after the due is refused. Undo is a restore, never a second move: the
move returns a sealed, user-bound ticket (`lib/timeline-undo.ts`, 15
minutes) naming the prior values and exactly the check-ins it wrote and the
expectations it cleared, and `POST /api/timeline/undo` puts all of it back
through the tool layer (`restoreTaskMove` / `restoreEventMove`, the latter
patching Google back through the same `sendToGoogle`). If the item moved
since, nothing is restored. If
Google refuses, the move stays, the toast says "not on Google yet", and
Retry is `add_event_to_google`. By voice, `amend_task` and
`create_commitment` take `start_at` ("start the album cover on the 12th").
The planned start is left out of the understanding hash, as is a bare
`updated_at`: moving a start is not news to a run.

**v1.3 refinements (Phase 3 implementation):** (a) the wishlist lives in a
`wishlist` DB table (not a .jsonl file) — same dedupe-by-need + tombstone
semantics, but durable, user-scoped, and included in the nightly Heroku
mirror. (b) Slow-loop components are **templates, not code**: the generation
job authors a declarative HTML template (canvas-sanitizer vocabulary +
`{{signals.path}}` slots and `{{#each}}` loops) plus meta + preview. Approval
inserts it into a `dynamic_components` table and bumps the registry version —
hot-registration with no restart, and the runtime never executes generated
JS; it interpolates + sanitizes, exactly like the Canvas. This is §7.6's
"born visual" rule made structural. (c) The planner prompt's registry table
is augmented at load time from `dynamic_components` rather than by editing
the prompt file on disk.

---

## 3. LayoutPlan schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["plan_id", "sections"],
  "additionalProperties": false,
  "properties": {
    "plan_id": { "type": "string" },
    "reason_summary": { "type": ["string", "null"], "maxLength": 120 },
    "sections": {
      "type": "array", "minItems": 1, "maxItems": 14,
      "items": {
        "type": "object",
        "required": ["component"],
        "additionalProperties": false,
        "properties": {
          "component": { "enum": ["focus_banner","hero_next_up","stat_row","project_card","timeline","open_loops","date_chase","people_index"] },
          "props": { "type": "object" },
          "why": { "type": "string", "maxLength": 140 }
        }
      }
    },
    "wishlist": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["need", "closest_component", "signals"],
        "properties": {
          "need": { "type": "string" },
          "closest_component": { "type": "string" },
          "signals": { "type": "string" }
        }
      }
    }
  }
}
```

Props are validated per-component against the registry (second pass, not in the
JSON Schema above). Semantic rules (invariants 3–5, urgency, pinned
sections) are a third validation pass. **Validator returns
`{ok: true, plan} | {ok: false, reasons[], fallback: plan}` and MUST be pure and
unit-tested.**

---

## 4. Signals

Computed by the app from existing data (projects, items, chat transcripts,
accountability log). No new collection needed for v1. Shape:

```ts
type Signals = {
  projects: {
    id: string; name: string; kind: string;
    deadline: string | null;                    // ISO date
    deadline_type: "committed" | "inferred" | "none";
    days_left: number | null;
    open_count: number; done_count: number;
    subprojects: { id: string; name: string; open_count: number; done_count: number }[];
    people: string[];
  }[];
  tasks: {
    id: string; title: string; project_id: string | null;
    status: string;                             // open statuses only
    due_at: string | null;                      // ISO timestamp
  }[];
  engagement: Record<string, { mentions_24h: number; baseline_mentions: number; last_touched: string }>;
  conversation: { today_topics: string[]; schedule_word_share: number; questions_today: string[] };
  pending: { items_missing_dates: string[]; unanswered_asks: string[] };
  calendar: { next_hard_commitment: string | null; days_to_it: number | null; density_14d: number };
  context: {
    date: string; weekday: string; time_of_day: "morning"|"afternoon"|"evening";
    days_since_layout_change: number;
    sections_new_today?: string[];   // what the system put on the board less than a day ago (v1.02 r5, §2); not in the hash
    pinned_sections: string[]; calm_mode: boolean;
  };
};
```

Definitions:
- `tasks`: the user's OPEN tasks (inbox/todo/in_progress/blocked), due-soonest
  first with undated last, capped at 50. This is the id vocabulary for painted
  surfaces: every task id the Canvas may act on (`data-check`, §7.6) must
  appear here.
- `mentions_24h`: count of chat messages in last 24h whose extraction linked to this
  project. `baseline_mentions`: trailing 14-day daily median (min 1).
- `schedule_word_share`: fraction of today's user messages containing schedule
  vocabulary (when/by/before/deadline/schedule/calendar/date + weekday/month names).
- **Engagement is "strong"** when `mentions_24h >= 3 × baseline` and `>= 5` absolute.
- **Schedule-talk is "strong"** when `schedule_word_share >= 0.3` or
  `>= 3` schedule-shaped questions today.

---

## 5. Planner v1 — rules (no LLM)

Pure function `planFromRules(signals): LayoutPlan`. Start from DEFAULT_PLAN, apply
in order (later rules may not violate earlier invariants):

1. **Deadline pressure:** any project `days_left <= 3` (or committed `<= 7`) →
   its card gets `accent: true` + `inline_loops: true`, and a why in calendar
   days in the user's zone, the count the date beside it uses: "Due today",
   "Due tomorrow", "Due in N days" (v1.02; `days_left` itself counts whole
   24-hour periods and said "Due in 0 days" for tomorrow at 5 PM). If several qualify, accent
   only the soonest (invariant 5); others full variant.
2. **Engagement:** strongest strong-engagement project → accent + full +
   `inline_loops`, with `why: "N mentions today vs M typical"`. It does not
   move the card (until v1.02 it went to the top after a day): the system
   never places a card (§2, composition).
   Engagement accent loses to deadline accent when both fire (deadline wins;
   engaged project still gets full + inline_loops).
3. **Schedule-talk:** strong schedule-talk → `timeline` gets `expanded: true`,
   `span_days: 14`; if reordering permitted, timeline moves to top (before hero)
   with why; all project cards drop to `compact` except accented one.
4. **Structure:** any project with `subprojects.length >= 2` → its card
   `variant: "nested"`. If subprojects have their own dated deadlines and
   registry has no fitting component for that, add wishlist entry
   `{need: "per-subproject deadline lanes", closest_component: "timeline", ...}`.
5. **Nothing fired** → DEFAULT_PLAN verbatim, `reason_summary: null`, zero `why`s.

Every deviation from DEFAULT_PLAN carries `why` (≤ 140 chars, addressed to the
user, naming the signal). `reason_summary` set when ≥ 2 rules fired or a reorder
happened.

## 6. Planner v2 — LLM behind the same interface

`planFromLLM(signals): Promise<LayoutPlan>` with the same return contract.
Selection: `plan = validate(await planFromLLM(s)) ?? validate(planFromRules(s)) ?? previousGoodPlan ?? DEFAULT_PLAN`.

- Small/fast model (Haiku-class), JSON output mode, temperature ≤ 0.3, one call
  per dashboard open. **Cache** keyed by hash of (signals minus timestamps,
  registry version); quiet days cost zero calls.
- The system prompt is `planner-prompt.md` (kept in repo, versioned). It contains:
  role, signals shape, registry table, the 10 hard rules (mirror of §1
  invariants + "on any doubt emit DEFAULT_PLAN"), DEFAULT_PLAN, output contract.
- Log every (signals_hash, plan, accepted|reverted|pinned_over) for tuning.
- **One call per situation, not per process (2026-10-06, SEC-A004).** When
  the planner settles on the head plan (its refinement came back the same,
  was refused by the validator, or the call was not made), the head is
  stamped with the current signals hash, so the next render is a cache hit
  even after a restart; before, only the in-memory cache stopped a re-call.
  Plans are compared with their keys sorted: jsonb returns a stored plan's
  keys reordered, and a plain string compare called identical plans
  different. The Claude planner is Sonnet (`PLANNER_CLAUDE_MODEL`), not the
  user's brain model: it runs in the background and nobody reads its prose.

## 7. Slow loop (v3)

- Planner wishlist entries append to `wishlist.jsonl` (dedupe by `need`).
- Nightly job: any `need` with ≥ 3 occurrences → assemble a build brief:
  the wishlist entries + design tokens + one existing component's source as a
  style exemplar + registry docs → run the coding agent (e.g.
  `claude -p "$(cat brief.md)"` or a queued Claude Code session) → output lands in
  `components/proposed/<name>/` with a static preview HTML + screenshot.
- Approval UI (a card on the dashboard): preview + diff + approve/reject.
  Approve = move into registry, bump version, append one line to the planner
  prompt's registry table. Reject = delete + tombstone the `need` (stop re-proposing).
- Generated code never registers itself. No dynamic import of unapproved code.
- The "coding agent" here can literally be headless Claude Code
  (`claude -p "$(cat brief.md)"`) or the Agent SDK, invoked by the app server.

## 7.5 Conversational layout control (the chat channel)

"I don't like this / change this" must work from inside the chat, quickly. The
secretary's chat agent gets layout tools. Two tiers, and the split is the point:

**Tier 1 — seconds (it's data).** Most requests land here.
- `arrange_dashboard(operations)` (2026-10-06, SEC-A003) → the voice-safe
  way to rearrange: flat ops `move_to_top | move_up | move_down |
  move_to_bottom | hide | show`, each naming a section in the user's words
  ("shopping list", "Canterly", "the timeline"). The server maps words to
  section keys with no model call, validates as user-initiated, saves the head
  and pins what it placed (so the background planner cannot move it back);
  `hide` stores `{hide_section}`, `show` removes it. It is on the call
  (VOICE_TOOL_NAMES) and in chat; the briefing's DASHBOARD line names the
  sections top to bottom. Kiron asked by voice to put the shopping list at the
  top and heard "Sure, let me move that", then "I can't move the dashboard
  sections with the tools I have right now".
- `get_current_plan()` → LayoutPlan + registry version + active preferences.
- `edit_layout_plan(patch)` → edits the live plan. Validated by the SAME
  validator as planner output; applies immediately (invariant 3, user-initiated),
  animated as a diff (invariant 8).
- `set_layout_preference(pref)` → durable constraints, stored, injected into
  every future planner call, and enforced by the validator:
  `{ban_component}`, `{pin_section}`, `{default_variant_for}`,
  `{accent_policy: "never"|"auto"}`, `{hide_section}` (one section kept off
  the board until the user shows it; applied wherever bans are).
  "Stop showing me people" → ban `people_index`. "I hate the glowing ring" →
  `accent_policy: never`. Preferences are listed and removable in Settings, so a
  dislike stated once never has to be re-stated — and never re-annoys.

**Tier 2 — minutes (it's code).** For asks outside the registry:
- `request_new_component(need, sketch?)` → appends a *priority* wishlist entry
  and triggers the slow loop ON DEMAND instead of nightly. Chat answers with the
  honest state: "Building that view — a few minutes. Meanwhile, here's the
  nearest thing," and the planner substitutes the closest component with a `why`.
  When the build lands, approval happens in chat ("here it is — keep it?"),
  which doubles as the human review. Approved → hot-register (registry version
  bump, no restart). Rejected → tombstone the need.

This is "Claude Code built into the app" — but it only ever writes sandboxed,
previewed, versioned components. It never edits the live plan directly (that's
tier 1's job) and its output never runs before a yes.

## 7.6 The Canvas (free-form visual surface)

A second adaptive surface alongside the Dashboard: a page the secretary
**paints**. The Dashboard rearranges hand-built interactive furniture (data
edits, instant, safe). The Canvas is model-written **markup** — arbitrary
layouts, poster-level emphasis, one-off views — repainted or patched in seconds
while the user talks. This is the "talk and instantly see it change" surface.

The speed hierarchy the two surfaces implement: touching **data** is instant
(Dashboard), touching **markup** is seconds (Canvas), touching **code** is
minutes (slow loop). Interactivity is not what makes adaptation slow — code
authorship is. So the Dashboard keeps its interactivity, and the Canvas trades
interactivity away to gain unlimited shape.

Rules:

- **Content:** static HTML/SVG only. Sanitized against an allowlist (no
  `<script>`, no event-handler attributes, no external loads, no forms),
  rendered in a sandboxed iframe (`sandbox` attribute, CSP `script-src 'none'`).
  Invariant 6 ("model output is data, never markup") is relaxed for this ONE
  surface precisely because nothing on it can execute.
- **Interactivity ceiling:** none from the model, by design. The host shell
  provides generic primitives: any element with `data-expand` gets
  click-to-expand; `data-link="<entity_id>"` opens that entity on the Dashboard
  or Spreadsheet; `data-check="<task_id>"` crosses that task off on tap and
  marks it done through the same task API as the Dashboard checkbox (recurrence
  rollover and check-in log included). The model emits attributes; the shell
  owns all behavior. `data-check` is the one sanctioned write from a painted
  surface — sanctioned because it is invariant 3's case: a USER-initiated
  change, applied immediately. Guardrails: the painter may only use ids present
  in `SIGNALS.tasks` (open tasks only, never invented); the sanitizer drops
  values that aren't id-shaped; the shell ignores repeat taps and rolls the
  cross-off back if the API refuses; the server enforces per-user ownership, so
  a hallucinated id can at worst 404. Cross-offs are durable: the canvas GET
  returns `doneTaskIds` — the snapshot's `data-check` ids whose tasks are
  already done (user-scoped) — and the shell seeds its crossed-off set from it,
  so a tapped task stays crossed off across reloads until the next repaint
  drops it from the markup. The check-in note records canvas provenance
  ("Marked done from canvas"). Marking done also clears the task's open
  commitments silently (§11) — same as the chat/voice tools, on every surface
  that shares the task API. Dashboard dynamic components share the
  sanitizer but get no behavior wiring — there the attribute stays inert.
- **Chat AND voice tools:** `paint_canvas(brief)` — a NEW canvas, streamed so
  first paint lands fast; `edit_canvas(patch)` — a change to the canvas the
  user is looking at ("add one more thing", "make that purple", "only show the
  Canterly items"); `show_canvas()` — bring the existing canvas into view
  without touching it. **All three ride the voice session**: a spoken change
  with no edit tool available can only become a from-scratch repaint, which is
  the failure this rule exists to prevent. `edit_canvas` is the DEFAULT
  whenever a canvas exists and the user is modifying it; `paint_canvas` is for
  a genuinely different picture.
- **Continuity (never blank):** a canvas operation must never take the canvas
  away from the user while a model call is in flight. The new snapshot is
  seeded with what is currently on screen; an **edit holds that markup until
  the replacement is complete** (a change must never look like a teardown); a
  fresh paint begins streaming only once its output is substantial; and a
  failed or empty generation leaves the previous canvas intact rather than
  clearing it. The shell is told to reload the moment an operation starts —
  waiting out the idle poll is indistinguishable from a frozen screen.
- **The checkbox is shell-owned.** The host injects a real checkbox into every
  `[data-check]` and owns its state, so "put checkboxes on those" is a UI
  state change requiring no repaint, and the model can neither omit nor fake
  one. Completion requires tapping the checkbox itself — a whole-card
  destructive target is not acceptable on a scrolling touch surface — and the
  canvas applies the same momentum-tap guard as the dashboard, so the tap that
  stops a scroll never completes a task. Crossed-off state is re-derived from
  the live task records on every load, never from the markup, so a task
  reopened elsewhere shows as open here. Two rules keep that contract true:
  `cv-box`/`cv-checkable`/`cv-done`/`cv-expanded` are HOST-owned class names the
  sanitizer strips from model output (a painted `.cv-box` would otherwise
  become the tap target), and `data-check` is dropped from SVG geometry, where
  an injected HTML checkbox cannot render — so every surviving `data-check` is
  guaranteed a real, shell-drawn checkbox.
- **Auto-open (shell-owned chrome):** each canvas tool's successful outcome
  carries a UI-only `uiAction: {type: "show_canvas"}` beside its toast. It is
  transport, not content: never serialized into the model-visible tool result,
  never persisted. The shell reacts by navigating to the **Canvas tab** — the
  real page, nav bar and all; the Canvas must never arrive as a modal sheet,
  takeover, or embedded copy that makes the rest of the app unreachable —
  there is ONE canvas view, and it lives on its tab. The chat dock (§7.7)
  collapses to its bar — the paint is the answer, nothing sits on top of it.
  In a voice call the call shrinks to its pill and the app navigates to the
  same tab, the pill riding above it. The nav indicator slides to Canvas
  (§7.7 tab motion); `prefers-reduced-motion` swaps every animation for an
  instant cut. This transition is app chrome under invariant 1: the model
  requests visibility with data; the shell owns all movement.
- **Latency budget:** first visual paint < 3s, complete < 10s, patch < 2s.
  Small/fast model; the painter prompt lives in repo as `canvas-painter-prompt.md`.
- **Data honesty:** the painter receives the same Signals JSON as the planner
  and may not invent values — every number on the canvas must trace to signals.
- **Persistence:** every paint is saved as a snapshot (markup + brief +
  timestamp). Provenance applies to pictures too; "show me Tuesday's version"
  must work. Snapshots are cheap — they're text.
- **Audition room:** a canvas shape requested ≥ 3 times auto-files a wishlist
  entry — the Canvas is where future registry components audition. And slow-loop
  components are **born visual**: the first approved version has no interactions;
  promotion to interactive happens only after it survives a week of real use.
  (Coding agents are far more reliable generating a picture of data than a
  stateful widget — let new things earn statefulness.)

---

## 7.7 The chat dock and tab motion (app chrome)

Chat is not a tab. It is a **persistent dock** that rides above every page —
the secretary is always one tap away, never a navigation away. Modelled on
Gemini in Chrome (Kiron's screen recording, 2026-09-24). Three states, all
shell-owned chrome (invariant 1); the tab bar stays at the bottom in all of
them:

- **Closed** (default): one round launcher at the bottom-right corner, above
  the tab bar. Nothing else of the chat is on screen.
- **Bar**: tap the launcher and it morphs into a floating pill, centred —
  one black shape growing from the launcher's circle to the pill's rect,
  the launcher's icon fading as it grows, the pill's contents coming up as
  it lands; every close runs the same morph back into the circle (340ms,
  the app's leading curve; reduced motion cuts). The pill:
  a grab handle on top, then `+` (Photos · Camera · Files), the field ("Ask
  your secretary"), dictation, the voice call, and × (back to Closed).
  Tapping the pill, or swiping up on it, raises the keyboard in the field — it
  never pulls up history.
- **Full**: after a send, or dragging the handle up, the pill grows upward
  into the conversation card (the whole thread, briefing card included) over
  a dimmed page. Its height **follows the finger**: dragging down shrinks the
  card and fades the conversation with it (opacity tracks the drag, the dim
  too), and on release it snaps — past halfway down to the Bar, otherwise
  back to Full; a fast flick decides by direction. Nothing ever stops half
  open. The × in its header closes to Closed.

Every assistant reply, typed or spoken, carries two small actions: **copy**
(the text to the clipboard) and **speak** (read aloud in the user's chosen
voice through `POST /api/speak`, OpenAI TTS with the realtime voice names;
tap again to stop). The full-screen voice call has no transcript toggle; its
minimize control is a labelled button, not a bare caret.

The voice button in the pill starts the global voice call pill-first. **A
call and a chat are one widget**: while a call is live and minimized, its row
(status, full screen, the live mic, end) takes the composer's place in the
same card — same grabber, same drag, and swiping up shows the same
conversation with the live transcript in it. The card stays up for the whole
call (Closed reads as the pill). There is no expand button and no Minimize:
a swipe up anywhere on the pill — the call row included — opens the card,
with the call row staying at its foot all the way up. The call's separate
full-screen view is only a fallback for a page with no dock. The `?c=` deep link (push receipts) opens the dock in Full on the
linked thread.

Tabs (Dashboard · Canvas · Spreadsheet · …) keep a single sliding indicator:
one accent bar that **travels** to the active tab on every change — click or
programmatic — never teleports. Motion: the edge facing the destination leads
(faster curve) while the trailing edge settles behind it, so the indicator
stretches toward the target and contracts into place (~350ms, standard
easing). Off-tab routes (projects, documents) fade the indicator out.
`prefers-reduced-motion` cuts instantly. Home (`/`) is the Dashboard.

---

## 7.8 Attachments (any file type, safely)

The composer accepts **any** file type — the picker carries no `accept`
attribute, because iOS maps each accept entry to a UTI and greys out everything
unmapped (this is what made `.xlsx` unselectable). Files arrive by paperclip,
by paste, and by drop. What a file *is* is decided once, in
`classifyAttachment` (`lib/attachments.ts`), from its mime with its extension as
a fallback — never stored as a column, because the classifier changes and a
stored kind would go stale.

**Serving is the security boundary, not the upload.** The mime on an upload is
client-supplied and is never trusted. Only `INLINE_MIME` — the four raster
types plus PDF — is served back with its own `Content-Type` and
`Content-Disposition: inline`. Everything else is `application/octet-stream`
with `attachment`, so a stored `.html` or `.svg` can never become a same-origin
document running script under the session cookie. `next.config.ts` adds
`default-src 'none'` for `/api/attachments/:id`; that entry **must sit after
the catch-all**, because for a duplicate header key the last matching entry
wins and a route handler cannot set its own CSP at all. Any UI that renders an
attachment keys on the same `INLINE_MIME` set — a `startsWith("image/")` test
would show a broken `<img>` for an SVG.

**File content is untrusted data.** Extracted text is fenced exactly like
inbound email: a bracketed header carrying the rule inline, `----- BEGIN/END
FILE CONTENT -----` delimiters, the terminator scrubbed from the payload so a
file cannot close its own fence, and CR/LF stripped from the filename so it
cannot forge a header line. Truncation is always stated, never silent.

**The two providers differ in exactly one declared place**, `CAN_READ_OFFICE`:
OpenAI reads docx/xlsx/pptx/csv through `input_file`; Anthropic's document block
is PDF-only. A file the chosen model cannot read produces an honest note —
stored, contents not extracted, do not guess — never a fabricated image block.

**Stored size and sent size are separate ceilings.** `MAX_STORE_BYTES` (25 MB)
is what may be kept; `MAX_SEND_BYTES` (8 MB per file) and `MAX_TURN_SEND_BYTES`
(12 MB per turn) bound what is base64'd into a model request. A file over the
send ceiling is still stored, and the model is told it exists but wasn't
readable. Because attachment bytes never replay — history is text-only and the
OpenAI server-side chain is dropped after any Claude turn — a bounded fenced
extract is persisted into the stored user message so a later "what was in row
14?" still has something to read.

---

## 8. Golden fixtures (these become the test suite)

Fixtures are (signals → assertions on the plan). Materialize each as a test.
Shared base: 4 projects — `patent` (deadline 2026-08-10, committed, days_left 3,
people:[Avery]), `album` (2026-08-18, committed, days_left 11, people:[Jasper]),
`fetchit` (2026-09-07, inferred), `canterly` (none, 2 items missing dates).
Baseline engagement 2/day each; `days_since_layout_change: 2`; nothing pinned;
calm_mode false. Each fixture overrides only what it names.

**F1 quiet-day** — base as-is, no strong signals.
→ plan deep-equals DEFAULT_PLAN; `reason_summary` null; zero `why`s; zero wishlist.

**F2 timeline-day** — `schedule_word_share: 0.42`, `questions_today` includes 3
schedule questions.
→ first section is `timeline` with `expanded: true, span_days: 14` and a `why`;
patent card still on the board (invariant 4: days_left 3); patent keeps accent
(rule 1 beats rule 3's compacting); non-accented cards `compact`.

**F3a engagement-promote** — `engagement.patent.mentions_24h: 14`.
→ patent card: `accent, full, inline_loops`, positioned immediately after
`hero_next_up`, `why` mentions "14" and "2"; exactly one accent in plan.

**F3b engagement-no-reorder** — same as F3a but `days_since_layout_change: 0`.
→ patent card accented + full + inline_loops **in its DEFAULT_PLAN position**;
section order deep-equals DEFAULT_PLAN order. (Emphasis free, movement rationed.)

**F4 nested-structure** — `album.subprojects`: 4 entries with own counts.
→ album card `variant: "nested"`; if album also within 14d committed it may take
accent per rule 1 (patent days_left 3 still wins accent — assert accent is on
patent, album nested without accent).

**F5 validator-rejects** (unit tests on validator, not planner):
- unknown component `"burndown_chart"` → section dropped, rest renders, reason logged.
- plan omitting the patent card entirely (days_left 3) → whole plan rejected,
  fallback returned.
- two cards with `accent: true` → rejected or auto-demoted to one (pick one
  behavior, document it, test it).
- prose/markdown instead of JSON → fallback, no throw.
- pinned section moved → rejected.

**F6 calm-mode** — `calm_mode: true` + strong signals everywhere.
→ DEFAULT_PLAN verbatim, planner not even called (assert via spy/counter).

**F7 chat-ban (tier 1)** — user says "stop showing me the people section."
→ chat calls `set_layout_preference({ban_component: "people_index"})`; live plan
re-renders without it immediately; any later planner plan containing
`people_index` is rejected by the validator until the preference is removed.

**F8 chat-new-view (tier 2)** — user asks "show the album as a burndown chart."
→ painted on the Canvas immediately (if Canvas is built); priority wishlist
entry written; Dashboard interim plan substitutes `timeline(14, expanded)` with
`why: "closest I have until the burndown view is built"`; on-demand slow-loop
job enqueued (assert enqueued); assert no runtime import of anything outside
the approved registry.

**F9 canvas-sanitize** — painter output includes `<script>alert(1)</script>`,
an `onclick=` attribute, a `<form>`, and `<img src="http://evil.example/x.png">`.
→ sanitizer strips all four; result renders in the sandboxed iframe (assert the
`sandbox` attribute and CSP are present); a snapshot is saved with brief +
timestamp; no network request leaves the iframe (assert via request interception
in the test).

---

## 9. Phases & acceptance criteria

**Phase 0 — Recon (no code changes).** Read the codebase. Produce
`docs/adaptive-ui/INTEGRATION.md`: where the dashboard renders (files), where
projects/items/chat live, where signals can be computed from, existing
test/tooling conventions, and a ≤ 1-page integration plan mapping every §2–§6
concept to a concrete file path. STOP for human review.

**Phase 1 — v1 shippable.** Registry + types + validator + renderer +
`planFromRules` + signals computation + fixtures F1–F6 green + calm-mode toggle
in Settings + plan/revert log table. Rendering DEFAULT_PLAN must reproduce the
current dashboard's content (visual parity with `reference-demo.html` aesthetics
where the app lacks a design). Spreadsheet untouched (assert zero diffs under its
source dir). Why-chips render on adapted sections.

**Phase 2 — v2 planner + chat tier 1.** `planFromLLM` + prompt file + JSON mode +
cache + fallback chain + morning `reason_summary` banner + pin/revert UI +
decision log. Chat tools `get_current_plan` / `edit_layout_plan` /
`set_layout_preference` wired into the secretary agent; F7 green. All Phase 1
tests still green with LLM mocked; one integration test with recorded LLM
responses (never live calls in CI).

**Phase 2.5 — Canvas v0 (§7.6).** `paint_canvas` + `edit_canvas` chat tools;
sanitizer + sandboxed iframe host + shell primitives (`data-expand`,
`data-link`, `data-check`); streaming render; snapshot history with restore;
`canvas-painter-prompt.md` in repo (given Signals + brief → one HTML fragment,
inline styles from design tokens, no scripts, every number from signals).
F9 green. Independent of Phase 2 — can be built right after Phase 1 if the
"paint while I talk" feel is wanted early.

**Phase 3 — slow loop + chat tier 2.** wishlist.jsonl + brief assembly + nightly
AND on-demand (`request_new_component`) triggers + `components/proposed/` with
preview + in-chat and Settings approval flows + registry versioning + tombstones.
Acceptance: a seeded wishlist produces a proposal; approving registers it (no
restart); rejecting tombstones it; F8 green; unapproved code is provably never
imported at runtime.

---

## 10. Receipts (why these choices)

- Declarative plan over runtime code-gen: Google's production A2UI vs their
  minute-plus generative-UI demo; Anthropic's Imagine-with-Claude shipped as a
  time-boxed research demo. (developers.googleblog.com A2UI; research.google
  generative-ui post; arXiv 2604.09577.)
- Movement rationing + graceful failure: Findlater & McGrenere, CHI 2009
  (ephemeral adaptation) — moving items under imperfect prediction is worse than
  no adaptation; stable-position adaptation degrades gracefully.
- Suggest-and-approve over silent automation: Lavie & Meyer, IJHCS 2010 —
  intermediate adaptivity beats full automation outside routine situations.
- Accent ≠ recolor: color already encodes deadline pressure in this app's design
  system; Findlater also found color highlighting alone yields no performance gain.

## 11. Agent-layer requirements (from the Aug 18 voice transcript)

These sit in the extraction/agent layer, not the LayoutPlan renderer — build
them alongside Phase 2. Each traces to an observed failure or success in a real
claude.ai session used as a fixture (the record is kept outside the public repo).

- **persona_config**: `{strictness, tone, praise, followup_aggressiveness,
  quiet_hours}` — stored once, editable in Settings, applied to voice, chat,
  UI copy, and the nag engine. Never re-requested per conversation.
- **stakes on commitments**: a `stakes` field ("miss reconcile → strike from
  HQ") captured when the user names a consequence. Nags must cite stakes when
  present — it's what makes sternness honest rather than theatrical.
- **pipeline templates**: ordered steps with `blocked_by` dependencies,
  instantiable per item (e.g. CPO: update → sign → pay → reconcile+submit),
  with per-step dates and optional recurrence (monthly statement cycles).
  "Where am I" answers must read from pipeline state, never from summary memory.
- **expectations / nag engine**: any promised follow-up ("I'll be asking")
  writes `{commitment, expected_update_by, on_miss escalation, stakes_ref}`.
  A user report clears it silently; a miss fires per escalation policy.
  Rules: batch nags into one ping, respect quiet_hours, escalate per persona.
  Reuses the scheduled-trigger machinery; never a rhetorical promise.
  **Raised once, and only by being asked (v1.03).** A follow-up that is due
  is raised in the briefing that opens a session with the user and is handed
  to the model: a chat turn, or the start of a voice call (not a reconnect,
  and not an interview call, whose job is its own questions). It stays
  `open` until that hand-over has succeeded: the model answered the chat
  turn, or the provider accepted the call's instructions. Only then is it
  settled (`missed`), and it is not raised again. Building a briefing for
  anything else (the chat dock's bootstrap on every page load, the briefing
  card, `consult_brain`) neither shows the follow-up nor changes it, and a
  hand-over that fails leaves it open for the next one. So does a user
  report in the meantime: it still clears it silently. Before v1.03 every
  briefing build settled what it found, so opening a page cancelled the
  promise before any conversation began.
- **clarification queue**: extraction ambiguities accumulate in a queue asked
  ONE at a time at natural pauses — never mid-flow, never as a barrage.
  Sources: unresolved referents ("this one is finished" while reading an
  unseen screen), unparseable ASR spans (kept with audio offsets, marked
  [unclear], never silently guessed), low-confidence new names (confirm
  spelling before any document use), entity conflicts (see next).
- **entity cross-reference on extraction**: every person/org mention resolves
  against the store before write. A mention matching an existing entity can
  never be silently dropped or merged — conflict → clarification queue.
  (Fixture: "Melissa, Tamsin Malvey, my boss" — Melissa existed since Jul 30;
  the session dropped her without asking.)
- **ASR lexicon export**: the store continuously exports a vocabulary (people,
  orgs, project terms, acronyms: CPO, CalCard, QTB…) into the realtime voice
  session's transcription biasing config. Update on every new entity.
- **voice modality rule**: voice replies ≤ 2 sentences + at most one question,
  ending with the single next action. Anything visual routes to a surface
  (Canvas paint or Dashboard plan edit) and the voice says "on your screen."
  "I can't draw a chart out loud" is a forbidden answer.
  A status is never spoken as a bare word: "blocked" alone is a database row
  read aloud, not an answer. The voice names what the item is stuck ON and
  what clears it ("the CPO's sitting with Tamsin till she signs it"), read
  from the blocker recorded on the task (`tasks.blocked_reason`, set by
  `log_status`'s note and cleared the moment any other signal moves the item).
  When the reason is NOT recorded, that one question is asked IN FLOW, once —
  the sole exception to the clarification queue, and only because it is about
  the thing just spoken; topical adjacency is what makes it conversation
  rather than an interrogation. Anything else the voice is unsure of still
  goes to `queue_clarification` for a natural pause, and the pause rules are
  untouched: a hold ("one sec") is still met with silence, never this
  question. A stale blocker surfaces in the briefing as
  `blocked (reason unknown — ask if it comes up)` so it gets asked at a pause
  instead of re-litigated mid-flow.
- **cross-session recall**: every session (voice and text) opens with real
  prior-conversation context: the current thread's NEWEST turns (a window that
  keeps what was just said, never the opening turns of a long thread) plus a
  small verbatim tail excerpt of the last few prior sessions — both modes,
  labeled with mode and timestamps. Excerpts are verbatim lines, never
  summaries. Anything older is on-demand via `search_history` (substring
  match over all transcripts, optional after/before time filters, results
  labeled with mode) — which is why the voice session carries it too.
  Text threads roll over after 6h idle (stamped `ended_at` on next open), so
  "last session" is a real boundary the excerpts can quote.
- **fast/slow split**: the realtime voice model (mouth/ears) carries only
  persona + today's brief + lexicon + thin tools (`log_status`,
  `create_commitment`, `amend_task`, `schedule_checkin`, `paint_canvas`,
  `show_canvas` — "open the canvas" flips the in-call canvas into view
  (§7.6 auto-open) without a repaint —
  `get_current_datetime`, `queue_clarification`, `resolve_clarification`,
  `consult_brain`, `request_capability`, `review_capability`,
  `search_history` — cross-session recall on demand ("what did I say about X
  last week?") — and
  `remember_fact` — an explicitly *stated* fact is fast-path capture: one
  insert, no entity resolution; the extractor stays the safety net for
  *inferred* facts). `log_status` carries a `dropped` signal: "that
  shouldn't be a task" / "forget that one" removes the item from the
  checklist on the spot (status → dropped, audit check-in, "✕ Dropped:"
  toast) and it can be reinstated just by asking (status back to todo).
  When the drop states a durable rule ("never make Canterly checks a
  task"), the mouth pairs it with `remember_fact` in the SAME turn — the
  same idiom as stated-fact capture; the extractor's own `dropped` signal
  stays the safety net, and its dedupe never resurrects a dropped task.
  A change to something ALREADY logged ("file that under Canterly",
  "rename it", "add a note to it") is `amend_task` — a thin delegate to
  `update_task` that files (or unfiles: "none"), retitles, or annotates
  the EXISTING row, never a second commitment. The create-guard backs it
  up: a re-issued create that names a project fills a BLANK project on
  the existing twin instead of silently dropping it — fill-only, always
  toasted; a project already set is never overwritten.
  The extractor (brain) runs async 2–5s behind each
  utterance, writes the store, and injects clarifications back for the next
  pause. The store is the only truth; a dead voice session loses nothing.
  **Events by voice (2026-10-06, SEC-A002).** The mouth also carries
  `create_event`, `update_event`, `delete_event` and `add_event_to_google`.
  Kiron: "I just wanted to add something real quick for Daily Reminder, but
  I couldn't do it." The extractor's inferred events stay in the app and never
  reach Google Calendar, so a spoken "add a daily reminder at 8" needs the
  write itself, said back from its result before the call moves on, and
  "undo that" needs the delete. The extractor dedupes against the event the
  mouth just made (same title, same instant, both read in the user's zone).
  These are the same tools chat uses, through the same `executeTool`; the
  only difference a turn makes is `ToolContext.calendarSync`
  (`liveTurnContext`): a turn with an attachment asks before Google.
  **Mail by voice (2026-10-06, SEC-A005).** The mouth also carries
  `email_summary`, `search_email`, `read_email`, `draft_email_reply` and
  `confirm_pending`. Reading mail marks the conversation
  (`conversations.untrusted_at`); from then on `executeTool` turns every
  write there into a proposal (`pending_actions`, HMAC-sealed), confirmable
  only by the user's own next words after the line that asked, within ten
  minutes, and run exactly as stored. A yes is the whole message. On a call
  the order is the Realtime conversation's (the client numbers items and
  sends the call's key and the number with each transcript and tool call;
  `lib/realtime/item-order.ts`), never arrival time, and a call's proposal
  is answered only on that call. An intake thread (channel "email") holds
  mail from its start; only lines with origin "app" are the user's words.
  The intake still files what is forwarded to it (decided 2026-10-06: the
  forward from the user's own authenticated address is the consent); what
  it files stays local, never synced to Google without a yes in the app.
  Reading, looking and drafting stay open (`UNTRUSTED_OK`); a draft goes
  only to the original sender and is never sent.
- **capture never depends on external apps**: the store is the system of
  record; Reminders/Calendar are optional exports. An export failure becomes a
  visible pending item, disclosed once — capture itself cannot fail on a
  third-party permission. Google Calendar is the first such export
  (lib/google/calendar.ts): one way, app → Google, by the stored Google event
  id; an event the Google write refused is `google_sync = failed`, said in the
  reply, and retried by the next yes (`add_event_to_google`). A dead grant
  (revoked, or a Testing-mode app's 7-day refresh expiry) turns the
  connection "disconnected" with one push that day; Settings → Reconnect.
  Edits made in Google do not come back.
