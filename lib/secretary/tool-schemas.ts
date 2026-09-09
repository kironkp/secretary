// Tool definitions shared by the Realtime session (voice) and the Responses
// API (text chat). One source of truth: zod schemas → OpenAI JSON schemas.
import { z } from "zod";

export const toolSchemas = {
  create_task: z.object({
    title: z.string().min(1).describe("Short imperative title, e.g. 'Renew passport'"),
    notes: z.string().optional().describe("Extra context worth keeping"),
    due_at: z
      .string()
      .optional()
      .describe("Due date/time as ISO 8601 in the user's timezone, if mentioned"),
    project: z.string().optional().describe("Project name to file it under (created if new)"),
    priority: z.number().int().min(0).max(3).optional().describe("0 none · 1 low · 2 medium · 3 high"),
    reminders: z
      .array(z.string())
      .optional()
      .describe("Reminder times — exact ISO 8601 timestamps in the user's timezone"),
    stages: z
      .array(z.string())
      .optional()
      .describe(
        "For genuinely multi-step deliverables: ordered stage names, e.g. ['Outline','Draft','Review with Marissa','Submit']"
      ),
    recurrence: z
      .enum(["daily", "weekly", "monthly", "yearly"])
      .optional()
      .describe("Recurring task: completing it spawns the next occurrence from its due date"),
    stakes: z
      .string()
      .optional()
      .describe(
        "The consequence the user named for missing this, verbatim-ish: 'miss reconcile → strike from HQ'. Capture whenever a consequence is stated."
      ),
  }),
  update_task: z.object({
    task: z.string().min(1).describe("Task id, or a distinctive fragment of its title"),
    status: z
      .enum(["inbox", "todo", "in_progress", "blocked", "done", "dropped"])
      .optional(),
    due_at: z.string().optional().describe("New due date/time, ISO 8601"),
    title: z.string().optional(),
    notes: z.string().optional(),
    priority: z.number().int().min(0).max(3).optional(),
    project: z
      .string()
      .optional()
      .describe(
        'Move the task into this project (fuzzy-matched against existing names). The literal value "none" removes it from its project.'
      ),
    reminders: z
      .array(z.string())
      .optional()
      .describe("Replace the task's reminder times — exact ISO 8601 timestamps; [] clears them"),
    stages: z
      .array(z.string())
      .optional()
      .describe("Replace the task's stage list (ordered names); [] removes staging"),
    stage_done: z
      .string()
      .optional()
      .describe("Mark this stage complete (fuzzy name match), e.g. user says 'outline's done'"),
    recurrence: z
      .enum(["daily", "weekly", "monthly", "yearly", "none"])
      .optional()
      .describe('Make the task recurring, or "none" to stop it recurring'),
    stakes: z
      .string()
      .optional()
      .describe("Set/replace the named consequence of missing this task; \"\" clears it"),
    blocked_reason: z
      .string()
      .optional()
      .describe(
        'What the task is stuck ON and what would clear it ("waiting on Teresa\'s signature"); "" clears it. Setting any status other than blocked clears it automatically.'
      ),
    postpone_reason: z
      .string()
      .optional()
      .describe("If the user is pushing the due date, why (logged as a check-in)"),
  }),
  complete_task: z.object({
    task: z.string().min(1).describe("Task id, or a distinctive fragment of its title"),
  }),
  create_project: z.object({
    name: z.string().min(1),
    color: z.string().optional().describe("Hex color like #7aa2ff"),
  }),
  list_projects: z.object({}),
  update_project: z.object({
    project: z.string().min(1).describe("Existing project name (fuzzy-matched)"),
    name: z.string().optional().describe("Rename the project to this"),
    color: z.string().optional().describe("Hex color like #7aa2ff"),
    merge_into: z
      .string()
      .optional()
      .describe("Move ALL of its tasks into this other project, then delete it"),
    delete: z
      .boolean()
      .optional()
      .describe("Delete the project — only allowed when it has no tasks (use merge_into otherwise)"),
  }),
  create_event: z.object({
    title: z.string().min(1),
    starts_at: z.string().describe("Start date/time as ISO 8601 in the user's timezone"),
    ends_at: z.string().optional(),
    location: z.string().optional(),
    project: z
      .string()
      .optional()
      .describe(
        "Project to file it under (fuzzy-matched) — a meeting about an ongoing workstream belongs to that project"
      ),
    notes: z
      .string()
      .optional()
      .describe("Detail worth keeping — e.g. timezone conversions ('11:00 AM PT / 2:00 PM ET')"),
    reminders: z
      .array(z.string())
      .optional()
      .describe("Reminder times — exact ISO 8601 timestamps in the user's timezone"),
  }),
  update_event: z.object({
    event: z.string().min(1).describe("Event id, or a distinctive fragment of its title"),
    title: z.string().optional(),
    starts_at: z.string().optional().describe("New start, ISO 8601"),
    ends_at: z.string().optional(),
    location: z.string().optional(),
    notes: z.string().optional(),
    project: z
      .string()
      .optional()
      .describe('Move the event into this project (fuzzy-matched); "none" unfiles it'),
    reminders: z
      .array(z.string())
      .optional()
      .describe("Replace the event's reminder times — exact ISO 8601 timestamps; [] clears them"),
  }),
  delete_event: z.object({
    event: z.string().min(1).describe("Event id, or a distinctive fragment of its title"),
  }),
  create_document: z.object({
    title: z.string().min(1),
    project: z.string().optional().describe("Project it belongs to (fuzzy-matched)"),
    sections: z
      .array(z.object({ heading: z.string().min(1), content: z.string() }))
      .optional()
      .describe("Initial outline — headings with content (content may be empty to start)"),
  }),
  list_documents: z.object({}),
  read_document: z.object({
    document: z.string().min(1).describe("Document id, or a fragment of its title ('the budget doc')"),
    section: z
      .string()
      .optional()
      .describe("Read just this section (fuzzy heading match, or a number like '2'). Long docs REQUIRE section-level reads."),
  }),
  edit_document_section: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
    section: z.string().min(1).describe("Section heading (fuzzy) or number"),
    content: z
      .string()
      .optional()
      .describe("The section's NEW full text (replaces the old text)"),
    heading: z.string().optional().describe("Rename the section to this"),
    append: z
      .string()
      .optional()
      .describe("Text to add to the END of the section instead of replacing"),
  }),
  add_document_section: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
    heading: z.string().min(1),
    content: z.string().optional(),
    after: z.string().optional().describe("Insert after this existing section (fuzzy); default: at the end"),
  }),
  remove_document_section: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
    section: z.string().min(1).describe("Section heading (fuzzy) or number"),
  }),
  revert_document: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
  }),
  update_document: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
    title: z.string().optional(),
    project: z.string().optional().describe('Move to this project (fuzzy); "none" unfiles it'),
  }),
  delete_document: z.object({
    document: z.string().min(1).describe("Document id or title fragment"),
  }),
  get_agenda: z.object({
    date: z
      .string()
      .optional()
      .describe("'today' (default), 'tomorrow', or a YYYY-MM-DD date"),
  }),
  get_overdue: z.object({}),
  get_tasks: z.object({
    status: z
      .enum(["inbox", "todo", "in_progress", "blocked", "done", "dropped"])
      .optional(),
    project: z.string().optional().describe("Filter to a project by name"),
  }),
  remember_fact: z.object({
    fact: z.string().min(1).describe("A durable fact about the user worth remembering"),
    tags: z.array(z.string()).optional(),
  }),
  recall_facts: z.object({}),
  get_current_datetime: z.object({}),
  search_history: z.object({
    query: z.string().min(1).describe("Text to search past conversations for"),
    after: z
      .string()
      .optional()
      .describe("Only messages at/after this instant — ISO 8601 ('last week' → 7 days ago)"),
    before: z.string().optional().describe("Only messages before this instant — ISO 8601"),
  }),
  // --- Thin voice tools (SPEC §11 fast/slow split): the realtime model is
  // mouth and ears ONLY. These four verbs + the clarification pair are all it
  // carries; everything heavier belongs to the async extractor and text chat. ---
  log_status: z.object({
    task: z.string().min(1).describe("Task id or a distinctive title fragment"),
    signal: z.enum(["done", "started", "postponed", "blocked", "progress", "dropped"]),
    new_due_at: z.string().optional().describe("If postponed: the new date, ISO 8601"),
    note: z
      .string()
      .optional()
      .describe(
        "What the user said, briefly. On signal blocked this is THE REASON — what it's stuck on and what would clear it (\"waiting on Teresa's signature\") — stored on the task so later sessions can explain the block instead of reciting the word.",
      ),
  }),
  create_commitment: z.object({
    title: z.string().min(1).describe("Short imperative title"),
    due_at: z.string().optional().describe("ISO 8601 if a deadline was stated"),
    project: z.string().optional().describe("Project name if it belongs to one"),
    stakes: z.string().optional().describe("Named consequence of missing it, if the user stated one"),
  }),
  schedule_checkin: z.object({
    commitment: z.string().min(1).describe("What the user should report back on"),
    expected_update_by: z.string().describe("ISO 8601 — when you'll ask"),
    task: z.string().optional().describe("Related task title fragment"),
  }),
  amend_task: z.object({
    task: z.string().min(1).describe("The EXISTING task — id or a distinctive title fragment"),
    project: z
      .string()
      .optional()
      .describe(
        'File it under this project (fuzzy-matched against existing names, created if new). The literal value "none" removes it from its project.'
      ),
    title: z.string().optional().describe("New title, if the user renamed it"),
    note: z.string().optional().describe("Detail worth keeping on the task, briefly"),
  }),
  // --- Agent layer (SPEC §11): persona + pipeline templates ---
  update_persona: z.object({
    name: z
      .string()
      .optional()
      .describe("The name the user gave you ('I'll call you Dot') — shows in transcripts"),
    sass: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe(
        "Sass dial: 1 robotic · 2 dry professional · 3 deadpan · 4 sardonic · 5 full sass ('be more sassy' → +1, 'full Monday' → 5, 'tone it down' → -1)"
      ),
    strictness: z.enum(["gentle", "standard", "stern"]).optional(),
    tone: z.enum(["warm", "professional", "brisk"]).optional(),
    praise: z.enum(["effusive", "brief", "none"]).optional(),
    followup_aggressiveness: z.enum(["low", "standard", "high"]).optional(),
    quiet_hours_start: z.string().optional().describe("HH:MM, e.g. 22:00"),
    quiet_hours_end: z.string().optional().describe("HH:MM, e.g. 07:30"),
  }),
  queue_clarification: z.object({
    kind: z.enum(["referent", "asr_span", "new_name", "entity_conflict"]),
    question: z.string().min(1).describe("Ready-to-ask question, e.g. 'Which CPO did you mean by \"this one\"?'"),
    context: z.string().optional().describe("The verbatim phrase/span it's about"),
  }),
  resolve_clarification: z.object({
    question: z.string().min(1).describe("The clarification being answered (fragment ok)"),
    answer: z.string().min(1).describe("What the user said"),
    action: z
      .enum(["same_entity", "different_person", "spelling_confirmed", "spelling_corrected", "note"])
      .describe(
        "same_entity = the heard name IS the linked entity (stored as alias) · different_person = create a separate entity · spelling_confirmed / spelling_corrected (give corrected_name) · note = free-text resolution only"
      ),
    corrected_name: z.string().optional().describe("For spelling_corrected: the right spelling"),
  }),
  create_expectation: z.object({
    commitment: z
      .string()
      .min(1)
      .describe("What the user is expected to report, e.g. 'CPO 2073 updated and shown to Teresa'"),
    expected_update_by: z.string().describe("ISO 8601 — when an update is due from the user"),
    task: z
      .string()
      .optional()
      .describe("Related task id or title fragment (links stakes + auto-clearing)"),
    on_miss: z
      .enum(["mention", "nag", "escalate"])
      .optional()
      .describe("mention = one soft line · nag = direct opener question · escalate = open with it, cite stakes, ask for a new commitment"),
  }),
  save_pipeline_template: z.object({
    name: z.string().min(1).describe("Template name, e.g. 'CPO procurement'"),
    steps: z
      .array(
        z.object({
          name: z.string().min(1),
          blocked_by: z
            .number()
            .int()
            .min(0)
            .nullable()
            .optional()
            .describe("Index of the step that must finish first; omit/null if independent"),
          offset_days: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe("Step due date = anchor date + this many days; omit if undated"),
        })
      )
      .min(2),
    recurrence: z.enum(["daily", "weekly", "monthly", "yearly"]).optional(),
  }),
  apply_pipeline: z.object({
    task: z.string().min(1).describe("Task id, or a distinctive fragment of its title"),
    template: z.string().min(1).describe("Pipeline template name (fuzzy-matched)"),
    anchor_date: z
      .string()
      .optional()
      .describe("ISO date the step offsets count from; defaults to today"),
  }),
  // --- Layout tools (SPEC §7.5 tier 1): the dashboard's arrangement is data ---
  get_current_plan: z.object({}),
  edit_layout_plan: z.object({
    operations: z
      .array(
        z.discriminatedUnion("op", [
          z.object({
            op: z.literal("remove"),
            section: z.string().describe("Section key, e.g. 'timeline' or 'project_card:<project_id>'"),
          }),
          z.object({
            op: z.literal("move"),
            section: z.string().describe("Section key to move"),
            to: z.number().int().min(0).describe("New position, 0 = top"),
          }),
          z.object({
            op: z.literal("set_props"),
            section: z.string().describe("Section key to change"),
            props: z
              .record(z.string(), z.unknown())
              .describe("New props merged over current, e.g. {\"variant\":\"compact\"} or {\"expanded\":true}"),
          }),
          z.object({
            op: z.literal("add"),
            component: z.string().describe("Registry component to add"),
            props: z.record(z.string(), z.unknown()).optional(),
            at: z.number().int().min(0).optional().describe("Position; omit = end"),
          }),
        ])
      )
      .min(1),
  }),
  // --- Canvas tools (SPEC §7.6): the model-painted visual surface ---
  paint_canvas: z.object({
    brief: z
      .string()
      .min(1)
      .describe(
        "What to paint, in the user's words plus any specifics they gave, e.g. 'my week as a timeline with the album work highlighted'"
      ),
  }),
  edit_canvas: z.object({
    patch: z
      .string()
      .min(1)
      .describe("The targeted change, e.g. 'make the album section bigger' — the rest stays"),
  }),
  show_canvas: z.object({}),
  // --- Slow loop, tier 2 (SPEC §7.5): asks OUTSIDE the registry become code ---
  request_new_component: z.object({
    need: z
      .string()
      .min(1)
      .describe("The view the user wants that no registry component provides, in their words, e.g. 'show the album as a burndown chart'"),
    closest_component: z
      .string()
      .min(1)
      .describe("The nearest existing registry component to substitute meanwhile, e.g. 'timeline'"),
    sketch: z.string().optional().describe("Any specifics the user gave about how it should look"),
  }),
  review_proposed_component: z.object({
    name: z.string().min(1).describe("The proposal name, as listed in the wishlist/Settings"),
    decision: z.enum(["approve", "reject"]),
  }),
  set_layout_preference: z.object({
    kind: z.enum(["ban_component", "pin_section", "default_variant_for", "accent_policy"]),
    component: z
      .string()
      .optional()
      .describe("ban_component: the registry component to never show, e.g. 'people_index'"),
    section: z.string().optional().describe("pin_section: section key to freeze in place"),
    project: z.string().optional().describe("default_variant_for: project name or id"),
    variant: z.enum(["full", "compact", "nested"]).optional().describe("default_variant_for: the variant"),
    policy: z.enum(["never", "auto"]).optional().describe("accent_policy: 'never' kills the glow ring"),
    remove: z.boolean().optional().describe("true = delete this preference instead of adding it"),
  }),
  consult_brain: z.object({
    question: z.string().min(1).describe("The hard question, fully self-contained"),
    context: z
      .string()
      .optional()
      .describe("Anything from this conversation the brain needs to answer well"),
  }),
  request_capability: z.object({
    need: z
      .string()
      .min(1)
      .describe("What the app should be able to do, stated as the user's need — not a technical spec"),
    context: z
      .string()
      .optional()
      .describe("Verbatim-ish conversation context: what the user asked and why it matters"),
  }),
  review_capability: z.object({
    request: z.string().min(1).describe("The request's need (or a distinctive fragment of it)"),
    decision: z.enum(["approve", "reject", "revise"]),
    feedback: z
      .string()
      .optional()
      .describe("decision=revise: the user's notes on the plan — what to change, add, or drop"),
  }),
} as const;

export type ToolName = keyof typeof toolSchemas;

const toolDescriptions: Record<ToolName, string> = {
  create_task:
    "Log a task the user needs to do. Call this the moment a to-do, deadline, or obligation comes up in conversation — don't wait to be asked. Supports notes, reminder times, stages (multi-step deliverables), and recurrence (e.g. rent monthly).",
  update_task:
    "Change a task: status, due date, title, notes, priority, MOVE IT TO ANOTHER PROJECT (project: name, or \"none\"), define stages, mark a stage done (stage_done: 'outline'), or set/clear recurrence. Use when the user postpones, starts, advances a stage, or edits anything.",
  complete_task:
    "Mark a task done. Use when the user says they did it ('yeah I sent it this morning').",
  create_project:
    "Create a project to group related tasks (e.g. 'Mexico trip'). Check list_projects first — close names are matched to existing projects instead of creating duplicates.",
  list_projects:
    "All projects with open/done counts. Check this before filing a task when unsure of the exact project name.",
  update_project:
    "Rename a project, change its color, MERGE it into another (merge_into moves all tasks then deletes the duplicate), or delete an empty one. Use this to clean up duplicate projects.",
  create_event:
    "Log a calendar event — meetings, appointments, social plans with a specific time. Supports notes (timezone conversions, agenda) and reminder times.",
  update_event:
    "Edit an EXISTING event: retitle, move its time, set location, add notes (e.g. an East-Coast time conversion), or set reminder times. When the user says 'add X to that meeting', use THIS — don't create a task about it.",
  delete_event: "Remove an event that was cancelled or logged by mistake.",
  create_document:
    "Start a real living document under a project — duty statements, budgets, drafts. Give it outline sections up front when the shape is known.",
  list_documents: "All documents with their project, section headings, and last-edited time.",
  read_document:
    "Read a document. For long documents you get headings only — read one section at a time (section: heading fragment or number). Summarize aloud; don't recite long text verbatim unless asked.",
  edit_document_section:
    "Rewrite one section of a document (content replaces the section's text; append adds to it). The previous state is snapshotted — edits are always revertible. Confirm briefly what changed.",
  add_document_section: "Add a new section to a document.",
  remove_document_section: "Remove a section (snapshotted first — revertible).",
  revert_document:
    "Undo the last change to a document, restoring the previous version. Use when the user says 'go back to how it was'.",
  update_document: "Rename a document or move it to another project.",
  delete_document: "Delete a document entirely. Confirm with the user first.",
  get_agenda: "Tasks due and events happening on a given day.",
  get_overdue: "All open tasks past their due date.",
  get_tasks: "List the user's tasks, optionally filtered by status or project.",
  remember_fact:
    "Save a durable fact about the user (names, preferences, context) for future conversations.",
  recall_facts: "Everything remembered about the user.",
  get_current_datetime:
    "The current date and time in the user's timezone. Use this instead of guessing — never assume the date.",
  search_history:
    "Search past conversation transcripts (voice and text) for what was actually said — 'what did I say about X last week?'. after/before narrow to a time window. Your briefing already carries the last few sessions verbatim; use this for anything older or not shown.",
  get_current_plan:
    "The dashboard's current layout plan: sections in order (with keys), the component registry, and the user's stored layout preferences. Call before editing the layout.",
  edit_layout_plan:
    "Rearrange the user's dashboard NOW: move/remove/add sections or change their props (variant, expanded, accent). User-initiated changes apply immediately. For 'never show X again' use set_layout_preference instead.",
  log_status:
    "Voice: the user reported where something stands ('updated it this morning', 'pushing that to Friday'). One call PER ITEM — a list spoken in one breath is several calls in the same turn, blocked items included: on signal blocked the note is the REASON ('waiting on Teresa's signature'), stored on the task so you can explain the block later instead of reciting the word. If the user hasn't said why it's stuck, log it anyway and ask them right then, in one line. 'That shouldn't be a task' / 'forget that one' / 'take it off the list' → signal dropped: removes it from the checklist on the spot (reinstatable by asking). Drop ONLY the exact task the user named — when unsure which one they mean, ask first. If the drop states a standing rule ('never make Caltrans checks a task'), ALSO call remember_fact in the SAME turn. The store is the only truth; log it the moment you hear it.",
  create_commitment:
    "Voice: the user took something on. Log it immediately with any stated deadline and stakes ('so I don't get a strike'). Several items mentioned together = several calls in the same turn. Never wait to be asked.",
  schedule_checkin:
    "Voice: you promised to follow up ('I'll be asking either way') — schedule it in the SAME breath. A user report clears it silently; a miss opens the next session.",
  amend_task:
    "Voice: the user is changing something about a task that ALREADY exists — 'file that under Caltrans', 'move it to the trip project', 'rename it', 'add a note that the gate code is 4411'. Amends the EXISTING task in place: project (\"none\" unfiles it), title, note. NEVER creates a task — create_commitment is only for a genuinely new to-do.",
  update_persona:
    "The user asked you to BE different — sterner, gentler, brisker, more/less follow-up, quiet hours ('I need a nagging secretary', 'stop being so peppy') — or gave you a NAME ('I'll call you Dot'). Store it ONCE here; it applies to every future conversation, the transcript labels, and the nag engine. Never re-ask.",
  queue_clarification:
    "Something in the conversation is ambiguous and you can NOT resolve it — an unclear referent ('this one is finished' about a screen you can't see), a garbled name, a possible person mix-up. NEVER guess and never interrogate mid-flow: queue it here; your briefing surfaces ONE at a natural pause.",
  resolve_clarification:
    "The user just answered a queued clarification — record the resolution. For entity questions the action fixes the store: same_entity adds an alias, different_person creates the new person, spelling_confirmed/corrected fix the name.",
  create_expectation:
    "NEVER make a rhetorical promise: the moment you say \"I'll be asking\" / \"check back in with me\" / \"I'll follow up\", call this in the SAME turn. The user reporting progress clears it silently; a miss makes you open the next session with it (per on_miss). This is what makes your follow-through real.",
  save_pipeline_template:
    "Save a reusable ordered checklist with dependencies (blocked_by) and per-step date offsets — e.g. CPO: update → sign (blocked by update) → pay (blocked by sign) → reconcile+submit. Use when the user describes an order of operations that will repeat.",
  apply_pipeline:
    "Instantiate a saved pipeline template onto a task: sets its stages with computed per-step dates. 'Where am I on X' is then answered from the task's stage state — never from memory.",
  paint_canvas:
    "Paint a NEW canvas: a free-form visual the user watches build live — posters, charts, big-number summaries, week views. Use for 'show me / draw / visualize / put it on the canvas' when there is nothing on the canvas yet, or when they want a genuinely different picture. If a canvas already exists and they are CHANGING it, use edit_canvas instead — repainting throws away what they are looking at. The painter READS THE RECENT CONVERSATION, so 'lay out the CPO statuses we just discussed' is a complete brief — everything the user just said will render. Never say you can't draw, and never promise a screen update without calling this or edit_canvas. The result appears on the Canvas tab; say so.",
  edit_canvas:
    "THE DEFAULT when something is already on the canvas and the user changes it. Anything that modifies the existing view — 'add one more thing', 'make that purple', 'move this above that', 'only show the Caltrans items', 'make the urgent one bigger', 'put these on the right', 'change the title', 'drop the empty column' — is an EDIT: the current canvas is kept and changed. Use paint_canvas ONLY when they want a genuinely different picture ('now show me the album instead', 'paint my week'). If in doubt and a canvas exists, edit. Requires an existing canvas — otherwise use paint_canvas.",
  show_canvas:
    "Bring the Canvas into view on the user's screen WITHOUT repainting — 'open the canvas', 'show me the canvas', 'put that back up'. paint_canvas and edit_canvas already open it automatically; use this only when the user wants to look at what's already there.",
  request_new_component:
    "The user wants a dashboard view that doesn't exist yet (outside the registry). Files a priority wishlist entry and starts a background build (a few minutes). ALSO call paint_canvas with the same ask so they see something NOW, and tell them honestly: 'Building that view — meanwhile, here's the nearest thing.' When the build lands, approval happens in chat via review_proposed_component.",
  review_proposed_component:
    "Approve or reject a built component proposal. Approve = it joins the dashboard registry immediately (no restart). Reject = the need is tombstoned and never re-proposed.",
  set_layout_preference:
    "Store a durable layout preference: ban_component ('stop showing me people' → component: people_index), pin_section (freeze a section), default_variant_for (a project always compact/full/nested), accent_policy: never ('I hate the glowing ring'). remove: true deletes it. Enforced on every future plan until removed in Settings.",
  consult_brain:
    "Ask the deep-reasoning brain (Claude) a question that needs genuine analysis — tricky planning, weighing tradeoffs, drafting something hard, math beyond arithmetic. NOT for quick recall or anything your other tools already answer. On a call: say a brief 'give me a second' first, then relay the answer in your own words and register. Takes a few seconds.",
  request_capability:
    "You lack a tool or ability the user needs ('I can't store that', 'no tool for X', 'I can't do that here'): NEVER dead-end — file this in the SAME turn. The shop (Claude Code on the user's machine) drafts an implementation plan for the user to approve; approved builds land in the app automatically, fully tested. Say: 'I can't do that yet — sent it to the shop; you'll get a plan to approve.' NOT for things your existing tools already handle.",
  review_capability:
    "The user decided on a shop request. approve = build it ('yes build it') — starts immediately, or queues behind the current shop job and starts automatically. reject = closed for good. revise (with feedback) = the user wants the plan CHANGED ('have it also handle X', 'too complicated, simpler') — the shop redrafts and they get a fresh plan to review. Your briefing lists requests awaiting decision.",
};

/** OpenAI tool definitions (same flat shape works for Realtime and Responses). */
export function openAIToolDefs() {
  return (Object.keys(toolSchemas) as ToolName[]).map((name) => ({
    type: "function" as const,
    name,
    description: toolDescriptions[name],
    parameters: z.toJSONSchema(toolSchemas[name]),
  }));
}

/** Anthropic tool definitions — same source of truth, Messages-API shape. */
export function anthropicToolDefs() {
  return (Object.keys(toolSchemas) as ToolName[]).map((name) => ({
    name,
    description: toolDescriptions[name],
    input_schema: z.toJSONSchema(toolSchemas[name]) as Record<string, unknown>,
  }));
}

/** SPEC §11 fast/slow split: the ONLY tools the realtime voice session
 *  carries. The mouth logs, commits, schedules, paints, remembers, and asks —
 *  the async extractor (brain) and text chat own everything else. */
export const VOICE_TOOL_NAMES = [
  "log_status",
  "create_commitment",
  // a change to something already logged ("file that under X", "rename it")
  // is an amendment of the existing row, never a second commitment
  "amend_task",
  "schedule_checkin",
  "paint_canvas",
  // Changing something already on screen is an EDIT, not a new painting.
  // Without this the voice session had no edit tool at all, so every spoken
  // "add one more thing" fell through to paint_canvas — which is handed no
  // copy of the current canvas and therefore paints a different one from
  // scratch. The persona has always instructed the model to call this.
  "edit_canvas",
  // "open the canvas" flips the in-call canvas into view (§7.6 auto-open)
  // without burning a repaint
  "show_canvas",
  "get_current_datetime",
  "queue_clarification",
  "resolve_clarification",
  // stated facts are fast-path capture (one insert, no entity resolution);
  // the extractor stays the safety net for inferred ones
  "remember_fact",
  // the Siri-asks-ChatGPT move: the mouth phones the Claude brain on demand
  "consult_brain",
  // the upward cycle: "I can't do that" files a shop request instead of dying
  "request_capability",
  "review_capability",
  // cross-session recall on demand (SPEC §11): the briefing carries the last
  // few sessions verbatim; this reaches everything older ("what did I say
  // about X last week?")
  "search_history",
] as const satisfies readonly ToolName[];

export function openAIVoiceToolDefs() {
  return VOICE_TOOL_NAMES.map((name) => ({
    type: "function" as const,
    name,
    description: toolDescriptions[name],
    parameters: z.toJSONSchema(toolSchemas[name]),
  }));
}
