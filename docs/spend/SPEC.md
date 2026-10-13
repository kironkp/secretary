# Spend: what is counted, what stops, what warns

Source of truth for how the app counts what it spends on model calls and what
it does about it. Written 2026-10-12 (v1.04); until then the rules lived only
in code comments. To change behaviour, change this first, then the code.

The reason all of this exists (Kiron, 2026-09-25): a night of background
reading on the most expensive fallback model cost about $40 while no one used
the app. "If an app spends so much we need a fail safe. And a way to notify
me."

## 1. One count

Every paid call writes one row in `usage` through `recordUsage`
(`lib/usage.ts`). The row is priced when it is written, from the rate card of
that day (`lib/pricing.ts`), and the dollars are stored (`cost_usd`). A later
change in prices never rewrites a stored row.

Everything below reads that one column: the Settings spend card, the caps and
the alert. If a call is not in `usage`, nothing sees it.

- An unknown model is never free: it is priced at the most expensive rate on
  the card and marked estimated.
- A figure that rests on an assumption is marked estimated (`cost_estimated`).
- Prices change by appending a rate card with a later `effectiveFrom`, never
  by editing one in place.

### 1.1 A cache write is priced as a cache write (v1.04)

Anthropic bills three kinds of input: fresh, read from the cache, and written
to the cache. A write costs more than fresh input: 1.25 times for a 5-minute
cache, 2 times for a 1-hour cache. Until v1.04 the app counted written tokens
as fresh input, so every first call of a chat turn or an understanding run was
under-counted.

- The row keeps how many of its input tokens were written to the cache
  (`cache_write_input_tokens`). `input_tokens` stays the total of all three
  kinds, as before, and `cached_input_tokens` the part read.
- The rate comes from the card, per model and per lifetime. Source and the
  date it was read are next to the rates.
- The lifetime the app asks for is stated in one place
  (`lib/prompt-cache.ts`). Every request that marks a prefix cacheable takes
  its marker from there, and so does the price. Today it is 5 minutes, the
  provider's default.
- When the lifetime is not known, or the model has no cache-write rate on
  the card, the write is priced at the higher candidate (the 1-hour rate, or
  twice the model's input rate) and the row is marked estimated.
- Rows written before v1.04 are not rewritten. Their column is empty and
  they keep the cost they were stored with.

The schema change: one column added to `usage`, `cache_write_input_tokens`,
integer, nullable, no default, no backfill. Nothing is dropped, renamed or
rewritten. The release applies it with the same `drizzle-kit push` as every
other additive change.

### 1.2 A call that was sent and did not come back is still counted (v1.04)

A request the provider received costs money whether or not the app hears the
answer: the app's own timeout fires, the connection drops, the stream is cut.
Until v1.04 such a call left no row at all, so the caps could not see it.

- When a paid call was sent and no usage came back, a row is written with an
  estimate that is not below what was sent: one token per two bytes of
  everything in the request. Measured on this app's own requests on
  2026-10-12, a token is 2.4 to 3.0 characters (`docs/jarvis/BASELINE.md`),
  so two bytes a token errs high. The row is marked estimated. Output is not
  guessed: the row is a floor, not a full price.
- A call the provider refused before doing any work (a rate limit, a bad
  key, no credit, a malformed request: HTTP 4xx) cost nothing and writes no
  row.
- A call that reported its usage and then failed (a refusal, an answer that
  does not validate) was answered: it is recorded as it reported, not
  estimated.
- When the app stops waiting for a call, it aborts the request as well. A
  call left running is billed for an answer nobody reads.
- v1.04 does this for the dashboard planner. The other background call
  sites are listed in the LOGBOOK entry with what each leaves today.

## 2. What stops

All amounts are per user, over the last 24 hours (a rolling window, not a
calendar day), summed from `cost_usd`. Chat, voice calls, dictation and
read-aloud are the user's own turn and are never stopped by a cap.

| Limit | Variable | Default | Stops |
|---|---|---|---|
| Understanding, a day | `UNDERSTANDING_DAILY_CAP_USD` | $3 | understanding runs (the sweep, "Understand now", "ask me more", an answer's re-read) |
| Understanding, one run | `UNDERSTANDING_RUN_CAP_USD` | $1.50, never over the daily cap | the next attempt of a run that could pass it |
| All background work, a day | `BACKGROUND_DAILY_CAP_USD` | **$3** (v1.04; it was $4) | understanding, extraction, the dashboard planner, the slow loop, inbound email, suggestions |
| Everything but the user's turn | `SPEND_KILL=true` | off | every paid call except chat, voice, dictation and read-aloud |

- A cap of 0 turns that work off. Unset, empty, negative or not a number is
  the default.
- The all-background cap's default is $3 in code since v1.04, the same as
  the value production has had set since 2026-10-12. A default that is looser
  than what production runs is a trap for the next environment.
- With both daily caps at their $3 defaults, understanding alone reaching
  $3 stops all background work, and the push that goes out is the
  all-background one ("Background work paused"), not the understanding one:
  the wider cap is asked first. That is what production has done since
  2026-10-12, when it was set to 3 there.
- An understanding run counts as its own ceiling before it starts, and runs
  still reading count as theirs, so two runs that start together cannot both
  fit under the cap on the same spend.
- At a cap, the user is told once that day by push; the work starts again as
  the spend rolls out of the window.

## 3. What warns

- `SPEND_ALERT_USD` (default $8): one push the first time the last 24 hours
  of all spend cross it.
- A provider that refuses for money (no credit, a spend limit): one push a
  day naming the provider.

Every alert is sent at most once per user per UTC day.

## 4. Work nobody asked for costs nothing when nothing changed (v1.04)

Background work runs on timers and on page loads. Run twice over data that
did not change, the second run makes no paid call. This holds per kind, and
across a restart of the process (what is remembered in memory does not
count):

| Kind | What makes the second run free |
|---|---|
| Understanding | the stored record's inputs hash; a failed run on the same inputs backs off until they change |
| Extraction | the conversation's high-water mark (`extracted_at`), written and compared inside the database at its full precision |
| Suggestions | once in 24 hours, from the last attempt in this process or the last recorded call |
| Dashboard planner | the stored plan's signals hash |
| Inbound email | a message already taken in is not read again |

A test runs each of these twice and counts the calls.

The mark is the reason for "inside the database": until v1.04 it was read
into the app, where a timestamp keeps milliseconds, and written back. The
message it stood for is stored to the microsecond, so that message was
"after the mark" for ever: every run read it again, and a run with nothing
new still paid for a read whenever that message was the user's.

## 5. Not in this spec yet

Reserving money before a call is sent, the cost of email attachments at the
cap, caps on chat and voice, and the size of the prompts themselves.
