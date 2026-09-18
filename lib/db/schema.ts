import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// Binary column for attachment payloads (drizzle has no built-in bytea).
const bytea = customType<{ data: Buffer }>({
  dataType: () => "bytea",
});

// ---------------------------------------------------------------------------
// Better Auth tables (names/fields must match what the drizzle adapter expects)
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Captured at signup from the browser (Intl.DateTimeFormat().resolvedOptions().timeZone),
  // editable in settings. Every briefing / due-date / overdue computation uses it.
  timezone: text("timezone").notNull().default("UTC"),
  // SPEC §1 invariant 7: calm mode renders DEFAULT_PLAN unconditionally and
  // the planner is never called. Toggled in Settings.
  calmMode: boolean("calm_mode").notNull().default(false),
  // Persona config (SPEC §11, from the Aug 18 transcript): stored ONCE, applied
  // to voice, chat, UI copy, and the nag engine — never re-requested per
  // conversation. Null = defaults (see lib/secretary/persona.ts).
  persona: jsonb("persona").$type<{
    name?: string;
    // preferred realtime voice ("marin", …) or "elevenlabs" for the EL mouth
    voice?: string;
    // 1 robotic · 2 dry professional · 3 deadpan · 4 sardonic · 5 full sass
    sass?: 1 | 2 | 3 | 4 | 5;
    strictness?: "gentle" | "standard" | "stern";
    tone?: "warm" | "professional" | "brisk";
    praise?: "effusive" | "brief" | "none";
    followup_aggressiveness?: "low" | "standard" | "high";
    quiet_hours?: { start: string; end: string } | null;
    // Claude brain (Settings): model + effort for extraction/painter/planner
    brainModel?: string;
    brainEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    // Composer chip: the text secretary's model + effort (either provider)
    chatModel?: string;
    chatEffort?: string;
    // In-call thinking depth for the realtime voice ("auto" = API default)
    voiceEffort?: string;
  } | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const passkey = pgTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  aaguid: text("aaguid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Secretary domain tables
// ---------------------------------------------------------------------------

export const projectStatus = pgEnum("project_status", ["active", "someday", "archived"]);
export const taskStatus = pgEnum("task_status", [
  "inbox",
  "todo",
  "in_progress",
  "blocked",
  "done",
  "dropped",
]);
export const itemSource = pgEnum("item_source", ["spoken", "typed", "inferred", "suggested"]);
export const checkinType = pgEnum("checkin_type", ["nudge", "user_update", "auto_detected"]);
export const conversationMode = pgEnum("conversation_mode", ["voice", "text"]);
export const messageRole = pgEnum("message_role", ["user", "assistant", "tool"]);
export const usageKind = pgEnum("usage_kind", [
  "voice",
  "transcribe",
  "extraction",
  "layout",
  "chat",
  // consult_brain: the voice/chat asking the Claude brain a hard question
  "consult",
  // Canvas paints and edits. Previously invisible, and among the most
  // expensive calls in the app: a multi-thousand-token generation, sometimes
  // several per conversation.
  "paint",
  // Nightly slow loop: proposing dashboard components.
  "slow_loop",
  // Inbound email: reading forwarded attachments with a vision model.
  "email",
  // Speech synthesis (ElevenLabs), billed per character rather than per token.
  "speech",
  // Anything not yet categorised — better an "other" bucket than a silent gap.
  "other",
]);

const uuid = () => crypto.randomUUID();

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  mode: conversationMode("mode").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  // Chains text-mode Responses API turns (tool calls + reasoning live server-side
  // at OpenAI); reset whenever a voice session touches the conversation.
  lastResponseId: text("last_response_id"),
  // High-water mark for the post-conversation extraction pass: only messages
  // created after this instant are re-scanned, so repeated runs stay cheap
  // and never double-extract.
  extractedAt: timestamp("extracted_at", { withTimezone: true }),
  // Ingestion channel: null = the user's own chat/voice threads; "email" =
  // mailbox intake. Email threads never hijack the active chat (review
  // finding) — they're reachable via ?c= links and history search.
  channel: text("channel"),
});

// A message's id doubles as the provenance anchor: task/event provenance links
// deep-link to the exact message ("from Tuesday's conversation").
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    mode: conversationMode("mode").notNull(),
    // Photo/file intake: meta for rendering thumbnails; payloads live in the
    // attachments table (DB-stored — Heroku's filesystem is ephemeral).
    attachments: jsonb("attachments").$type<{ id: string; mime: string; name: string }[] | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Recall paths (SPEC §11 cross-session recall): newest-first windows per
  // conversation, and per-user recency scans for search_history / tails.
  (t) => [
    index("messages_user_conversation_created_idx").on(t.userId, t.conversationId, t.createdAt),
    index("messages_user_created_idx").on(t.userId, t.createdAt),
  ]
);

// Uploaded photos/files (chat intake). Rows are created on upload with a null
// messageId, then bound to the user message on send; unbound rows older than a
// day are garbage (abandoned composer) and safe to sweep.
export const attachments = pgTable("attachments", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  messageId: text("message_id").references(() => messages.id, { onDelete: "cascade" }),
  mime: text("mime").notNull(),
  name: text("name").notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  color: text("color"),
  status: projectStatus("status").notNull().default("active"),
  // SPEC §4: a project-level deadline. "committed" = the user said so (set via
  // chat tools); when null, signals infer one from the earliest dated open
  // task/event and report deadline_type "inferred".
  deadline: timestamp("deadline", { withTimezone: true }),
  deadlineKind: text("deadline_kind").$type<"committed" | null>(),
  // Subprojects (SPEC §4/§5 rule 4): a project may nest under a parent.
  parentId: text("parent_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  notes: text("notes"),
  status: taskStatus("status").notNull().default("inbox"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  remindAt: timestamp("remind_at", { withTimezone: true }),
  priority: integer("priority").notNull().default(0),
  source: itemSource("source").notNull().default("typed"),
  createdFromConversationId: text("created_from_conversation_id").references(
    () => conversations.id,
    { onDelete: "set null" }
  ),
  createdFromMessageId: text("created_from_message_id").references(() => messages.id, {
    onDelete: "set null",
  }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Reminder times as ISO timestamps. No push delivery yet — surfaced in the
  // briefing and the dashboard (supersedes the never-used remindAt column).
  reminders: jsonb("reminders").$type<string[]>().notNull().default([]),
  // Multi-step work shows its stages: ordered checklist, e.g. outline →
  // draft → review → submit. Empty = plain single-step task. SPEC §11 pipeline
  // steps add optional per-step dates and blocked_by (index of the blocking
  // stage) — "where am I" reads THIS, never summary memory.
  stages: jsonb("stages")
    .$type<{ name: string; done: boolean; due_at?: string | null; blocked_by?: number | null }[]>()
    .notNull()
    .default([]),
  // SPEC §11: the consequence the user named ("miss reconcile → strike from
  // HQ"). Nags MUST cite stakes when present — sternness stays honest.
  stakes: text("stakes"),
  // SPEC §11 voice modality rule: what a blocked task is stuck ON ("waiting on
  // Teresa's signature"). Same rationale as stakes — a bare status word is a
  // database row read aloud; this is what makes it a person's answer. Set by
  // log_status's note, cleared the moment any other signal moves the item.
  blockedReason: text("blocked_reason"),
  // 'daily' | 'weekly' | 'monthly' | 'yearly' — completing the task spawns
  // the next occurrence (lib/secretary/recurrence.ts). Null = one-shot.
  recurrence: text("recurrence"),
  postponedCount: integer("postponed_count").notNull().default(0),
  lastNudgedAt: timestamp("last_nudged_at", { withTimezone: true }),
  procrastinationScore: real("procrastination_score").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const events = pgTable("events", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  // Events are peers of tasks in the project graph — a meeting about the
  // patent belongs to the patent project, so project views can show it.
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  location: text("location"),
  // Free-form detail that fits no structured slot (e.g. "11:00 AM PT / 2:00 PM ET")
  notes: text("notes"),
  reminders: jsonb("reminders").$type<string[]>().notNull().default([]),
  source: itemSource("source").notNull().default("typed"),
  conversationId: text("conversation_id").references(() => conversations.id, {
    onDelete: "set null",
  }),
  messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const checkins = pgTable("checkins", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  type: checkinType("type").notNull(),
  note: text("note"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const memories = pgTable("memories", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  fact: text("fact").notNull(),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const layoutSpecs = pgTable("layout_specs", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  spec: jsonb("spec").notNull(),
  pinned: jsonb("pinned").$type<string[]>().notNull().default([]),
  // "v0" rows hold the legacy LayoutSpec; "plan" rows hold a SPEC §3
  // LayoutPlan. Both share the version sequence so revert works uniformly.
  kind: text("kind").$type<"v0" | "plan">().notNull().default("v0"),
  // Decision log (SPEC §6): what the plan was built from and what became of it.
  signalsHash: text("signals_hash"),
  reasonSummary: text("reason_summary"),
  outcome: text("outcome").$type<"accepted" | "reverted" | "pinned_over" | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Entity store (SPEC §11): people, orgs, project terms, acronyms. Every
// mention cross-references here BEFORE write; a mention matching an existing
// entity can never be silently dropped or merged. Also feeds the ASR lexicon.
export const entities = pgTable("entities", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").$type<"person" | "org" | "term" | "acronym">().notNull(),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  // false = heard once with low confidence; spelling unconfirmed — do not use
  // in documents until the user confirms (clarification queue does that).
  confirmed: boolean("confirmed").notNull().default(true),
  notes: text("notes"),
  lastMentionedAt: timestamp("last_mentioned_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Clarification queue (SPEC §11): extraction ambiguities accumulate here and
// are asked ONE at a time at natural pauses — never mid-flow, never a barrage,
// never silently guessed.
export const clarifications = pgTable("clarifications", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind")
    .$type<"referent" | "asr_span" | "new_name" | "entity_conflict">()
    .notNull(),
  // the heard name / span the question is about (resolution mechanics use it)
  subject: text("subject"),
  question: text("question").notNull(),
  // the verbatim source snippet (for asr_span: kept with audio offsets)
  context: text("context"),
  entityId: text("entity_id").references(() => entities.id, { onDelete: "set null" }),
  status: text("status").$type<"open" | "asked" | "resolved" | "dismissed">().notNull().default("open"),
  resolution: text("resolution"),
  askedAt: timestamp("asked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Expectations / nag engine (SPEC §11): every promised follow-up ("I'll be
// asking either way") becomes a ROW, never a rhetorical promise. A user report
// clears it silently; a miss fires at the next session per escalation policy —
// batched into one ping, quiet-hours-aware, citing stakes when recorded.
export const expectations = pgTable("expectations", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  commitment: text("commitment").notNull(),
  expectedUpdateBy: timestamp("expected_update_by", { withTimezone: true }).notNull(),
  onMiss: text("on_miss").$type<"mention" | "nag" | "escalate">().notNull().default("nag"),
  status: text("status").$type<"open" | "cleared" | "missed">().notNull().default("open"),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Pipeline templates (SPEC §11): reusable ordered step lists with blocked_by
// dependencies, instantiable per task (e.g. CPO: update → sign → pay →
// reconcile+submit). offset_days positions each step's due date relative to
// the task's anchor date at apply time.
export const pipelineTemplates = pgTable("pipeline_templates", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  steps: jsonb("steps")
    .$type<{ name: string; blocked_by?: number | null; offset_days?: number | null }[]>()
    .notNull(),
  recurrence: text("recurrence"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Slow-loop wishlist (SPEC §7, v1.3): the planner/user wants a component that
// doesn't exist → a wish accumulates here instead of improvising. Dedupe by
// normalized need; tombstoned wishes are never re-proposed.
export const wishlist = pgTable("wishlist", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  need: text("need").notNull(),
  closestComponent: text("closest_component").notNull(),
  signals: text("signals").notNull(),
  count: integer("count").notNull().default(1),
  priority: boolean("priority").notNull().default(false),
  tombstoned: boolean("tombstoned").notNull().default(false),
  status: text("status")
    .$type<"open" | "building" | "proposed" | "approved" | "rejected">()
    .notNull()
    .default("open"),
  proposalName: text("proposal_name"),
  enqueuedAt: timestamp("enqueued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-user model-provider connections: the SITE login is better-auth (above);
// this is the "connect your Claude account once inside" layer. Keys are
// AES-256-GCM encrypted at rest (lib/crypto.ts); only the tail is readable.
// Brain features resolve the user's key first, then the house .env key.
export const connectedAccounts = pgTable("connected_accounts", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  provider: text("provider").$type<"anthropic" | "openai">().notNull(),
  encryptedKey: text("encrypted_key").notNull(),
  // last 4 chars, for "Connected ····x7Ab" display — never the key itself
  keyTail: text("key_tail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Web Push (installed PWA): one row per enabled device. Dead endpoints
// (404/410 from the push service) are pruned on send — the table self-cleans.
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Once-only guarantee for scheduled pushes: the scanner claims a key
// (e.g. "task:<id>:<reminder-iso>") before sending; a unique violation means
// another pass already took it.
export const pushLog = pgTable("push_log", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  key: text("key").notNull().unique(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});

// The Shop (self-improvement loop): "I can't do that" files a request here;
// headless Claude Code drafts a plan (plan-mode, read-only), the user approves
// in chat/voice/Settings, and a worktree build lands ONLY after the runner
// itself re-runs tsc + lint + tests. Approval is the single human step.
export const capabilityRequests = pgTable("capability_requests", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  need: text("need").notNull(),
  context: text("context"),
  status: text("status")
    .$type<
      "filed" | "planning" | "planned" | "approved" | "building" | "shipped" | "failed" | "rejected"
    >()
    .notNull()
    .default("filed"),
  plan: text("plan"),
  // Revision loop: the user's feedback on a drafted plan (accumulates across
  // rounds); a request with feedback re-enters planning with the old plan +
  // feedback in the prompt.
  feedback: text("feedback"),
  // Per-request build preferences (set at approve time; null = the machine's
  // Claude Code defaults). buildModel is a CLI alias/name ("fable", "opus",
  // "sonnet"); ultracode prepends the orchestration keyword to the build
  // prompt — the user's usual mode, so it defaults on.
  buildModel: text("build_model"),
  buildEffort: text("build_effort"),
  ultracode: boolean("ultracode").notNull().default(true),
  branch: text("branch"),
  buildLog: text("build_log"),
  conversationId: text("conversation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Approved slow-loop components (SPEC v1.3): declarative templates rendered
// through the canvas sanitizer with {{signals.*}} interpolation. Inserting a
// row IS hot-registration — registryVersion is monotonic; the runtime never
// imports generated code.
export const dynamicComponents = pgTable("dynamic_components", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  template: text("template").notNull(),
  registryVersion: integer("registry_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Canvas snapshots (SPEC §7.6): every paint is saved — markup + brief +
// timestamp. Provenance applies to pictures too; "show me Tuesday's version"
// must work. Markup is ALWAYS sanitized before it lands here.
export const canvasSnapshots = pgTable("canvas_snapshots", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  brief: text("brief").notNull(),
  markup: text("markup").notNull(),
  // The workspace model: blocks + geometry + theme — the SHELL's state, which
  // it changes with no model call. Nullable because every snapshot painted
  // before this is markup-only; those migrate lazily into a one-block
  // composition on read. `markup` stays the composed rendering and remains
  // authoritative for every existing reader (done-marks, history, restore),
  // so nothing downstream needed to change.
  composition: jsonb("composition"),
  // streaming flag: true while the painter is still appending chunks
  painting: boolean("painting").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The Workspace (docs/workspace/SPEC.md): a board of independent widgets the
// SHELL positions, bound to live data from phase 2 on. Widgets live as jsonb
// because the whole board is read and written as a unit and order matters —
// the same call `canvas_snapshots.composition` makes. One default board per
// user today; the `name`/`is_default` pair is here so named boards need no
// migration.
export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey().$defaultFn(uuid),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Workspace"),
    // { widgets, undo, redo, focusId } — see lib/workspace/types.ts
    board: jsonb("board").notNull().default({ widgets: [], undo: [], redo: [], focusId: null }),
    // Optimistic concurrency: a write that names a stale version is refused
    // rather than silently clobbering a change made on another device.
    version: integer("version").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspaces_user_idx").on(t.userId)]
);

// Durable layout constraints from chat/Settings (SPEC §7.5 tier 1): one row
// per preference, e.g. {kind:"ban_component", component:"people_index"}.
// Injected into every planner call and enforced by the validator; listed and
// removable in Settings so a dislike stated once never re-annoys.
export const layoutPreferences = pgTable("layout_preferences", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind")
    .$type<"ban_component" | "pin_section" | "default_variant_for" | "accent_policy">()
    .notNull(),
  value: jsonb("value").$type<Record<string, string>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Documents: real living documents that belong to projects. Sections are the
// unit of voice work (read/edit one section, never ship a whole doc through a
// realtime session); every mutation snapshots the prior state to
// document_versions so nothing said on a call can permanently destroy writing.
// ---------------------------------------------------------------------------

export type DocSection = { heading: string; content: string };

export const documents = pgTable("documents", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  sections: jsonb("sections").$type<DocSection[]>().notNull().default([]),
  source: itemSource("source").notNull().default("typed"),
  conversationId: text("conversation_id").references(() => conversations.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const documentVersions = pgTable("document_versions", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  documentId: text("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  sections: jsonb("sections").$type<DocSection[]>().notNull().default([]),
  // what edit replaced this state, e.g. 'rewrote "Primary responsibilities"'
  note: text("note"),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usage = pgTable("usage", {
  id: text("id").primaryKey().$defaultFn(uuid),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: usageKind("kind").notNull(),
  model: text("model"),
  seconds: integer("seconds").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  // Realtime charges audio input 8× text input under the SAME model id, so
  // without this split a voice row cannot be priced within a factor of eight.
  audioInputTokens: integer("audio_input_tokens"),
  audioOutputTokens: integer("audio_output_tokens"),
  // Re-read input is a tenth the price; counting it as fresh overstates spend
  // and hides the benefit of caching.
  cachedInputTokens: integer("cached_input_tokens"),
  // Dollars, computed at insert from lib/pricing.ts. Stored rather than
  // derived so a historical row keeps the price that was actually charged when
  // the rate card changes.
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
  /** False when the model had no rate — the cost is a ceiling, not a fact. */
  costEstimated: boolean("cost_estimated").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
