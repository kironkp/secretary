# Claude Code prompt — secretary behavior fixes: project mix-ups, fake "all set", live dashboard updates

Copy everything below the line into Claude Code, run from the repo root.

---

Three real bugs surfaced in live use. I told the secretary (by voice) that it had filed "Test Find It on iPad" into a brand-new project called "Find It" instead of my existing **"Find It app"** project. It replied "Got it… I'll adjust the task placement" and then "All set. I noted that…" — **but nothing changed**. The task is still in the duplicate project. Also, the split-screen dashboard does not update while the secretary logs things during a voice call — I have to reload the page.

I've already diagnosed the root causes by reading the code. Verify each one, then fix. The voice/audio plumbing is FROZEN as before: do not modify `lib/realtime/openai-webrtc.ts`, `lib/realtime/remote-audio.ts`, or `app/api/realtime/*` (the React binding `components/chat/use-voice-session.ts` MAY be touched, but only its toolResult/event handling — nothing audio-related).

## Root cause 1 — the model is blind to existing projects, and matching is exact-only

- `resolveProject()` in `lib/secretary/tools.ts` matches with `ilike(projects.name, name)` — case-insensitive **exact** match, no wildcards, no fuzziness. "Find It" ≠ "Find It app" → silently **created a duplicate project**.
- `buildBriefing()` in `lib/secretary/briefing.ts` never tells the model what projects exist. The "ALL OPEN TASKS" list doesn't even include each task's project. The model literally cannot name the right project.

**Fix:**
1. In the briefing, add a compact `PROJECTS` section: `- "Find It app" (3 open)` for every non-archived project, with the instruction "file tasks into one of these exact names; only create a new project for a genuinely new area of life." Add the project name to each ALL OPEN TASKS line (`· project "Find It app"`).
2. Make `resolveProject()` tolerant: exact case-insensitive match → then normalized match (lowercase, strip punctuation/whitespace) → then containment/similarity ("find it" vs "find it app" must match; simple normalized containment or trigram similarity is fine — keep it dependency-free). Only create a new project when nothing is close. When a fuzzy match is used or a project is created, say so in the tool `result` (e.g. `{ project: "Find It app", matched: "fuzzy" }` / `{ created: true }`) so the model can react.
3. Unit-test `resolveProject`: exact, case, "Find It"→"Find It app", genuinely-new name creates, and no cross-user leakage.

## Root cause 2 — it physically cannot move a task, so it faked success

- `update_task` in `lib/secretary/tool-schemas.ts` has NO `project` field, and the handler never touches `projectId`. There is no list/rename/merge/delete project tool. Asked to move a task, the model had no tool that could do it — so it "noted" something and claimed "All set."

**Fix:**
1. Add `project` (optional string) to `update_task`: resolves via the same `resolveProject` path and reassigns `projectId`; the literal value `"none"` clears it. Toast: `→ Moved: <task> → <project>`.
2. Add `list_projects` (names + open/done counts — cheap, lets the model check before filing).
3. Add `update_project`: rename, change color, `merge_into` (moves all tasks to the target project then deletes the source), and `delete` (only when empty unless `merge_into` given). Toasts for each.
4. Update the tool descriptions (`lib/secretary/tool-schemas.ts`) so the model knows moving tasks and merging duplicate projects are things it CAN do. Keep the flat Realtime-compatible function shape.

## Root cause 3 — no honesty guardrail in the persona

- Nothing in `lib/secretary/persona.ts` stops the model from claiming an action succeeded without a confirming tool result. That's how "I'll adjust the task placement" became "All set" with zero writes.

**Fix — add to SECRETARY_PERSONA (concise, imperative):**
- Never say you did something unless a tool call in THIS conversation returned success for exactly that action. "All set" is earned by a tool result, not by intention.
- If you lack a tool for what the user asked, or a tool returns an error, say so plainly ("I can't move tasks between projects yet") — never improvise a workaround like "noting" it and never imply success.
- When the user reports a filing mistake, fix it with tools immediately (update_task with the correct project, merge duplicate projects), then confirm with what the tool returned.

## Root cause 4 — dashboard doesn't update during a call

- The only live wiring is `components/shell/refresh-on-focus.tsx` (window focus). The `toolResult` handler in `components/chat/use-voice-session.ts` only renders toasts — it never triggers `router.refresh()`. During a call the window is already focused, so the split-pane `DashboardPanel` (server component) never re-renders. That's why I had to reload.

**Fix:**
1. When a `toolResult` event fires during a voice call, trigger a debounced `router.refresh()` (~600ms, coalescing bursts) from the UI layer (`voice-mode.tsx` or via a callback passed into `useVoiceSession` — audio logic untouched). Result: the right pane updates within ~1–2s of each toast, mid-call, no reload.
2. Verify the text-chat path still refreshes after tool-using responses (it calls `router.refresh()` after sends — confirm tool calls inside `/api/chat` responses are covered).
3. Add a light safety net: while a voice call is `connected`, refresh every ~15s.
4. Newly appearing/changed task rows in the dashboard get the subtle entrance animation from the UI-overhaul spec (fade/slide + brief accent ring) if it isn't already implemented; the cross-off animation must still play when tasks complete from either pane.
5. Confirm this works through the split workspace composition (`app/(app)/chat/page.tsx` → `ChatWorkspace` → `DashboardPanel`) — `router.refresh()` must actually re-render the panel.

## One-off data repair (do this too)

Using the local dev DB (drizzle script or SQL, one-off, then delete the script):
1. Move task "Test Find It on iPad" into the "Find It app" project.
2. Delete the now-empty duplicate "Find It" project.
3. Show me the before/after rows.

## Verify

- `npm run build`, lint, vitest green (including new resolveProject + update_task-move tests).
- Manual script for me: start a voice call in split view → say "add a task to test the find it app on my iPhone, in the Find It app project" → row appears in the right pane within ~2s, filed under **Find It app** (no new project). Then say "actually move that to the Jazz music project" → watch it move live. Then "merge any duplicate projects" → duplicates gone. Then ask it to do something it has no tool for (e.g. "email this list to me") → it must say it can't, not claim success.
