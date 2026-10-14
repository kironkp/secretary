# Projects: his order

Source of truth for the order his projects stand in, how he changes it, and
the Projects screen. Written 2026-10-14 (v1.11). To change behaviour, change
this first, then the code.

The reason (Kiron, 2026-10-13, comparing one project prompt in Secretary and
in Notion): he wants to drag a project to the top, and to say "move that
project to the top", and have it stay there. Approved on 2026-10-14 with the
Projects screen below: "make the projects movable".

## 1. One order

Every screen that lists his projects puts them in one order, decided by one
comparator (`lib/project-order.ts`):

1. **Lists after projects**, as before (a list is not work to chase).
2. **His order first.** A project he has placed stands where he put it,
   placed ones in his order (`projects.position`, a whole number, empty
   until he moves something).
3. **Then urgency**, for every project he has not placed: urgent first
   (late open work, or its date within the week: docs/adaptive-ui/SPEC.md
   §3 invariant 4), then late first by how late, the nearest date or
   deadline, no date, and by name. Urgency still shows on each card as a
   chip ("2 days late", "Due tomorrow"); it no longer moves a project above
   one he placed.

Until he moves something, nothing is placed, and the Overview and the
Timeline stand exactly as before. The Projects tab does change: it was in
alphabetical order within each group, and is now in the one order.

Where the one order applies: the Projects tab, the Overview's run of project
cards, its progress strip and the Timeline's lanes, and what a model is
handed as his projects (list_projects, the briefing's projects). Where it
does not, on purpose: the filter chips on the List and Board views (most
recent activity first, so the project he is working in is at hand), the
project picker in the task editor (by name, to find one), and the
understanding loop's own internal orders.

On the Projects tab the groups stay as they are (Active, Lists, Set aside);
within each group, the one order.

## 2. A move

One operation, whether he drags a project by its handle, taps the handle's
arrow keys, or says "move Garden shed to the top" in the chat or on a call:
**a project goes to a place in its group, and stays there.**

- The place is counted in the order he sees, in the project's own group
  (Active projects among active projects, a list among lists, a set-aside
  project among set-aside ones). Spoken, it is the top, the bottom, up one,
  down one, or above or below another project.
- What it means for the stored order: the project, and every project above
  it in its group, are placed, in the order they now stand. Everything below
  it that was not placed stays unplaced, in urgency order. So "to the top"
  places one project; "third" places the three at the top. Moving a project
  down past unplaced ones places those it passes.
- A move changes nothing else: no task, no card on the Overview he placed
  there, no other group.
- The answer says where it is now, in his words ("Garden shed is at the top
  of your projects"). When its card on the Overview is one he placed there
  himself, the answer says that card stays where he put it ("On the
  Overview, its card stays where you put it"), whether he dragged or asked
  (see §4).
- One move is one transaction: the group's rows are read and written
  together, so two moves at once cannot interleave into an order neither
  asked for.

**A project that changes group** (set aside, made active again, made a list
or a project) arrives in its new group unplaced, at its urgency place, and
loses its place in the group it left; the group it left keeps its order.

## 3. A move costs nothing

A move never asks a model. Not the drag (a database write and a redraw),
not the tool (the chat or call turn that heard him is the only model call),
and not the Overview's planner afterwards: the signals the planner is asked
about, and their hash, do not carry the order, so the next render is served
from the plan already stored for these signals and only composed again.
A test counts the calls after a move: planner 0, model 0.

## 4. The Overview

The cards he did not place on the Overview follow the one order (docs/
adaptive-ui/SPEC.md §2, composition step 3). A card he placed on the
Overview itself (by voice, the chat tool or the pin button, v1.02) keeps
its place there: a move in his project order moves the run of cards, not a
placed card. Named limit until 1.07, when his placements become a list of
their own: then a project's order and its card's place can be one thing.

## 5. The Projects screen

Reference: `2-projects.png` beside this file (made-up content), drawn at 390
wide and approved by Kiron on 2026-10-14; the values below are its inline
styles.

- Ground `#f2f2f7`. Title "Projects", 34/40 bold, 16 px gutter; a "New
  project" button (44 × 44, a 24 px accent plus) at its right. It opens a
  row at the top of Active with the name field focused; Enter, or leaving
  the field, makes the project by the path the chat's create_project takes
  (so a near-duplicate name is the project he already has, not a second
  one), and it arrives unplaced, at its urgency place. An empty name makes
  nothing; Escape closes the row.
- Each group is one white card, radius 12, the cards 10 px apart. A group
  other than Active has a heading above its card, 20/26 bold.
- A row: at least 56 px, 16 px in from the left, 4 px from the right; a
  12 px dot in the project's colour; the name, 17 regular, taking the room;
  "N open", 15 muted (`#6e6e73`); the grab handle. Rows inside a card are
  divided by a full-width hairline (`rgba(60,60,67,0.18)`). A tap on the row
  (not the handle) opens the project.
- The grab handle: a six-dot glyph, 20 px, `#8e8e93` on the white card, in
  a 44 × 44 button named "Reorder <project>". While held it is accent
  (`#3a5bd0`) and the row is lifted: its own white card, shadow
  `0 10px 28px rgba(0,0,0,0.18)`, 6 px wider on each side, the name
  semibold. The rows it passes make room for it. Let go, it stays there at
  once, before the server has answered, and the order is stored; if the
  store fails it goes back, and a plain line says so ("Couldn't move Garden
  shed. It's back where it was."). Two drags in quick succession are stored
  in the order he made them, one after the other; an answer to the first
  never puts the list back under the second.
- Touch: the handle's hit box is 44 × 44, and a drag starts only there. On
  a phone the handle is dragged straight away (no long press; the page does
  not scroll while it is held). The rest of the row still scrolls the page
  and still opens the project on a tap; a drag never starts from it. With
  the keyboard, the handle's arrow keys move the project one place.
- Motion: 340 ms on the app's own curve for the rows making room; none
  with reduced motion.
- Dark: the same roles on the app's dark tokens, text at 4.5:1.
- Nothing else on the row: no chevron, no second line. The project screen
  has the rest.

## 6. Limits, named

- A card placed on the Overview keeps its place when the project moves in
  his order (§4), until 1.07.
- A project that changes group starts unplaced in the new one (§2): set
  aside and brought back, it does not return to its old place.
- The filter chips and the task editor's picker keep their own orders (§1).
