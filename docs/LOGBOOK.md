# Logbook

A running record of what changed, why, and what it cost. Newest first.

Versions are the session's own numbering, not npm versions. Each entry names the
commits it covers so `git show <hash>` always reaches the real diff.

---

## v0.31.1 — Reading: a button that reads wrong is dropped, not the whole read; most-used projects first (2026-10-06)

this commit

sec rev's production check after the unpause (v53):

- Caltrans still failed, now on one answer label, `"Not yet, do it
  Friday"` (five words where a button takes four). The $1.50 run ceiling
  leaves no room for a second attempt, so each change to Caltrans paid
  about $0.81 for a record that was then thrown away. A rule about how a
  piece reads now drops that piece instead: the answer option, a question
  that reads wrong or has no answer left, the Today line, a lede. Dropped,
  never shortened ("Not yet" with writes that set Friday would be a button
  doing what it does not say), never rewritten, never a second call. The
  record's own claims are never dropped, and every rule about sources,
  ids, evidence and writes still rejects as before.
- The sweep read projects alphabetically, so the $3 day went to Caltrans,
  DAW and Find It before Jazz or Personal. It now reads the most recently
  used first, judged only by the user's own signals: their messages about
  a project, the tasks they asked for by voice or chat, and their answers
  to its questions. What the app writes itself (extracted or suggested
  tasks, records) never counts, so the order cannot feed itself.

---

## v0.31 — Gmail, round 2: a yes is a yes, on a call it goes by the call's order, mail stays where it was read (2026-10-06)

this commit

sec rev found three ways around v0.30's gate; sec plan folded in SEC-A005b.

- A yes is the whole message (R1): after case and punctuation, only consent
  words ("yes", "yes add it", "okay go ahead") and courtesy ("please",
  "thanks", "now"), six words at most. "Okay, read me the next one", "Sure,
  what's the weather" and "do it later" used to pass because they start
  like a yes; in speech "okay" often opens a new request.
- On a call, order is the call's own (R2). A transcript is posted when it is
  ready, and OpenAI says the transcription event can come before or after
  the response, so an earlier "Yes." could be stored after the question and
  read as the answer to it. The client now numbers items as the Realtime
  conversation adds them (lib/realtime/item-order.ts; an item put in
  between gets no number) and sends the call's key and the number with
  every transcript and tool call. A proposal made on a call is answered
  only on that call, by the user's first line after the line that asked;
  a line without a number never answers, and a confirm without one is
  refused ("ask again"). A chat's proposal is answered only in the chat.
  The answer must come right after the question: if the secretary speaks
  again first (a second question, or the answer's transcript never came),
  the question lapses and the proposal is refused; it has to be proposed
  and asked again.
- Mail stays where it was read (R3). The briefing's PRIOR SESSIONS carried
  the last lines of recent conversations, the secretary's included, into
  every new session: a mail-borne instruction retold there reached a
  conversation that had never read mail and so wrote without asking. Now,
  from where mail was read, only the user's own lines come over, with
  "(email was read here; details not carried over)".
- Intake threads (SEC-A005b): a conversation the INBOUND_EMAIL intake made
  holds mail from its start (the mail is stored there as a user message),
  so chatting in it proposes like any conversation that read mail. Only
  what the user typed or spoke in the app (messages.origin = "app": the chat
  route and the call transcript route) can say yes, so mail stored as a user
  message never can. Understanding, the layout signals and the ASR check
  read the user's own words, not that mail. The intake itself is unchanged:
  it still files what Kiron forwards. It is not configured on Heroku.
  Decided (sec plan, 2026-10-06): keep it. Forwarding from his own
  DMARC-authenticated address is his deliberate act. What it files stays
  local: no Google sync and no other outward action until he says yes in
  the app (tested).

Every reader of stored messages, and what it does with mail:
- briefing PRIOR SESSIONS (getRecentConversationTails): the user's own lines
  only, plus the note
- search_history: marks the conversation it brings mail into
- extraction: in a conversation that read mail, the user's lines only; an
  intake thread's mail is still filed (the intake's purpose)
- understanding gather, layout signals, ASR retirement: the user's own words
- chat history (loadHistoryWindow), the painter's excerpt: the same
  conversation, already gated
- thread view, spreadsheet transcripts, search page, the voice route's
  anchor: display or ids only

Allowed after mail, by choice: the canvas tools (mail text can be painted,
sanitized and without links out) and consult_brain (mail text can reach
Claude, a paid call under the spend guard).

---

## v0.30 — Gmail: what's new, find, read, draft; never sends; mail can't act (2026-10-06)

this commit

Kiron said yes to all three: a summary of what's new on demand, finding mail
mid-conversation, and replies drafted into Gmail. It never sends; he does,
from Gmail.

- Connect Gmail in Settings: the same Google grant as Calendar, adding
  gmail.readonly and gmail.compose (both restricted; a personal-use app runs
  unverified behind Google's warning). The feature rides in the OAuth state,
  so the callback already registered serves both.
- email_summary, search_email, read_email, draft_email_reply, by voice and
  chat, on demand only; Gmail calls are free and the turn's own model does
  the summarizing. Mail text comes back fenced as data (a forged end marker
  is defused), cut at 4,000 characters, and nothing from it is stored here.
  The Gmail client has no send method; a draft goes to the original sender's
  From address alone, with no Cc or Bcc, whatever the mail or the body says.
- The gate: reading mail marks the conversation (the first time, by the
  database clock). From then on every write a tool would make there (tasks,
  events, Google Calendar, memories, lists, the dashboard, a web search) is
  a proposal, sealed with an HMAC; the server shows "Needs your yes: …" in
  its own words, and the reply asks. Only the user's next message after the
  reply that asked, within ten minutes, can confirm it by saying yes
  plainly, and what runs is the stored row, unchanged, claimed so a second
  confirm finds it taken. A yes in the same turn, a yes from before, any
  other answer first, a changed row and an expired one are all refused.
  "Next" is read from the conversation's stored order, so a call whose
  transcript is posted after the tool fired still works. Reading, looking
  and drafting stay open; mail is read only inside a conversation.
- Around the gate: extraction no longer reads what the secretary said after
  mail was read in a conversation (the user's own words still count), and
  search_history bringing such lines into another conversation marks that
  one too.

Known limits: email text a tool returns stays in OpenAI's stored response
chain (previous_response_id) for that conversation, as any tool result
does. The yes answers the reply that asked; if the model words that reply
falsely, the server's "Needs your yes" line is what tells the truth. Chat
inside an INBOUND_EMAIL intake thread (?c=) is unchanged: that mail is
stored as the user's message there, as before. Not covered by a test: the Settings Gmail section (no component tests).

---

## v0.29 — The board by touch: tap targets, "Arranged by you", show puts it back (2026-10-06)

this commit

Polish on v0.27 from review in a real browser.

- Every tick on the dashboard is a 44 px target around its 20 px circle
  (CheckButton), and a list card ticks an item by its whole row. CLAUDE.md
  records an 18 px target on a link row turning near-misses into
  navigations; the list card's tick measured 20 px.
- A board the user arranged says "Arranged by you", and carries no planner's
  reason over it.
- "Show" puts a hidden section back where it was hidden from, not at the
  bottom: the hide_section preference keeps its place.
- A test that words fitting two sections ("Personal" the project and
  "Personal" the list) are a question, not a guess.

Not covered by a test: the 44 px targets and the header wording (no
component tests in this repo; tsc and next build).

---

## v0.28, part 2 — Spend you can see, a net under all of it, and what Kiron feels kept (2026-10-06)

this commit

The second half of the spend review, as sec plan approved it: cut waste,
keep quality where Kiron feels it (voice stays gpt-realtime-2.1 full, chat
stays Fable, the painter and consult_brain unchanged).

- Every paid call is priced. A voice call is priced when it ends, from the
  billed split (text and audio, cached and fresh; lib/pricing.ts
  priceRealtime): 20 of 22 calls in 30 days were stored at $0, and cached
  audio is $0.40/M against $32/M fresh. The call's own transcription is on
  the same row. Read-aloud and ElevenLabs are "speech" (per minute, per
  character) and no longer use up voice-call slots; dictation is priced.
- A net under everything: BACKGROUND_DAILY_CAP_USD ($4) over all work that
  runs with no one asking (understanding, extraction, suggestions, the
  dashboard planner), and SPEND_KILL=true, which lets through only the
  user's own chat, calls, dictation and read-aloud. Each pushes once a day.
- Voice: two minutes with no one speaking ends the call, and a call ends at
  30 minutes, warned at 25; both are said out loud first, never mid-reply
  or mid-tool (lib/realtime/session-limits.ts).
- Chat caches its prompt: the briefing's per-minute clock line is last, and
  Claude gets the stable instructions and the live briefing as two cached
  blocks. Before, the clock at the top made every turn a full cache write.
- Extraction runs on Sonnet at low effort, max_tokens 3,000: production's
  p99 was 1,984 output tokens over 322 calls (it ran on Opus at high, 16,000).
- The dashboard planner is Sonnet and asks once per situation, even across
  restarts (a stamped head; plans compared with sorted keys, since jsonb
  reorders them and every plan compared "changed").
- "Ask me more" reads only projects whose data changed.
- Understanding writes dates, not countdowns; a countdown the model writes
  anyway becomes its date before it is stored (dates.ts).

Not covered by a test: the voice limits' wiring in the browser session class
(the rules are tested; the class needs WebRTC), the Interview tab's wording.

Review fixes (on ee9fd24): the countdown rewrite touches only what goes
stale on screen (the Today line, the ledes, a question's one line), never
the record or a quote, where "arrive in 30 days" is a duration and a quote
must match its source; inbound email counts as background work under the
$4 cap; a Sonnet extraction cut at max_tokens is recorded and priced before
the fallback, and the gpt-5.5 fallback has the same 3,000-token ceiling.

---

## v0.28 — No stupid spending, part 1: background calls that paid for nothing (2026-10-06)

this commit

Kiron: "Spend should be minimal but the program should still be smart. No
stupid spending." An inventory of every paid call (code plus 30 days of
production usage: $159.08, $139.37 of it understanding) found work that paid
twice for the same thing, and spend nobody could see.

- Understanding re-reads a project only when its data changes or one of its
  dated items crosses a line (later → soon → tomorrow → today → past); the
  hash no longer carries the date, so nothing near-dated re-reads every day.
  Defaults: $3 a day, $1.50 a run (were $5 and $2). The model stays Opus. A
  model missing from the rate card is priced at the default model's rate by
  the run's attempt gate, or a $1.50 ceiling would refuse every run of it.
- Extraction: one run per conversation at a time after a 10-second settle,
  with one follow-up for whatever was said meanwhile. It started after every
  voice utterance and chat turn and read the same words two and three times
  in the same minute (production, 10-06 05:30 and 09-24 23:52). Its cost is
  now recorded through recordUsage: 101 of 130 extraction rows in 30 days had
  no price, which every reader counts as $0.
- Suggestions run at most once a day from the attempt, not the last insert:
  the gate never closed on "an empty list is the right answer most days", so
  gpt-5.5 ran after every extraction.
- consult_brain is priced. The slow loop's headless Claude Code no longer
  inherits the API key (it billed the API with no usage row; the shop already
  stripped it). /api/realtime/token-test (no quota, no usage row) is off in
  production.

Not tested: the slow loop's spawn (a script); consult_brain's pricing (it
needs a live Claude client).

---

## v0.27 — Lists, a dashboard you can rearrange by voice, and no "let me" before it's done (2026-10-06)

this commit

Kiron's screenshot from a call: "Please add lotion to my shopping list for
the boat" became a task "buy lotion for the boat" under Personal. "Can you put
the shopping list at the top of the dashboard?" got "Sure, let me move that
so it's easier to reach", then "I can't move the dashboard sections with the
tools I have right now." The voice had no dashboard tool at all, the app had
no lists, and nothing stopped the assistant promising before it checked.

- Lists are projects with `kind` "list" (lib/secretary/lists.ts). add_to_list
  puts nouns on a named list, Shopping by default, with what they are for as
  the item's note ("Lotion", "for the boat"); list_items reads one back. A
  list phrase ("my shopping list for the boat") resolves to the list in
  resolveProject too, so no tool makes a Boat project out of it. Lists are not
  work: understanding never reads one (no paid run per item), procrastination
  scores its items 0, and the dashboard keeps its items off every other view
  and shows the list as one tickable checklist card.
- arrange_dashboard (lib/layout/arrange.ts), on the call and in chat: "put the
  shopping list at the top", "move Caltrans down", "hide the timeline", "show
  it again". Words map to sections with no model call; the edit is
  user-initiated, saved as the head and pinned, and "hide" is a hide_section
  preference, so no planner brings the section back. The validator's pin rule
  (invariant 7) no longer refuses the user's own move. The briefing names the
  board's sections top to bottom, and the lists with their items.
- Never announce before it's done (shared persona): no "let me move that" or
  "I'll add it"; make the call and say its result, or say up front, once, that
  it can't be done. The slow-lookup filler is "one sec" and names no action.
  The voice rules say documents and project surgery are chat-only, and a test
  fails if the persona ever names a tool the call lacks without that.
- Review follow-up from v0.26: a test that a rolled-forward start takes its
  end with it.

Not covered by a test: the dashboard UI (the list card, and keeping list items
out of the other views) has no component test in this repo; checked by tsc
and next build only.

---

## v0.26 — Events by voice, and onto Google Calendar (2026-10-06)

this commit

Kiron: "I just wanted to add something real quick for Daily Reminder, but I
couldn't do it." Siri and Gemini had both failed him. The audit: the app had
never had Google Calendar access (Google was sign-in only, with profile and
email scopes and no refresh token), and the voice session could not make an
event at all. create_event was not among its tools; a spoken event reached
the app only through the extractor, as an inferred row.

- Voice carries create_event, update_event, delete_event and the new
  add_event_to_google (adaptive-ui SPEC §11). The model says back
  `read_back` from the result: what was made, when, how it repeats, and
  whether it reached Google. "Undo that" deletes by the id it returned.
- create_event takes an RRULE (lib/secretary/rrule.ts checks it and says it
  in words); events keep `recurrence` and `time_zone`.
- Google Calendar, one way (lib/google): Settings → Connect Google Calendar is
  its own consent round trip for `calendar.events.owned`, offline, apart from
  sign-in. Tokens live in `google_connection`, AES-GCM encrypted, never in a
  log, a result or a payload. Create, update and delete reach the primary
  calendar by the stored Google event id, as wall-clock time plus the IANA
  zone, so 8:00 stays 8:00 across Nov 1. A refusal is said, not swallowed. A
  dead grant (revoked, or the 7-day expiry of a Testing app) says "Google
  Calendar is disconnected. Reconnect it in Settings.", pushes once that
  day, and Settings offers Reconnect.
- Only the user's own plain words write Google: `liveTurnContext` sets
  `calendarSync` "now" for a voice turn or a chat turn with nothing
  attached, and "ask" when a flyer or file came with it. Then the event
  stays in the app (`google_sync` pending) and the reply asks; only a later
  plain turn can add it. Understanding answers, scripts and the extractor
  never write Google.
- Times without an offset were read in the server's zone, UTC on Heroku, by
  both the tools and the extractor: "8 am" was stored as 1 am Pacific.
  lib/time.ts parseInTz reads them in the user's zone; the extractor now
  dedupes against the event voice just made.
- Reminder results told the model "logged-only", long after lib/push.ts began
  ringing the phone at each one; they now say so.

- A repeating event starts at its next occurrence (rrule.ts
  firstOccurrence): "a daily reminder at 8" said at 9 starts tomorrow at 8,
  in the user's zone and across a DST change; a weekday rule starts on a
  weekday; a monthly or yearly start in the past is refused with the reason.
  The end and the reminders move with the start. A one-off in the past is
  kept, but the read-back says the time has passed. (Review finding R1.)

Known limits: the app's own agenda and month view show only the first
occurrence of a recurring event; edits made in Google do not come back. The
attachment gate is per turn: a flyer's text stays in the conversation, so a
later plain turn could still act on it (read-back and the persona mitigate
it; SEC-A005 gates on untrusted content anywhere in the conversation).
Disconnect revokes the refresh token, and Google sign-in shares the OAuth
client, so the next Google sign-in may ask for consent again. The first
occurrence of a repeating event gets both the app's push and Google's popup.
Whether `calendar.events.owned` covers the primary calendar is proven only by
the live test; the fallback is `calendar.events`. 871 vitest with the keys
blanked and TZ=UTC: 870 pass, and understanding-own-words (7) fails as it does
at v0.24 with blank keys. 24 new tests; 17 reverted guards each fail at least
one of them.

---

## v0.25 — The spend cap holds, and a failed read is paid for once (2026-10-04)

this commit

Kiron's Claude console showed $38 on Oct 1, $12 on Oct 2 and 3, and $6 by
the morning of Oct 4, with the app barely used: "I am not made of money."
Production's `usage` table (its own figures; about $28 for Oct 1 Pacific
time): all of it `understanding` on claude-opus-5. From 09-30 17:08 to
10-04 09:29 PDT, Caltrans was $63.12 of $67.75 (93%): 21 runs at about $3,
all failed, none stored, and every paid run from 10-01 15:47 PDT on. The
other $4.63 was nine ok runs of six other projects. Paused first with
`UNDERSTANDING_DISABLED=true` (Heroku v51, 2026-10-04 11:34 PDT); zero
spend after it.

- The $5 daily cap never ran: runOnce asked it only when no model was
  passed in ("a test's injected model is exempt"), and runAll hands every
  run its model. Production had no `budget` skip, ever. Every run now asks,
  counting itself at `UNDERSTANDING_RUN_CAP_USD` (default $2, never more
  than the daily cap) and runs in flight at theirs; the hold is taken
  before the spend is read. "Over" means past the cap, so $3 spent leaves
  room for one more $2 run under $5. "Understand now", "ask me more" and an
  answer's re-read are capped too; chat, calls and answering are not.
  Either cap at 0 turns runs off. A refused run logs one row per project
  and inputs, not one per sweep; a run that only waits for another in
  flight sends no "paused" push. The spend pushes were keyed by day alone
  in a table whose key is unique across users; they now carry the user.
- A failed run backed off six hours, and not at all after a restart (the
  dyno cycles daily): Caltrans paid $3 on the same inputs every ~6.5 hours.
  Now any failed run on the same inputs that the model answered, or that
  was billed, keeps the sweep off them until they change.
- One run: 3 attempts × 32k output tokens at Opus effort high, each cut at
  max_tokens or refused. The model was told to copy back the record's
  `asked` list, which the store then replaces: 25,073 of Caltrans's 50,113
  record characters, and one stored answer of 1,015 characters failed the
  validator (`record.asked.51.answer`) on every faithful copy. The prompt
  and schema no longer ask for it and the run drops any copy before
  validation. A run stops before any attempt whose worst case could take
  it past its ceiling: a Caltrans-sized prompt now gets one attempt. The
  OpenAI call got the same `max_output_tokens`.

Not changed (Kiron's call): Opus at effort high for background reads, and
MAX_TOKENS. 847 vitest with the API keys blanked: 846 pass, and
understanding-own-words (7) fails the same way at v0.24 with blank keys
(it reads key presence) and passes 24/24 with .env.local. 12 new tests in
tests/understanding-spend.test.ts; each of 13 reverted fixes fails at
least one of them.

---

## v0.24 — A spend fail-safe, and alerts (2026-09-25)

this commit

About $40 went overnight with no one using the app. Heroku's log: the Claude
API key hit its monthly spend limit at 08:21 UTC; the understanding run
fell back to OpenAI gpt-5.5 at high effort for the next hour, and Caltrans
failed validation on all three attempts twice (memory ids the model cut
short or mis-dashed; a suggested task with no drop answer) — each attempt a
full, expensive call. OpenAI then ran out of credit too. Earlier the same
UTC day, a ~34-minute voice interview and twelve answers, each re-reading
the project on Opus. Kiron: "If an app spends so much we need a fail safe.
And a way to notify me."

- lib/spend-guard.ts: a 24-hour cap on understanding spend
  (UNDERSTANDING_DAILY_CAP_USD, default $5) checked before every run (skip
  reason `budget`); an alert line on total spend (SPEND_ALERT_USD, default
  $8) checked after every priced call; "<provider> is out of credit" when a
  run or dictation is refused for money. Each is one push a day (push_log).
- Runs no longer fall back to OpenAI mid-flight; they wait for Claude.
- An answer's re-read waits for 90 quiet seconds: an interview sitting is
  one read.
- repair.ts mends a cut-short or mis-dashed id by its first 16 hex digits.

Pushes need Settings → Notifications enabled on the device. 835/835 vitest
(4 new guard tests, 2 new repair tests).

---

## v0.23 — No more "A voice session is already running" (2026-09-25)

this commit

Kiron hit it again on the iPhone. Heroku's router log: a token at 15:48:25
(200), then two more 3.4s apart (429). The first call's setup failed after
the server had opened its session (the OpenAI account was out of credits
again, so the SDP exchange was refused); nothing closed that session, so
each "Try again" was refused as a second concurrent call for five minutes.

- connect(): everything after the token is openPeer(), and a fresh call
  whose setup throws closes its session (`/api/realtime/end`, one second)
  before the error shows. A reconnect keeps its session for the next try.
- checkVoiceQuota: a NEW call replaces an open session older than 20s
  instead of refusing for 5 minutes — one person talks on one device, so a
  row that old is a call that died without reporting. Two starts within 20s
  are still refused.

Checked in the browser with the OpenAI call endpoint blocked: the failed
setup posts /end, and Try again gets a token (200) instead of a 429. 829/829.

---

## v0.22 — The launcher morphs into the pill, and back (2026-09-25)

this commit

Kiron: "the little chat icon on the bottom right basically just morphs into
the UI… the icon fades as it grows out… and when you exit, it morphs back
into that little circle." A proxy shape (docked-chat.tsx, the shared-element
move) animates left/top/width/height/radius from the launcher's measured
rect to the pill's, same black and glow, the icon fading on the way out;
the real card waits invisible underneath, is shown the moment the shape
lands, and the shape fades off it so the contents come up out of the same
black (an earlier cut hid the shape first and the pill blinked pale). Every
close — the pill's x, the card's x — goes through the dock and runs it
backwards into the circle, which then swaps in place. The launcher is now
out of the flow (absolute over the tab bar) so it can always be measured.
The card's old slide-up entrance is gone. Done on transitionend, with a
timer behind it; reduced motion skips it.

Checked: frames captured with CDP Animation.setPlaybackRate 0.12 on the way
in and out; three open/close cycles and an open-then-close-mid-morph at
normal speed end clean (launcher back, no shape left). 829/829 vitest.

---

## v0.21 — CPO packets: documents per step, and Compile PDF (2026-09-25)

this commit

Kiron, after an interview that did not get it: "for each CPO… upload the
documents… STD 65, the seller's permit, ADM 2029 for reconciliation… this
is what I'm missing for each step… compile it in here instead of doing it in
Adobe." SPEC (understanding §6, documents per step) first.

- A process step can name the documents it needs (`steps[i].docs`), set by
  voice or chat: `set_step_documents { process, step, documents[] }`.
  Re-saving a process keeps each step's documents by step name.
- `task_documents` files an attachment against a task under a document name
  (the bytes stay in `attachments`). Names match loosely ("std-65" is "STD
  65"). `file_document` (chat) files the file the user just sent;
  `packet_status` (voice and chat) says what is there and missing.
- The task's detail has a Documents section: per step, each required
  document ✓ or missing with Upload/Add, other files, "Add file" under any
  name, and **Compile PDF** — `GET /api/tasks/:id/packet/pdf`: a cover
  checklist, then every PDF's pages and each image as a page, in process
  order; anything else is named on the cover as not included. Served with
  the attachments' `default-src 'none'` lock, since it is built from uploads.
- The Memory tab shows each step's documents.
- pdf-lib 1.17.1 added (pure JS PDF merge).

Checked: 5 new tests (loose names, missing list, filing, a 3-page compile,
docs kept on re-save); the voice-schema test caught an unbounded `step`
(now max 40). Driven locally: seeded CPO task, upload through the UI, the
detail reads 3/5 with ADM 2029 and the US Bank statement missing, compiled
PDF has 4 pages with the checklist cover. 829/829 vitest, `next build`.

---

## v0.20 — Swipe up on the call pill; no expand, no Minimize (2026-09-25)

this commit

On the iPad a swipe up on the pill during a call did nothing. The call's row
is portaled into the pill (v0.19), and React events from a portal bubble
through the portal's own component tree — the call — never reaching the
chat card's handlers; the pill's touch-none meant the browser did not
scroll either, so nothing moved at all. The pill's swipe now listens with
native pointer listeners, which bubble through the DOM the row actually sits
in. Reproduced first with CDP touch events on a live call (swipe on the call
row stayed "bar"), then fixed: swipe up → full, grabber down → bar, a flick
up on the row → full.

Kiron: "the full screen button and the minimize should not exist… to make it
full screen you just swipe up on the bar itself, and the bar stays all the
way." The call row has no expand button, and with a dock on the page the
call always lives in the card — the separate full-screen call (and its
Minimize) is only the no-dock fallback. The voice / thinking / model menu
lived on that full-screen view; those choices remain in Settings.

Regression run of the non-call gestures (fresh pill → keyboard; send → full;
drag down → pill; swipe up → full; grabber up → full) all pass. 824/824.

---

## v0.19 — A call and a chat are one widget (2026-09-25)

this commit

Kiron: "When voice turns on it's this old ugly interface… merge the two. The
bar to raise and lower is the same; only inside the widget do changes
happen." The minimized call no longer draws its own white pill. The chat
card registers a slot where its composer was (call-slot.ts) and the call
portals its row into it — status, full screen, the live mic, end — so the
dark pill, its grabber, the drag and the conversation above are the same
ones, with the live transcript in the thread. The dock no longer slides away
during a call; Closed reads as the pill until the call ends. No dock on the
page: the old floating pill is the fallback. The interview orb, which draws
its own call, is untouched (`hosted`).

**Found on the way, and fixed:** End pressed while a call was still
connecting left the connect running in the background: the server's
session row never closed, so the next call was refused ("A voice session is
already running") for five minutes. connect() now checks after each await
and closes what it opened (abandonConnect). And a call ended before it
connected was billed from the epoch (startedAt 0) — now one second.

Checked with a real call (fake mic) at 820×1180: the row appears in the pill
("Listening…"), a swipe up opens the card with it at the bottom, End brings
the composer back in ~370ms; End during "Connecting…" leaves a second call
free to start. 824/824 vitest. SPEC §7.7 updated.

---

## v0.18 — A mic button that shows whether the call can hear you (2026-09-24)

this commit

One `LiveMicButton` for every place the call shows mute (the full-screen
call and its minimized pill). Live: accent blue, full size, and it jumps
with your voice — a lift and a scale driven by the MIC level from WebRTC
stats every 70ms (never a Web Audio analyser on the mic; iOS can silence the
sender). Muted: grey, a step smaller, a slashed mic, and still. So if it
moves when you talk, the call hears you. Reduced motion keeps the signal as
a halo that brightens with the voice. The caption says the state ("Live" /
"Muted"); the old icon showed a slashed mic while live, which read backwards.

824/824 vitest; looked at live and muted states on a throwaway preview.

---

## v0.17 — Swiping up on the pill works on a real touch screen (2026-09-24)

this commit

Kiron on the iPad: dragging the open chat down worked, but a swipe up on the
pill did nothing — neither the keyboard with nothing started, nor the
conversation after one was swiped down. iOS read the vertical swipe as a page
scroll and cancelled the pointer. The pill is now `touch-none`, and so is its
field (a textarea is its own scroll container, so an ancestor's touch-action
does not reach through it — a swipe starting on the field was still a
cancelled scroll). A swipe up on the pill grows it back into the
conversation, following the finger, when there is one; with none yet it
raises the keyboard. The grabber's hit area is taller.

Checked with real touch events (CDP) at 820×1180: fresh pill swipe-up
focuses the field; send → full; drag down → pill; pill swipe-up → full;
grabber swipe-up → full. 824/824 vitest.

---

## v0.16 — The secretary can search the web (2026-09-24)

this commit

On a call Kiron asked for "a general Google search of what the dental
provider is for California state workers" and the voice said it could not
search the web. It could not: no tool did. `search_web` (query, optional
context) is now one of Secretary's tools, on the call and in chat alike —
one tool system, not a voice-only feature. It asks gpt-5.4-mini
(`SEARCH_MODEL`) with OpenAI's hosted `web_search` for a spoken-length
answer, strips the inline citation links, and returns the cited pages as
`sources`. Measured about four seconds. The persona says the web is its to
search; the tool description tells the voice to say "one sec, looking that
up" first and name the site the answer came from. Usage is recorded as
`other` (the per-search fee is not priced).

Checked live: the CalHR dental question came back with the plan lineup and
benefits.calhr.ca.gov as the source. 824/824 vitest.

---

## v0.15 — The chat dock, after Gemini in Chrome (2026-09-24)

this commit

From Kiron's screen recording of Gemini in Chrome on the iPad. SPEC §7.7
rewritten first.

**Three states.** Closed is one round launcher at the bottom right, above a
tab bar that now always stays put. Tap it and a floating pill rises: +
(Photos · Camera · Files · Model, the existing Attach sheet), the field,
dictation, the voice call, x. A send, or a drag up on the grabber, grows the
pill into the conversation card over a dimmed page. The card's height
follows the finger (pointer capture on the grabber and header); the
conversation fades as it shrinks and has faded out by halfway; on release it
snaps to the nearer end, and a flick decides by direction. 340ms on the
app's leading curve; reduced motion cuts. Peek is gone.

**One look.** The pill, the card, the launcher and the call are the same
surface: black, `data-theme="dark"`, the accent's inset glow (call-look.ts).
Nothing in the chat keeps the old flat composer.

**Copy and speak on every reply** (message-actions.tsx), typed or spoken,
including the call's latest reply. Speak is `POST /api/speak`:
gpt-4o-mini-tts in the user's realtime voice (marin by default), one reply at
a time, tap again to stop; the tap unlocks the audio element with silence so
iOS will play what arrives after the fetch.

**The voice call.** "Show me" (the transcript toggle) is removed; the
minimize control is a labelled "Minimize" button instead of a bare caret.

Checks: tsc, eslint, 824/824 vitest, `next build`; the dock driven signed in
on the local server at iPad (1180×820) and phone (393×852) sizes — closed,
pill, send → full, mid-drag fade, release → pill; /api/speak returns mp3.

---

## v0.14 — Check-ins, and the Shop out of sight (2026-09-24)

this commit

**Check-ins.** "Weekly status reports are due every Thursday — if I talk to
you on a Thursday, ask me if I sent it. Not a task, not a reminder." New
`standing_checkins` table (question, weekdays in the user's timezone, the
local date last asked) and three tools on chat and voice: `set_checkin`
(same question replaces its days), `remove_checkin`, `checkin_asked`. The
briefing carries CHECK-INS TODAY until the model marks one asked, plus the
standing list; the persona routes "remind me verbally / ask me on X" there
instead of a task. The Memory tab lists them, each deletable.

**The Shop is parked, not deleted.** It had become the answer to anything
Secretary could not do, and its requests were not getting built. Unless
`SHOP_VISIBLE=true` (lib/shop/visible.ts): the model is not handed
`request_capability` / `review_capability`, the persona drops the shop and
says instead to reach for the closest tool it has (a fact, a check-in, a
note) and otherwise say so plainly, the briefing leaves out plans and
outcomes (ABILITIES ALREADY BUILT stays), and Settings hides the section.
Tables, worker and tools remain.

Data: the CPO purchase cycle was saved and "Do the US Bank statement" put on
step 7 through Secretary's own chat (the tools from v0.13), not a script.

Checks: tsc, eslint, 824/824 vitest, `next build`.

---

## v0.13 — Talk to the Interview, and it remembers how your work goes (2026-09-23)

this commit

**Dictation.** "Transcription failed" was the OpenAI account out of credits
(Heroku log: `429 You have no credits remaining`); the route now says so
instead. The dictation bar was redesigned after ChatGPT/Claude: X on the
left, a waveform that scrolls in from the right, Stop (transcribe into the
box) and Send (transcribe and send) together on the right. It also stopped
restarting the recording on every parent re-render. `DictationField` puts the
same bar behind a mic in every answer box (Interview note, opened question,
Write your own), and those boxes grow with the text.

**Corrections are instructions.** "Do the US Bank statement makes no sense"
was filed as a fact and the task stayed. The interpreter now drops or renames
a row the user says is wrong (`rename_task`), and a rename and a step may sit
beside another write on the same row.

**Processes.** The CPO purchase cycle was stored as one flat sentence. A
recurring job described step by step is now a `process` on the interpreter's
output, saved as a `pipeline_templates` row (`save_process`, each step
blocked by the one before). `set_step` puts a task on a step (the steps
become its stages, earlier ones done). Every run and the chat/voice briefing
see PROCESSES; the run may ask "Which step is CPO 2110 on?". Adding processes
to the bundle hash re-reads every project once after deploy.

**Memory tab.** Processes with numbered steps and every memory, newest
first, each deletable in place. Six tabs now share the bar's width.

**Interview orb.** A tap starts the existing call in an `interview` flavor:
the open queue in the tab's order, one question at a time through
`answer_question`, which on that call also returns `next_question`. The orb
breathes with the audio and shows "Thinking…" while a tool runs. Not yet
tried on a live call; a spoken "skip" does not move the card yet.

SPEC: docs/understanding/SPEC.md §5 (three ops), §6 (corrections, processes,
interview call), §9 (orb, Memory). Checks: tsc, eslint, 817/817 vitest,
`next build`.

---

## v0.12 — The agent guide (2026-09-16)

this commit

Documentation only. `docs/secretary-agent-guide.md` is the first canonical
guide to what Secretary is meant to be and what the repository actually
holds: mission and JARVIS-as-the-bar, the persona as the code enforces it,
where live data lives and how it is read, a Project Intelligence contract
(durable per-project record with attempts and a resume pointer — designed
here, not yet in the schema, with an interim `memories` tagging convention),
answer patterns for the four core questions, Canvas rules against the
unfixed defect list, approval and truthfulness policy, delegation, runtime
boundaries, and a draft OpenClaw configuration that names the agent
Secretary and is explicitly not created. Every state claim carries evidence
from four read-only surveys of the tree at `70df98d`; all 29 cited commits
and all cited paths were checked to exist. Also recorded: v13 (2026-09-16)
set the eleven config vars including `ADAPTIVE_V2` and `SHOP_DISABLED`, so
the adaptive dashboard is live on Heroku for the first time.

---

## v0.11 — One deployer, CI that runs, a release phase that applies (2026-09-15)

`5d0549c` (committed as "test line", pushed 15:18) and this commit

**The dashboard GitHub integration is the deployer; the workflow is its CI.**
The link had been re-pointed from `personal-assistant` to `secretary` at 10:03
(the OAuth popup loops in Firefox *and* Safari, but the backend link is created
anyway — the page just never shows it). It was removed at 13:45 via
`DELETE kolkrabbi.heroku.com/apps/<id>/github`, then Kiron re-created it at
15:20 with automatic deploys on. Fine — but only one thing may deploy, so the
workflow's deploy job stays gated off (`DEPLOY_ENABLED` unset, no
`HEROKU_API_KEY`), and "Wait for GitHub checks" has to be ticked or the
dashboard deploys unverified pushes. README, CLAUDE.md and the handoff say so.

**CI had never gone green.** All four runs of `deploy.yml` failed at `Tests`:

- `BETTER_AUTH_SECRET` was unset, so `lib/crypto.ts` threw in the three
  connected-account encryption tests.
- No VAPID pair, so `scanDueReminders` returned 0 before touching the
  database and the just-due reminder test claimed nothing. `web-push` validates
  key format, so a placeholder string is not enough; the workflow now generates
  a throwaway pair per run and exports it through `$GITHUB_ENV`.

Both reproduced locally by running the two files with `.env.local` masked and
only CI's values present, and both pass with the fix. Run 35030287366 on
`5d0549c` is the first green run — and the first time `next build` ran in CI.

**Heroku auto-deployed that commit (v9, 15:28) and the release phase did
nothing.** The dyno is up and `/` answers, but every sign-in 500s:
`column "calm_mode" does not exist`. `heroku releases:output v9` shows why:
`drizzle-kit push` introspected the two views Heroku's `pg_stat_statements`
extension keeps in `public`, found them absent from the schema, emitted
`DROP VIEW`, and Postgres refused (`extension pg_stat_statements requires it`).
drizzle-kit exited 0 anyway, so Heroku called the release good. The database
stayed at 16 tables. Fix: `tablesFilter: ["!pg_stat_statements",
"!pg_stat_statements_info"]` in `drizzle.config.ts` — drizzle-kit 0.31 applies
that filter to views as well as tables (`bin.cjs:18114`).

Verified three ways on a scratch database, never against production:

- Two dummy views with those names: the old config drops them, the new one
  leaves them and creates all 29 tables; a second run reports no changes.
- **The release-phase plan, dry-run against Heroku's exact schema** (the
  Aug 12 deploy `b741ed18`: 16 tables, no `calm_mode`) plus the two views:
  13 `CREATE TABLE`, 18 `ADD COLUMN`, 2 indexes, 16 foreign keys, and **no
  DROP, no type change, no NOT NULL without a DEFAULT**. It is additive; it
  will apply to populated tables. That is handoff step 4, done offline.

**The cutover itself.** `cf23263` pushed 15:59, CI green 16:02, v10 live and
`Changes applied` by 16:04 — Heroku at 29 tables. Backup `b037` at 16:05. Then
the new `scripts/copy-db.ts` — every public table from `information_schema`,
insertion order from the target's own `pg_constraint`, self-references in
waves, every value read as text and written back with an explicit cast, one
transaction with counts verified before COMMIT, and a refusal if the two
schemas differ — copied **1,993 rows across 29 tables** into Heroku at 16:07.
Rehearsed first local → scratch: counts matched, a column-order-independent
content hash (`row_to_json → jsonb`) matched on all 29 tables, the abort path
left a target untouched when a table was missing, and a second run was
idempotent. `sync-to-heroku.mjs` is deleted. Config vars are still Kiron's
one-liner (the classifier refuses secret writes); until then the brain falls
back to OpenAI and the dashboard is v0, but the app is up with all the data.

One consequence to know about: the 02:00 launchd job
`com.kironkp.secretary-nightly-push` runs `git push origin main`, and `main`
now auto-deploys. A commit left on local `main` ships overnight.

**Data, for the record.** The nightly local → Heroku sync last succeeded on
2026-08-18 and has failed 28 nights running since 2026-08-19 (`column
"calm_mode" of relation "user" does not exist` — local grew a column Heroku
never got, because nothing was deployed after 2026-08-12). So Heroku holds
local's data as of August 18 for 16 of 29 tables; local has 102 tasks, newest
2026-09-10, across 29 tables. Steps 2–5 of the handoff — backup, the sixteen
config vars, reading the `drizzle-kit push` plan, the one-time migration —
still come before the first automatic deploy is allowed to land.

---

## v0.10 — The flaw audit (2026-09-15)

`57ac051` and this commit

No behaviour changed. A three-agent adversarial audit read the canvas renderer,
the cost architecture and the verification/ops surface, and every claim below
was then confirmed by hand against source or a live command.

**It found the canvas bugs that four rounds of fixes missed**, because all four
targeted the wiring and the real defects are in layout and touch:

- **No `<meta name="viewport">` in the canvas srcdoc** (`sanitize.ts:213-216`).
  iOS therefore applies its legacy ~350 ms tap delay and double-tap-to-zoom.
  Invisible in jsdom and in desktop Chrome — which is why it survived four
  attempts. This is the best single explanation for "I still can't check things
  off" on the phone.
- **The checkbox is 18×18 px** (`sanitize.ts:241`) — under half the 44 pt
  minimum — sitting on a row that carries `data-link`, so a near-miss doesn't
  do nothing, it **navigates away from the canvas**.
- **Voice reorder reloads the board.** `canvas-view.tsx:10-13` documents "DOM
  ORDER NEVER CHANGES"; line 529 maps `blocks` in composition order, so a move
  reconciles keyed holders with `insertBefore` and every iframe below the moved
  one re-navigates. The flagship no-model-call operation blanks the board.
- **Every block is clipped by 24 px.** The iframe carries Tailwind `p-3`
  (`:556`) while `measure()` writes content height into `style.height` (`:196`),
  so the viewport is permanently 24 px shorter than its content — and short
  blocks staircase-shrink 24 px per 500 ms tick.
- **Direct manipulation does not exist**: zero `pointerdown`/`touchstart`
  handlers anywhere in `components/canvas` or `lib/canvas`.

**It found that the cost number being steered by is wrong.** 53 of 58 voice
rows are flagged `cost_estimated` and priced as 100 % audio at $32/M when most
of those tokens are cached text at $0.40/M; five more are NULL and read as
$0.00. Anthropic caching is real but capped at 59.8 % because
`briefing.ts:286-294` bakes the current **minute** into the top of the system
block, invalidating that breakpoint every 60 seconds.

**It found production down.** Heroku release v8 deployed commit `9701f7d9` —
not an object in this repository — from the dashboard integration still pointed
at `kironkp/personal-assistant`. `web.1: crashed`, `npm error Missing script:
"start"`, the URL returning **503**, unnoticed for 25 minutes.

**And it found why all of this reaches the user instead of CI:** 47 test files,
exactly one opts into jsdom, `vitest.config.ts` does not even match `.tsx`, no
React component is ever rendered by a test, 3 of 29 API routes are covered,
`canvas-invariants.test.ts` asserts by grepping source strings, and the only
end-to-end harness has been switched off since 11 August (`sim/.disabled`).

Full detail, with fixes, in `docs/HANDOFF.md`.

---

## v0.9 — Deployment moves to CI (2026-09-15)

`a7bbd04`

**Heroku becomes the source of truth; the Mac becomes beta.** This reverses the
architecture the README had described since August.

- `.github/workflows/deploy.yml` — CI on every push and pull request (Postgres
  service, schema push, tsc, lint, 439 tests, production `next build`), then a
  deploy job gated three ways: push only, `main` only, and the repo variable
  `DEPLOY_ENABLED == "true"`. It finishes by asking Heroku what the dyno is
  actually doing, because a green deploy step only means the slug built.
- CI sets a placeholder `OPENAI_API_KEY`. The tests never call a provider, but
  `lib/openai.ts` builds its client at module load and the SDK throws on a
  missing key — without it nothing imports.

**Found and defused:**

- A launchd job (`com.secretary.dailysync`, 03:00 daily) that **overwrote the
  Heroku database with local data**. Harmless when local was truth; catastrophic
  the moment Heroku is. Unloaded, plist renamed `.disabled`.
- Heroku's dashboard GitHub integration was connected to
  **`kironkp/personal-assistant`** — an unrelated repo last touched in January,
  with no `start` script. Its single auto-deploy (v8) crash-looped on
  `npm error Missing script: "start"`. This repo's remote is `kironkp/secretary`.

**Still outstanding:** 16 config vars missing on Heroku, its database holds
August data (25 tasks vs 102 local), and two schema migrations ride the first
real deploy. See `docs/HANDOFF.md`.

---

## v0.8 — Canvas checkboxes, four attempts (2026-09-09)

`85e56f5`, `817f4f4`, `ced18a3`

The worst sequence of the session, and worth reading as a cautionary tale. The
user reported checkboxes unusable; it took three separate root causes and the
result was **still not confirmed working**.

1. **`85e56f5` — the momentum guard ate every click.** The canvas re-measures
   blocks after load; each measurement changes the board height, which changes
   document height, which fires page `scroll` events. The scroll-stop guard
   listens in the capture phase, so it reported "momentum in flight" almost
   continuously and swallowed clicks before the checkbox was hit-tested. The
   guard was added in the *same change* as the checkbox — self-defeating.
2. **`817f4f4` — the wiring loop cancelled itself.** The interval that attaches
   click handling lived in an effect keyed on `wireAll`, whose identity changes
   every `measure → layout → setBoardH` render. It was torn down and rebuilt
   before its 300 ms tick could fire, leaving `onLoad` as the only attempt —
   and when that fires against the initial `about:blank` document, nothing is
   ever wired to the document the user sees.
3. **`ced18a3` — no un-check path.** A ticked box was inert; an accidental tap
   was permanent. Now toggles both ways, optimistic in both directions.

**Also:** `lib/canvas/interaction.ts` extracted so the click path is testable at
all (jsdom), `scripts/canvas-reset.ts` to rebuild a canvas from live task data
with no model call, and `docsWired` / `checksFired` counters behind `?perf=1` so
the next failure is diagnosable from the device instead of by inference.

**The lesson, recorded because it recurred:** 439 passing tests, clean tsc, lint
and build said nothing about whether a human could tick a box. See
`docs/HANDOFF.md` §"Why bugs keep reaching you".

---

## v0.7 — Cost becomes first-class (2026-09-09)

`fbf3a5c`, `72f04b7`, `f35bc6b`

**The measurement.** $75.19 over six weeks — voice $47.06, chat $21.35,
extraction $6.31. Three of the most expensive paths recorded *nothing*: canvas
paints, the dashboard planner (silently since 2026-08-18, the day ADAPTIVE_V2
shipped), and email attachment reading.

- `lib/pricing.ts` — dated rate cards, per-token / per-minute / per-character as
  part of the type, and an unknown model priced at the ceiling rather than $0.00
  (silent zero is how spend goes missing).
- `lib/usage.ts` — one recorder, so a new call site has one obvious thing to call.
- Cost computed at insert and stored, so a rate change never rewrites history.
- `scripts/backfill-usage-cost.ts` priced 396 existing rows.
- Spend panel in Settings with 1/7/30-day toggles and swipe between specific
  days, weeks and months, in **local calendar** windows (DST-correct).

**`72f04b7` — the actual leak.** One chat turn runs up to 8 tool rounds, each
re-sending an identical 24,387-token prefix (tool schemas ~9.5k, briefing ~3.5k,
persona ~2.6k). History was NOT the problem — the largest thread is ~970 tokens.
Anthropic prompt caching added and **verified against the live API**: round 1
writes 24,387, rounds 2+ read all 24,387. A 3-round turn goes ~$0.73 → ~$0.35.

**Untouched:** the OpenAI path has no caching, tool schemas are still sent in
full, the briefing still dumps every open task, and deterministic CRUD still
runs the tool loop.

---

## v0.6 — The Canvas becomes a workspace (2026-09-09)

`203b5c0`, `8f9f1c8`, `ac1c559`

The architectural change the user asked for: *"stop thinking of Canvas as a
picture, start thinking of it as a board."*

- **`203b5c0`** — `lib/canvas/blocks.ts`: segment sanitized markup into
  addressable blocks, verify (one balanced root, by tag-name stack — counting
  depth alone waves through mis-nested fragments that re-parent their siblings
  when spliced), compose, replace-by-id, move. Painter prompt now emits separate
  top-level blocks with stable kebab-case ids. Before this, **all 10 live
  canvases were one wrapper `<div>` with zero ids** — nothing was addressable.
- **`8f9f1c8`** — composition stored as jsonb: blocks + geometry + theme. The
  shell owns order, span, visibility and type scale; the model owns each block's
  fill. `arrange_canvas` voice tool (move/resize/hide/show/remove/set_theme) is
  pure data — **no model call, no repaint**. One sandboxed document per block,
  positioned by transform so DOM order never changes and nothing remounts.
- **`ac1c559`** — shared world model (`lib/canvas/focus.ts`): one interaction
  state both voice and touch write, so tapping a card is what "make this bigger"
  means a second later. Deterministic reference resolution for "that", "the
  other one", "the top one", "the Caltrans one". Geometry undo/redo. `?perf=1`
  instrumentation.

---

## v0.5 — Canvas edits stop destroying the canvas (2026-09-09)

`cad3365`

`edit_canvas` existed but was **missing from `VOICE_TOOL_NAMES`**, while
`persona.ts` explicitly instructed the model to call it. So every spoken change
fell through to `paint_canvas`, which receives no copy of the current canvas and
therefore painted a *different* one. Exactly the user's complaint: "I ask to add
one thing and it restarts from scratch."

Also: a canvas operation no longer blanks the canvas (new snapshot seeded with
what is on screen; an edit holds it until the replacement completes; only a
completed stream may be committed), and the shell refreshes immediately instead
of waiting out a 15-second poll.

**Attachments** in the same commit: any file type uploads and pastes. Serving
became the security boundary rather than the upload allowlist — only raster
images and PDF are served renderable, everything else is octet-stream +
attachment with a strict CSP. Extracted file text is fenced as untrusted data
(and a real prompt-injection hole in the email fence was closed: a body
containing the terminator could close its own fence).

---

## v0.4 — Fixes found by adversarial review (2026-09-09)

`bc1c079`, `9490d6b`, `1544c3e`, `a4892ac`, `5290799`

- **`bc1c079`** — hydration mismatch on *every* dashboard load: the five-week
  timeline positioned markers as a fraction of a 35-day horizon from
  `Date.now()`, so server and client differed by microscopic amounts
  (`40.474362%` vs `40.4743322420635%`). Clock quantized to the day.
- **`9490d6b`** — build broke because a client component imported a value from a
  module that imports the database (`pg` → `node:dns`). tsc, lint and 411 tests
  all passed; only `next build` sees it.
- **`1544c3e`** — voice calls dead because the transcription lexicon grew past
  the API's hard 1,024-character limit (it had reached 1,197). **Not a code
  change — the entity store simply grew.**
- **`a4892ac`** — the Shop filed the same ability four times under four
  phrasings, twice after it had shipped, because dedupe compared exact strings
  and the briefing only surfaced shipped work from the last 36 hours. Now fuzzy
  dedupe plus a durable "abilities already built" list.
- **`5290799`** — chat dock: caret moved right, peek reduced to the single
  latest message.

---

## v0.3 — Voice register (2026-09-08)

`4ab535a`, `ed4afcc`

Shop-built: the assistant explains *why* something is blocked instead of reading
a status word, and speaks like a person on a call.

---

## Earlier

Before this logbook, see `git log` and `docs/adaptive-ui/SPEC.md`. The adaptive
dashboard (LayoutPlan) track completed 2026-08-19.
