import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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
});

// A message's id doubles as the provenance anchor: task/event provenance links
// deep-link to the exact message ("from Tuesday's conversation").
export const messages = pgTable("messages", {
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
  // draft → review → submit. Empty = plain single-step task.
  stages: jsonb("stages").$type<{ name: string; done: boolean }[]>().notNull().default([]),
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
  // streaming flag: true while the painter is still appending chunks
  painting: boolean("painting").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
