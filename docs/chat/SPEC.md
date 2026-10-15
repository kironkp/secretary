# Chat: a turn reaches him, once

Source of truth for how a written chat turn (`POST /api/chat`) is delivered
to the page and what a resend does. Written 2026-10-14 (v1.09). To change
behaviour, change this first, then the code.

The reason (Kiron, 2026-10-13, "error try again"): one chat answer took longer
than 30 seconds and Heroku's router cut the request at 30,007 ms (H12, 503)
while Claude was up. The route waited for the whole answer, tools and all,
before it sent a byte, and Heroku allows 30 seconds to the first byte. The
turn itself ran on to the end, was saved and was paid for, but the page said
"Not delivered" until a reload, and the tap to retry ran and paid for the
same turn a second time.

## 1. Bytes within a second, and kept flowing

The page asks for a stream (`Accept: application/x-ndjson`). The answer is one
JSON object per line, in this order:

- `accepted`, as soon as the turn is his and his message is stored, before any
  model is asked: the turn id, the conversation id and the id of his message.
- `text`, while Claude writes: the next piece of the answer and the round it
  belongs to. A piece from a later round starts the answer over (a round that
  ended in a tool call said something before the tool ran; the answer is what
  the last round says).
- `ping`, whenever nothing else has gone out for 5 seconds, so the
  connection never waits long on a tool or a slow model. Heroku's router
  allows 30 seconds to the first byte and 55 seconds between bytes after that.
- the last line, either `done`, carrying exactly what the plain answer carries
  (the conversation, his message id, the saved answer, the toasts, the UI
  actions), or `error`, carrying the sentence the page shows.

A request refused before any work (not signed in, nothing said and nothing
attached) keeps its HTTP status and its JSON body, as before.

**On the page: the thread follows the answer until his hand is on it
(v1.09 r5).** Four versions tried to tell from his scroll whether he still
wanted to follow, and each was beaten by a race (the layout moving the
thread, a lift sent to a node that had gone, a piece landing between a
scroll and its event). The rule now needs nothing but his first touch:

1. **On** at each send of his (and his tap to retry), and when the panel
   opens. On a call, each new line of his is a send (v1.09 r6): it turns
   following on through the same path as a typed one, so a hand on the thread
   during one spoken answer does not leave the next exchange written under
   the composer. A spoken move and a touched move are the same. His line's
   words can come after the answer has begun, so it is judged from when his
   turn began (his speech committed as an item, marked then; nothing moves
   at the mark): a send only if no hand of his, and no scroll with no input
   that stopped following, has come since. A line with no words (an empty or
   noise transcript) is never a send. A line whose turn was never marked is a
   send (a real stream always marks first; the page logs it once a call, so
   a renamed event shows); the lines already there when the thread is opened
   during a call are not.
2. **Off for the rest of the turn** at his first hand on the thread: a
   touch, a wheel, a mouse or pen down on the thread or its scrollbar, or a
   scroll key (PageUp, PageDown, ArrowUp, ArrowDown, Home, End, Space) when
   no field has focus. Off is one way: nothing he does with the thread turns
   it back on, so nothing waits for his finger to lift, and nothing decides
   from where he stopped.
3. **A "New reply below" pill** turns it back on and puts the bottom in view.
   It is at least 44 px tall, stands clear of the composer, and shows only
   while following is off, the bottom is out of view, and something has been
   written below since following stopped. His next send turns it on too. Its
   words are at 4.5:1 or better in both themes: white on #3a5bd0 in light
   (5.85:1), #1c1c1e on #7a9bff in dark (6.45:1). Its own two colours, so
   the app's other accent buttons are untouched (their contrast is 1.15's).
   The chat card is drawn dark whatever his theme, so the dark pairing is the
   one he sees.
4. **A scroll with no input** (VoiceOver, the iOS scroll indicator, find in
   page) turns following off when it is not the position the page last wrote
   and leaves him more than 32 px above the bottom as it stood when the page
   last wrote (or as it stands, if the content has grown shorter). What was
   written since is not his scroll: the panel growing pulls the position
   down to the old bottom in the same moment a new piece lands. A clamp (the
   panel growing taller, a round that starts over shorter) leaves him at the
   bottom, so it never counts. The page checks this before every write too:
   such a scroll's event can come after the next piece.
5. **While on**, every piece, every round that starts over, and every change
   in the size of the thread or of what it holds puts the bottom in view, at
   once.

The cost, named: a tap anywhere on the thread while he reads at the bottom
(on Copy, say) stops following for that turn, until he taps the pill.

The thread's own moves go through the same rule: his send and the panel
opening turn following on; so does the end of a call, when the saved messages
take the place of the spoken lines and the thread lands at the newest; a jump
to a message found by search turns it off.
While an answer is written, the room of the row that will hold its Copy and
Read aloud buttons is kept below it, so when it lands nothing moves. "Not
delivered — tap to retry" is a 44 px tall target: it is the only way he runs a
turn again.

A request that does not ask for a stream gets the plain JSON answer as before:
a page opened before this release, and the tests that read the answer whole.
It is the same turn underneath, written once; only the wrapping differs.

**Compression.** `next start` gzips responses. Whether it, or anything else
between the route and the page, holds a stream back is measured on the built
app, asking for gzip as a browser does: the first line must arrive while the
model is still working, long before the last (the LOGBOOK entry gives the
numbers). If it is held back, the stream is sent with
`Cache-Control: no-transform`, which the compression step obeys, for this
route only.

## 2. A turn runs once

The page names each turn it sends with an id of its own (random, made in the
browser, kept with the message's retry payload). The server keeps one row per
turn in `chat_turns`, keyed by the user and that id: its conversation, his
message, and, once it is done, the id of the saved reply (the reply's text is
the message row; it is not copied) with the toasts and UI actions it gave, or,
if it failed, the sentence that says why. A turn from another user with the
same id is a different turn.

A turn says it is alive on a timer of its own, every 12 seconds, for as long
as it runs: while it waits on a model, on a tool or on the database, whether
or not anyone is listening and whatever the model sends. A turn not heard
from for 60 seconds is taken to be gone (the process that ran it ended). So
one model call that takes longer than a minute does not make the turn look
gone, and is not run a second time.

There are three kinds of ask: a send (a new turn), his tap on "tap to
retry", and the page's own asks after a drop, which say they are only
resuming (`resume`). When an ask names a turn that already has a row:

| The turn is | A send or his tap gets | A resume gets | A model is asked |
|---|---|---|---|
| done | the saved answer | the saved answer | no |
| running, heard from in the last 60 s | the same answer when it comes (pings while it waits) | the same | no |
| running, silent for 60 s | runs it, taking it over | "Not delivered" | only for the send or tap |
| failed | runs it again | the failure | only for the send or tap |
| not there at all | (a send makes it) | "Not delivered" | no |

An ask waiting on a running turn that then goes silent is treated, at that
moment, as if it had just arrived: his tap takes it over, a resume answers
"Not delivered".

Taking a turn over, or running a failed one again, is one conditional update
of its row: the ask that changes it from silent (or failed) to running is the
one that runs it, and an ask arriving at the same moment finds it running and
waits. So two asks can never both run it.

So a retry never runs or pays for a turn that finished or is still running,
never stores his message twice, and the page's own asks never start a paid
run. A turn that failed (no model could answer) left no answer, so his tap is
a new attempt at the same turn, on the same stored message. A turn whose
process is gone is run again only when he taps.

A request with no turn id (an old page) is a turn of its own, as before.

## 3. A cut connection

The turn does not depend on anyone listening. If the connection drops, the
turn runs to the end, is saved, is paid for, and its row says done, exactly as
when the page waits for it.

The page treats any of these as a drop: the stream ends before its last line,
the request fails on the network, or the answer is not the stream at all (the
router's own 503 page). It then asks again, with the same turn id and marked
`resume`, at once, after 2 seconds and after 5 seconds. Each of these only
fetches or waits (§2): it returns the saved answer, waits on the turn still
running, or brings back the failure. When the answer is a failure, or all
three asks fail, the message says "Not delivered — tap to retry" (or the
sentence the failure gave), and only the tap asks without `resume`, with the
same turn id.

An answer that says why it failed (the provider has no credit, there is no
key) is not a drop: the page shows that sentence, and the tap runs the turn
again (§2, failed). Reloading the page shows the saved answer too, as before.

## 4. Money

Rounds spent on a turn that did not end in an answer from that provider are
counted (docs/spend/SPEC.md §1.2): Claude's rounds before the turn falls back
to OpenAI, and OpenAI's rounds before it fails part way. The rounds that
answered are counted as they reported; a round that was sent and never
answered at the estimate, unless the provider refused it before doing any
work.

**In this order, once a model has answered (v1.09 r2):** first its usage, in a
write of its own; then the reply and the turn's done mark, in one
transaction; then, the answer being saved, the follow-ups it raised are
settled and OpenAI's chain id stored. So a database error after the model
answered never loses what it cost, and never leaves a reply on a turn that
failed: his tap runs it again (a new attempt, counted again) and stores the
one reply. A failure in the last step is said in the log; the turn stays
done, and a follow-up not settled is asked again next time.

## 5. What a turn may not do yet: merge projects

`update_project` with `merge_into` answers that merging projects is not
available yet, and changes nothing: no task moves, nothing is renamed and
nothing is deleted, whatever else the same call asks for. Until v1.09 it moved
the tasks and then deleted the old project, and with it everything else that
belonged to it. It comes back with 1.12. The tool's description says so, and
the persona no longer sends the model to it for duplicates. Voice uses the
same tool, so the same holds there.

## 6. Limits, named

- The OpenAI fallback sends no `text` lines: pings, then the answer whole.
- A request waiting on someone else's run of the turn gets pings and the
  answer, not the pieces.
- When Claude fails part way, the turn runs again on OpenAI from the start,
  and the tools Claude already ran run again (as before v1.09; some tools
  find their own earlier result, some do not). That is a duplicate write (a
  task made twice), not only a cost. Placed in 1.08.
- A page opened before this release posts without a turn id and reads JSON,
  so it keeps the 30-second limit until it is reloaded.
- Turn rows are kept (one small row per message); nothing deletes them yet.
- Seen only on a device, not in the browser tests: iOS momentum, VoiceOver,
  and dragging the iOS scroll indicator. The rule does not depend on them
  (any touch turns following off; a scroll with no input counts by rule 4).
  The browser tests drive the thread with a mouse wheel in Chromium and
  WebKit, a mouse button, a key, and real touches in Chromium (Playwright
  sends Chromium touch input through the DevTools protocol; it has none for
  WebKit).
- Rule 4 measures from the bottom as it stood at the page's last write, so a
  scroll with no input that lands in the same moment as the view growing by g
  px (the panel opening, the keyboard closing) counts only when it leaves him
  more than g + 32 px above the bottom. Device-only: no browser test makes a
  scroll with no input in that moment.
- On a call, the first words of an answer can come before his own line is
  heard; they are followed from when it is. (After a hand in the turn
  before, the head of the answer can be written under the composer for its
  first few pieces.)
- A turn's usage is one row, written when the model has answered. A process
  killed part way through a turn (a restart in the middle of its rounds)
  loses the rounds it had answered so far: they are in memory until then.
  Writing each round as it is answered would make every turn several rows,
  and every count that reads a turn as one row would change; not done in
  v1.09.
- Voice does not use this route.
