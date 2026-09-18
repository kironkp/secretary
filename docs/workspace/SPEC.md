# The Workspace — spec and build plan

**Status: proposed, 2026-09-17. Nothing here is built.**

A new top-level surface: a board of independent widgets that you drag, resize,
and talk to, bound to live data. The Canvas stays exactly as it is, on its own
tab, untouched, until the Workspace is better.

This document is the source of truth for the Workspace. Per `CLAUDE.md`, change
this file before changing the code.

---

## 1. Why this exists

The Canvas is a photograph of your data. The model paints HTML, it is stored as
frozen markup, and from that moment it is stale: complete a task elsewhere and
the Canvas still shows it open until something repaints. Every change costs a
model call and a full repaint. That is why it cannot feel alive, and no amount
of styling fixes it.

A Workspace is the opposite. The board holds widgets bound to live data. When a
task changes, the widget changes, with no model call. The model's job becomes
deciding **what to show and how to arrange it**, not drawing it.

The north star is unchanged (`CLAUDE.md`): one system, voice primary, the shell
owns geometry, the model owns content, perceived continuity beats literal
patching. The Workspace is the first surface that can actually deliver it.

## 2. The decision that makes it possible

**Widgets render inline in the app document. No iframe per widget.**

Almost every Canvas defect follows from one choice, one sandboxed iframe per
block:

| Canvas symptom | Root cause |
|---|---|
| No drag, no touch resize, no long-press | Pointer events happen inside a child document the host cannot see |
| 500 ms measure loop, staircase shrink, 24 px clip | Heights are unknowable from outside, so they are polled and fed back |
| Reorder reloads the board | Moving a keyed holder re-navigates its `srcdoc` |
| Tap delay on iPhone | The child document has no viewport meta |
| One edit repaints everything | There is no addressable render unit smaller than the whole canvas |

Rendering inline removes all five at once. It is also already sanctioned: the
dashboard renderer's fallback arm renders server-sanitized model markup inline
with `dangerouslySetInnerHTML`, and `lib/canvas/sanitize.ts` namespaces classes
to `cv-`/`sl-` precisely because that inline path exists.

The cost is that the sanitizer becomes a hard security boundary rather than a
belt beside the sandbox's braces. §7 states what that requires.

## 3. Model

### 3.1 Widget

```ts
type Widget = {
  id: string;              // stable kebab-case, generated once, never reused
  title: string;           // spoken name: "the Caltrans one"
  x: number; y: number;    // grid units, not pixels
  w: number; h: number;    // grid units; h is a minimum, content may grow it
  z: number;               // stacking, and the tie-break for "the top one"
  collapsed: boolean;
  body: string;            // sanitized markup, may contain binding attributes
  query?: BindingQuery;    // optional live data source
  createdAt: string; updatedAt: string;
};

type Workspace = {
  id: string; userId: string;
  name: string;            // boards are named; "my planning board"
  widgets: Widget[];
  grid: { cols: number; rowPx: number; gap: number };
  theme?: CanvasTheme;     // reuse the existing theme vocabulary
  version: number;         // bumped on every write, used for conflict detection
};
```

Geometry is grid units, not pixels. Pixels do not survive a phone and a 16-inch
display. The grid is 12 columns on desktop and collapses to 1 on narrow widths,
where widgets stack by `y` then `x` and drag is disabled in favour of reorder.

`h` is a minimum. A widget whose content is taller grows, and the board reflows
below it. Nothing is ever clipped. This is the direct answer to the Canvas's
worst rendering bug, and it is free once heights are real DOM heights.

### 3.2 Binding

The query never lives in the markup. The widget carries a validated query
object; the markup only names fields. This keeps the query vocabulary closed,
keeps the sanitizer's job small, and makes every read trivially user-scoped.

```ts
type BindingQuery = {
  source: "tasks" | "events" | "projects" | "documents" | "checkins";
  where?: {
    project?: string;              // project id or name, resolved server-side
    status?: TaskStatus[];         // from the existing enum
    due?: "overdue" | "today" | "week" | "month" | "none" | "any";
    blocked?: boolean;
    stakes?: boolean;              // has stakes recorded
    search?: string;               // ILIKE over title/notes, reuses searchAll
  };
  sort?: "due" | "created" | "updated" | "priority" | "procrastination";
  limit?: number;                  // 1..50, bounded
};
```

Validated by zod, resolved only through `lib/db/queries.ts`, always `userId`
first. This is the same load-bearing-validator pattern the LayoutPlan already
uses, and it should be as strict.

### 3.3 Binding attributes in markup

Five attributes, all allow-listed in the sanitizer with validated values.

| Attribute | Meaning |
|---|---|
| `data-each` | On a container: repeat its first element child once per row |
| `data-field="title"` | Replace text content with that field of the current row |
| `data-count` | Replace text content with the number of rows |
| `data-row-check` | Marks a row as tickable. The shell writes the real task id into `data-check` |
| `data-action="add-task"` | An affordance the shell wires to a write |
| `data-empty` | Shown only when the query returns zero rows |

`data-row-check` exists because `data-check` keeps an absolute rule: it must
always carry an id-shaped value, because it reaches the task API. A template has
no id yet, so it carries the marker and the shell fills the real attribute once
it has a row. The Canvas's guarantee is unchanged, and a widget bound to
projects or events never gets `data-check` at all.

The model writes one item as a template and the shell repeats it. So this:

```html
<div class="cv-card">
  <h3>Caltrans</h3>
  <ul data-each>
    <li data-check><span data-field="title"></span> <em data-field="due"></em></li>
  </ul>
  <p data-empty>Nothing open. </p>
  <button data-action="add-task">Add</button>
</div>
```

becomes a live list that grows and shrinks on its own. The model never sees the
rows, never writes a task title, and never needs to be called again to refresh.

Field names are a closed vocabulary per source, documented in §11, not free
access to columns.

### 3.4 Storage

A new `workspaces` table, and widgets as jsonb on it, following the precedent of
`canvas_snapshots.composition`:

```
workspaces
  id text pk, user_id text not null (cascade), name text not null,
  widgets jsonb not null default '[]', grid jsonb not null, theme jsonb,
  version integer not null default 0, is_default boolean not null default false,
  created_at timestamptz, updated_at timestamptz
```

Widgets are jsonb rather than rows because the whole board is read and written
as a unit, ordering matters, and the Canvas has already proven the pattern. If a
board ever needs per-widget history, that is the moment to normalize.

**Required alongside**: indexes on `tasks(user_id)`, `tasks(user_id, status)`,
`tasks(user_id, due_at)`, `events(user_id, starts_at)`. Today `tasks` has only
its primary key, so every read is a sequential scan. At 102 rows that is
invisible; it is a cliff, and the Workspace is what pushes you off it.

## 4. Interaction

**Drag.** Every widget has a grab handle in its header. Pointer events on the
host, `setPointerCapture`, position by `transform` during the gesture, commit to
grid units on release. Never reorder DOM nodes: render in a stable key order and
let position come from CSS alone. This is the invariant the Canvas documents in
a comment and then violates one line later, and the Workspace must enforce it in
a test, not a comment.

**Resize.** A corner grip, quantized to grid units, with a minimum size. On
coarse pointers the grip and the handle are at least 44 px. The Canvas shipped
an 18 px checkbox on a row that navigated away on a near miss; no target in the
Workspace is below 44.

**Select.** Tap a widget to focus it. Selection is written to the server,
because voice reads it there. This is the single most important existing pattern
to carry over: the Canvas already posts selection server-side for exactly this
reason, and it is what makes "make that bigger" work after a drag.

**Tidy.** One command packs widgets to remove gaps. It is also what rescues a
board after a clumsy drag, so it is a first-class affordance, not a debug tool.

**Undo.** Geometry undo and redo, per batch. `lib/canvas/composition.ts` already
implements exactly this and its op pipeline is reusable with a widened
vocabulary.

## 5. Freshness

There is no SSE, no websocket and no subscription anywhere in the app today.
Everything is `router.refresh()` or a poll. The Workspace should not invent a
transport before it needs one.

The rule: **one request returns the board and every binding's rows.** Not one
query per widget. `GET /api/workspace` returns widgets plus a resolved rowset
per binding, and a `dataVersion`.

Refresh happens on three triggers:

1. **Optimistic, on local writes.** Tick a checkbox, the row updates instantly
   and the write goes out behind it, with the Canvas's exact rollback discipline
   on failure.
2. **On mutation from anywhere in the app.** A window event carrying which
   sources changed, so only widgets bound to `tasks` refetch.
3. **A slow poll**, 15 s, as the safety net for changes made by voice on another
   device. This matches what the Canvas already does.

Upgrade to SSE only when the poll is visibly late. At 102 tasks it will not be.

## 6. Voice

Voice and touch are the same operations on the same objects. Three new tools.

`arrange_workspace` — geometry, **no model call, no repaint**, exactly as
`arrange_canvas` works today: resolve the reference, apply ops, one jsonb write.
Ops: `move`, `resize`, `collapse`, `expand`, `remove`, `focus`, `tidy`, `undo`,
`redo`.

`add_widget` — the model supplies a title, a body template and a query. This is
the only Workspace tool that costs a model call.

`show_workspace` — switch to the tab and optionally focus a widget.

**Hard schema constraint.** The Realtime API rejects `oneOf`, `allOf` and `$ref`
and unbounded integers, and one bad schema kills the whole voice session. The
existing `arrange_canvas` is deliberately a flat object rather than a
discriminated union for this reason, and there is a test enforcing it across
every voice tool. Workspace tools must be flat too, with every integer bounded.

**Reference resolution** reuses `lib/canvas/focus.ts` unchanged. It is pure,
storage-agnostic, and already the one thing that makes "that" mean the same to
voice and to a finger. The Workspace writes focus on tap, drag and voice select.

**`ToolUIAction` must grow a payload.** Today it is a single member with no
fields, and the client turns it into a monotonic counter, so it cannot carry a
widget id. It becomes a union with `{type: "show_workspace", focusId?: string}`,
and the two client branches change accordingly.

**The briefing gains a WORKSPACE block**, listing widget ids and titles the way
it already lists canvas blocks, so the model can say "the Caltrans one" and mean
something.

## 7. Safety

Rendering model markup inline in the app document makes the sanitizer the whole
boundary. Non-negotiable:

- The existing allowlist stands: no scripts, no event handler attributes, no
  forms, no external loads, no inline `style` that is not `safeStyle`.
- Classes stay namespaced. A free-form class is an app-covering overlay.
- The five binding attributes get **value validation**, the way `data-check`
  already validates its id shape. `data-field` accepts only names from the
  closed per-source vocabulary.
- Widget bodies are sanitized **on write**, then again on render. Never trust a
  stored body.
- `data-action` maps to a fixed set of shell behaviours. It never carries a URL,
  a method or a payload.
- A widget body has a size cap, and a board has a widget cap.

Add a test that renders a corpus of hostile bodies into a real DOM and asserts
nothing escapes the widget's bounds, no handler fires and no network call is
made. This is the one place where "the tests cannot see it" is unacceptable.

## 8. What gets reused

| Module | Verdict |
|---|---|
| `lib/canvas/focus.ts` | As-is. The voice/touch agreement mechanism |
| `lib/canvas/blocks.ts` | As-is. Segment, verify, replace by id |
| `lib/canvas/composition.ts` | Widen. Op pipeline and undo are right; geometry is ordinal and needs x/y/w/h |
| `lib/canvas/sanitize.ts` | Extend. Add the binding attributes and their validation |
| `lib/canvas/perf.ts` | As-is. The counters that tell you whether the board is alive |
| `components/shell/detail-dialog.tsx` | As-is, via its window event. Full task editing for free |
| `components/dashboard/shared.tsx` | As-is. `CheckButton`, `fmtDue`, `isOverdue`, `StageDots`, `isMomentumTap` |
| Theme tokens, `app/globals.css` | As-is |
| `components/canvas/canvas-view.tsx` | Leave behind. Its worst properties follow from the iframe |
| `lib/canvas/refresh.ts` | Leave behind. A nudge to re-poll is not data invalidation |

Two small refactors worth doing first, because both are duplicated today: pull
the motion constants into `lib/motion.ts`, and export the task status predicates
from `lib/db/queries.ts` instead of keeping them module-private.

## 9. Build order

Each phase is demoable on its own. Nothing later is required for something
earlier to be worth using.

**Phase 0 — a browser in the loop.** Playwright in CI on an iPhone profile. One
test: load a board, drag a widget, assert it moved and persisted. Half a day.
This is first because four Canvas attempts shipped green and broken, and the
suite structurally cannot see a tap. Without this, phase 1 fails the same way.

**Phase 1 — the board.** Tab, table, `GET`/`POST /api/workspace`, widgets with
static bodies, drag, resize, collapse, select, persistence, tidy, undo.
No live data yet. Ships a board you can arrange with your hands. Two to three
days.

**Phase 2 — live bindings.** The query type and its validator, the resolver, the
single-request payload, `data-each` / `data-field` / `data-empty`, and the three
refresh triggers. This is where it stops being a picture. Three to four days.

**Phase 3 — writes in place.** `data-check` on bound rows, `data-action`
add-task, tap a row to open the existing detail dialog. Creation goes through
`executeTool` because there is no REST create path and there should not be two.
Two days.

**Phase 4 — voice parity.** The three tools, the focus writes, the briefing
block, the `ToolUIAction` payload. Everything you can do with a finger, you can
say. Two to three days.

**Phase 5 — the model builds boards.** A painter that emits widgets with
bodies and queries rather than one slab of markup, seeded with the current
board, holding the old one until the new one completes. Reuses the Canvas's
never-blank discipline, which is hard-won and orthogonal. Three days.

**Phase 6 — feel.** The 340 ms motion language on every move, collapse and
insert. Leading edge first. `prefers-reduced-motion` honoured. Phone layout.
Empty states. A palette for dragging a new widget onto the board. Two days.

**Phase 7 — cutover.** The Canvas tab becomes "Canvas (legacy)". A one-way
importer turns an existing canvas into widgets. Delete nothing until you have
lived on the Workspace for a fortnight.

Roughly three weeks of focused work. Phases 1 through 3 are the ones that change
your daily life; 4 is what makes it yours.

## 10. How each phase is judged

Not by exit codes. By the north star's own metric: does it feel like a living
workspace.

- Time to first visible response after a spoken command
- Whether old state stayed stable while new state arrived
- Whether scroll, selection and expansion survived a data change
- Whether a dragged widget stays where you put it, on a phone, first try
- Whether interruption and undo work

Every phase ends with a real browser on a real board. "Tests pass" is not a
claim that anything works, and this project exists because that lesson cost four
rebuilds.

## 11. Open questions

1. ~~**Field vocabulary.**~~ **Decided, phase 2.** `FIELDS` in
   `lib/workspace/types.ts` is the closed per-source list: tasks get `title`,
   `due`, `status`, `project`, `stage`, `stakes`, `blocked`, `notes`, `created`;
   events `title`, `when`, `location`, `project`, `notes`; projects `name`,
   `status`, `deadline`, `open`; documents `title`, `project`, `updated`;
   checkins `note`, `task`, `when`. The sanitizer keeps its own copy so it stays
   dependency-free, and a test asserts the two cannot drift.
2. **Multiple boards or one?** The model allows many. The first release should
   probably ship one default board and hide the rest until named boards earn
   themselves.
3. **Free position or packed?** This spec says free placement with snapping and
   a tidy command. A packing layout is friendlier but less like a playground.
   Decide in phase 1 by feel, on the device.
4. **Does the Workspace replace the adaptive dashboard, eventually?** They
   overlap. Not a question for now, but the answer shapes phase 7.
5. **Cross-device conflict.** `version` is in the model for optimistic
   concurrency, but the resolution policy (last write wins, or refuse and
   reload) is undecided.
