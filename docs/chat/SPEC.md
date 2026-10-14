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

A request that does not ask for a stream gets the plain JSON answer as before:
a page opened before this release, and the tests that read the answer whole.
It is the same turn underneath, written once; only the wrapping differs.

**Compression.** `next start` gzips responses. Whether it holds a stream back
is measured on the built app (the LOGBOOK entry gives the numbers); if it
does, the stream is sent with `Cache-Control: no-transform`, which the
compression step obeys, for this route only.

## 2. A turn runs once

The page names each turn it sends with an id of its own (random, made in the
browser, kept with the message's retry payload). The server keeps one row per
turn in `chat_turns`, keyed by the user and that id. A turn from another user
with the same id is a different turn.

When a request names a turn that already has a row:

| The turn is | The request gets | A model is asked | Rows written |
|---|---|---|---|
| done | the saved answer | no | none |
| running, and heard from in the last 60 seconds | the same answer when it comes (pings while it waits) | no | none |
| running, and silent for 60 seconds (the process that ran it is gone) | runs it, taking it over | yes | the answer; not his message again |
| failed | runs it again | yes | the answer; not his message again |

So a retry never runs or pays for a turn that finished or is still running,
and never stores his message twice. A turn that failed (no model could
answer) left no answer, so asking again is a new attempt at the same turn, on
the same stored message. The running turn writes the time it was last heard
from at every ping.

A request with no turn id (an old page) is a turn of its own, as before.

## 3. A cut connection

The turn does not depend on anyone listening. If the connection drops, the
turn runs to the end, is saved, is paid for, and its row says done, exactly as
when the page waits for it.

The page treats any of these as a drop: the stream ends before its last line,
the request fails on the network, or the answer is not the stream at all (the
router's own 503 page). It then asks again, with the same turn id, at once,
after 2 seconds and after 5 seconds. Each ask returns the saved answer, or
waits on the turn still running. Only when all three fail does the message
say "Not delivered — tap to retry", and the tap asks with the same turn id
again. Reloading the page shows the saved answer too, as before.

An answer that says why it failed (the provider has no credit, there is no
key) is not a drop: the page shows that sentence, and the tap runs the turn
again (§2, failed).

## 4. Money

Claude rounds spent before the turn falls back to OpenAI are counted
(docs/spend/SPEC.md §1.2): the rounds that answered as they reported, and a
round that was sent and never answered at the estimate, unless Claude
refused it before doing any work.

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
  find their own earlier result, some do not).
- A page opened before this release posts without a turn id and reads JSON,
  so it keeps the 30-second limit until it is reloaded.
- Turn rows are kept (one small row per message); nothing deletes them yet.
- Voice does not use this route.
