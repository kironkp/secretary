# Tasks

What a task holds and how it changes. The task screen and the labels in notes
come with 1.10; this file starts with the notes themselves (v1.17).

## 1. Notes: a model write never loses his (v1.17)

A task's notes are his. Before v1.17 every model write of a note replaced the
whole note (update_task, and amend_task and log_status through it), so a note
he had typed went the moment the model added one, and his own save from the
editor wiped what the model had added while it was open.

### 1.1 A model's note is added, never replaces

Every model write of a note adds lines to it:

- update_task `notes`, amend_task `note`;
- log_status `note` on progress, started, postponed and dropped (on done see
  §1.4, on blocked §1.5). Until 1.10 decides where progress goes, progress
  lines collect in the note;
- create_task on an open task of the same title (§1.3);
- add_to_list on an item already on the list: the item gets the note (the
  `note`, or else the list's purpose from the phrase), as a new item does;
- extraction on an open task of the same title (§1.3);
- update_event `notes`, on the event's notes (§1.7).

The new text is taken a line at a time: each line without its trailing
spaces, blank lines dropped, each line once. A line is added only if no line
of the note is the same line (compared with the note's trailing spaces
trimmed too), and the lines added go after the note, in their order, on
lines of their own. If every line is there already, nothing is written and
the result says it was already in the note; otherwise the result says what
was added. So no line is ever there twice, however a write is repeated.

The adding happens in one UPDATE, reading the row's own note in the SET
expression: never read in one statement and written in another, so two
writes at once (a chat turn and the background extraction) both land. Where
a result needs the note as it was (§1.2, §1.4), it is read in the same
statement, under the row's lock.

### 1.2 Replacing only when he asks

update_task `replace_notes`, amend_task `replace_note` and update_event
`replace_notes` replace the whole note with the new text ("" clears it). The
tool text keeps them for when he asks to change or clear the note. The result
gives back exactly the text that was replaced.

### 1.3 The same title

"The same title" is equal once lowercased, trimmed and with its runs of
spaces made one.

- create_task with a note, on an open task of the same title: nothing is
  created, the note is added to that task (§1.1), and the result says so.
- create_task with a note, on an open task only similar to it (the create
  guard's similarity): nothing is created, the result names the similar task
  and says the note was not saved; the model can add it to the right task
  with update_task.
- Extraction: a task it finds with a note, on an open task of the same title,
  adds the note there. On a merely similar one, or a finished one, the note is
  not saved and is counted in what extraction returns (there is no model
  result to say it).

### 1.4 Done, with a note

log_status done with a note adds the note in the same UPDATE that marks it
done (before v1.17 that note was dropped). The note stays on the finished
task. A recurring task's next occurrence copies the note as it was before that
done note, so done notes do not pile up from one occurrence to the next.
Otherwise the next occurrence copies the note as before.

### 1.5 Blocked

log_status blocked: what it is waiting on goes in `blocked_reason` only, not
in the notes. The task view shows it in a "Waiting on" row while the task is
blocked. Notes that already hold reasons stay as they are.

### 1.6 His own edits

The view's in-place note and the editor send, with his text, the note as it
was when he opened it (`notesBase`). The route compares the stored note with
that base, line by line in order (a longest common subsequence), under the
row's lock:

- nothing changed since: his text is stored exactly as sent;
- lines were added since (by a model, while he was typing): they are kept,
  after his text, in their order, each once, and not when his text already
  has the line (blank lines are not carried);
- lines he deleted that were there when he opened it stay deleted;
- a page loaded before v1.17 sends no base: his text, then the stored lines
  his text does not have. Nothing is lost; a deletion made through such a
  page may come back;
- a replace he asked for by voice while the editor was open: his text, then
  everything added since he opened it, the replacement included (it is new
  since he opened it); he can delete it.

His text is never altered: no label check, no trimming of his lines, his
repeated lines kept.

### 1.7 Events

No pull from Google writes `events.notes` (lib/google/calendar.ts only
inserts, patches and deletes), so update_event adds as in §1.1 and the whole
note goes to Google as the event's description.

### 1.8 What the understanding model reads of a note

A note over 300 characters reaches the understanding model as its head and its
tail with a cut between them, the same 300 characters in all, so the newest
line is not the first one lost (it was the head alone). The understanding
stamp (gather.ts taskStamp) reads the stored note, not the prompt, so no hash
changes and no project is read again for it.

### 1.9 Cost

The note is in the understanding stamp, so a model note write that changes a
note is a paid re-read at the next sweep, as before. A write whose lines are
all there already changes nothing and costs nothing. New writes: a note on an
open task of the same title (create_task, extraction), a note on an item
already on a list. A done note is in the same UPDATE as the completion, which
changes the stamp anyway. log_status blocked writes one field fewer.

## 2. A task reads like a reminder (v1.10)

Kiron, comparing with Notion and Apple Reminders: "It should be really
simple", "simple and working and no clutter"; the field labels a model wrote
into notes were "completely unnecessary for me to know"; "the priorities
don't really work for me". The screen is the approved
`1-task.html` (design/2026-10-14-simple-screens), its top half; tags, a
place, a link, images and files are part two (1.14).

### 2.1 Notes are plain words

A task's note is a line or two of plain words in his terms, or nothing. Every
detail he states is still kept: in its own field when one exists, otherwise
as a short plain sentence in the note. The prompts say so: persona.ts (the
intake line and the "every concrete detail" line), and every notes field
(create_task, update_task, amend_task, log_status, add_to_list, extraction):
"a line or two of plain words, or nothing; no 'Label:' lines; never what has
its own field". No tool or persona text holds an example note in
"Word: …" form. log_status's note is "only what is worth keeping on the task,
a short plain line; nothing when the signal says it all"; progress stays in
his note (§1.1).

One backstop, `plainNote` (lib/secretary/plain-note.ts), reads the model's
NEW text only: never the combined note, never his typing (the PATCH route),
never recurrence's copy, never §1.6's merge. Line by line (split on real and
on literal "\n"), each line is read with its leading bullets and numbers,
markdown bold and italic and case set aside, and ":", "：", "—", "–" and "="
all read as a colon. A line is a label when it opens with one of
`NOTE_LABELS`, plurals included, then that colon:

owner, assignee, depends on, dependency, effort, next action, next step,
evidence, status, status of record, priority, blocker, blocked by, waiting on,
deadline, due, source.

There is no list rule: "Gate code: 4412", two detail lines, a time
("11:00 AM PT / 2:00 PM ET"), a link and "Mon: 8-5" all pass. A label in the
middle of a line ("Call first. Owner: Sam") passes too; the prompt covers it.

On a label:

- In a live turn the whole note is not saved and the rest of the call is.
  The result carries `note_not_saved`, the line that tripped it, and "say it
  as plain words, a line or two". A turn is live when the chat route or the
  voice tools route says so (`ToolContext.live`, set at those two call sites;
  chat-claude runs with the chat route's context). Taps (the projects route,
  the timeline routes) and understanding answers are not live; none of them
  writes a note.
- Anywhere else (extraction, suggestions, a tool call that is not live) the
  note is stored as written and the slip is counted: extraction's summary
  carries `notesLabelled`, and the log line gives counts only, never text.

Events' notes are not checked (out of scope).

### 2.2 No priority

Priority is not shown and not asked: not in the task view, not in the editor
(which never sends it, not even 0), not in create_task's or update_task's
arguments or the tool text. A tool call that still carries it writes nothing
there (the schema drops it). The column stays and keeps its values; the PATCH
route still accepts it; recurrence still copies it. A Workspace widget may
still name the sort "priority" (it validates), and it sorts by due.

### 2.3 "Suggested:"

A suggested task's note is the reason alone (its source already says
suggested). Notes stored with the old "Suggested: " prefix stay as they are
and are shown without it, by one helper (lib/suggested.ts) shared by the task
view, the dashboard's suggestion card and the briefing.

### 2.4 The task screen

On a phone (under 640 px wide) it is the whole screen; wider, the same content
in the dialog, at most 420 px wide. Events keep their dialog as it is. It sits
above the tab bar and the voice button, so nothing of it is under them.

- Header: "Task", and "Done". Done saves an open note draft (with its §1.6
  base) and closes; so do Escape and a tap outside on a wide screen. Only the
  note's Cancel discards a draft.
- The title card: the done circle, the title, the note.
  - The circle (a 44 x 44 button, 24 px drawn): an outline in muted when
    open; filled accent with a white tick when done. Tapping an open task
    completes it through the one path complete_task uses (finishTask's work:
    the checkin, its expectations, a recurring task's next occurrence once).
    A done task that does not recur reopens (the PATCH to todo, which clears
    its completedAt). A done recurring task's circle is drawn done and is not
    a button: reopening it would leave two open copies.
  - The title opens the editor. The note is plain text under the title, no
    "Notes" label, edited in place (§1.6); "Add a note" when there is none.
- The rows card, in this order:
  - Due: the date as text ("None" when there is none); tapping opens the
    native picker in place, drafted and saved once when it closes; a clear
    button while there is a date; "repeats weekly" (its rule) muted under it.
  - Remind me: the next reminder (else the latest), "+N" for the others,
    "None" when there are none; tapping opens the editor.
  - Project: its colour dot, its name and a chevron; "None" unfiled; tapping
    opens the editor.
  - Waiting on: after Project, while the task is blocked.
- "More", one row at the bottom, collapsed every time the screen opens: Status
  (with "pushed N×"), Stages, the packet section, Heard, From and History, in
  that order. Nothing that was on the screen is gone until Kiron says.
- The editor loses only priority; its look is 1.15's.
- Every touch target is a 44 x 44 hit box. The title is a 44-tall button
  level with the circle, and the note one below it; with a one-line note
  that puts the note 4 px lower and the card 10 px taller than the mockup,
  whose title and note together are 84 px tall.

Values, from 1-task.html (light; dark uses the app's dark tokens for the same
roles, text at 4.5:1 or better):

| Role | Value | Token |
|---|---|---|
| Ground | #f2f2f7 | --bg |
| Card | #ffffff, radius 12 | --card |
| Ink | #1c1c1e | --ink |
| Muted text, open circle | #6e6e73 | --muted |
| Accent text and row icons | #3a5bd0 | --accent-ink |
| Done circle fill | #4a6fe8, white tick | --accent |
| Separator | 1px rgba(60,60,67,0.18) | --hairline |
| Header | 56 tall, padding 0 8 0 16; "Task" 17/600 | |
| Done button | min 64 wide, 44 tall, 17/600, accent text | |
| Body | padding 0 16 24, cards 16 apart | |
| Title card | padding 6 16 16 6, gap 2, items at the top | |
| Circle | 44 x 44 hit, 24 drawn, stroke 1.8 | |
| Title column | gap 6, padding-top 10 | |
| Title | 20/24, 600 | |
| Note | 16/22, muted | |
| Row | min 48 tall, padding 0 16, gap 12 | |
| Row icon | 22, stroke 1.8, accent | |
| Row label and value | 16; the value muted | |
| Project dot | 12 inside a 22 box | |
| Chevron | 16, stroke 2, muted | |
