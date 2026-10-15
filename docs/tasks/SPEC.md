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
  has the line;
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
