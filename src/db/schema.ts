import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organization } from "./auth-schema";
import { BUILTIN_CHANNELS, EXTRA_SOURCES } from "../channels";
import { STAGES, type Stage } from "../lifecycle";

export { STAGES, type Stage };

export * from "./auth-schema";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const orgId = () =>
  text("org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`);
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`);

/** Channels with per-contact state. */
/** Built-in channel ids from the registry (src/channels.ts); org custom channels are added at runtime. Not DB enums. */
export const OUTREACH_CHANNELS: readonly string[] = BUILTIN_CHANNELS.map((c) => c.id);
export const CHANNELS: readonly string[] = [...OUTREACH_CHANNELS, "other"];
export const SOURCES: readonly string[] = [...OUTREACH_CHANNELS, ...EXTRA_SOURCES];
export const MATCH_MODES = ["exact", "fuzzy"] as const;
export const CONTACT_TYPES = ["lead", "competitor"] as const;
export const DRAFT_STATES = ["drafted", "approved", "sent", "discarded"] as const;
export const BLOCK_KINDS = ["name", "handle", "domain"] as const;
export type OutreachChannel = string;
export type DraftState = (typeof DRAFT_STATES)[number];
export const DIRECTIONS = ["outbound", "inbound"] as const;
export const TOUCH_STATUSES = ["draft", "sent", "replied", "bounced"] as const;
export const companies = sqliteTable(
  "companies",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    domain: text("domain"), // normalized: lowercase, no www., no scheme
    website: text("website"),
    linkedin: text("linkedin"),
    teamSize: integer("team_size"),
    stack: text("stack", { mode: "json" }).$type<string[]>(),
    type: text("type"), // agency | startup | enterprise | ...
    publishedEmail: text("published_email"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("companies_org_domain_uq").on(t.orgId, t.domain)],
);

export const sequences = sqliteTable(
  "sequences",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["active", "paused", "archived"] }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("sequences_org_name_uq").on(t.orgId, t.name)],
);

export const campaigns = sqliteTable(
  "campaigns",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    offerText: text("offer_text"),
    status: text("status", { enum: ["active", "paused", "archived"] }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("campaigns_org_name_uq").on(t.orgId, t.name)],
);

export const contacts = sqliteTable(
  "contacts",
  {
    id: id(),
    orgId: orgId(),
    email: text("email"), // normalized: trimmed + lowercase
    name: text("name"),
    role: text("title"),
    linkedin: text("linkedin"), // normalized: linkedin.com/in/<slug>
    xHandle: text("x"), // normalized: lowercase, no @
    redditUser: text("reddit_user"), // normalized: lowercase, no u/
    github: text("github"), // normalized: lowercase login
    threadsHandle: text("threads_handle"), // normalized: lowercase, no @ (threads.net / threads.com)
    companyId: text("company_id").references(() => companies.id, { onDelete: "set null" }),
    sequenceId: text("sequence_id").references(() => sequences.id, { onDelete: "set null" }),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    contactType: text("contact_type", { enum: CONTACT_TYPES }).notNull().default("lead"),
    source: text("source"),
    sourceDetail: text("source_detail"), // raw source value from imports
    profileUrl: text("profile_url"), // raw profile_url as imported/provided
    website: text("website"), // personal/company site when profile_url is not a social profile
    bioSummary: text("bio_summary"),
    followers: integer("followers"),
    estTeamSize: integer("est_team_size"),
    estTeamSizeText: text("est_team_size_text"), // raw text when not a plain number
    score: integer("score"),
    scoreOriginal: text("score_original"), // pre-rescale value (e.g. 1-10 scale)
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }),
    notesText: text("notes"),
    signalPostUrl: text("signal_post_url"),
    signalDate: text("signal_date"),
    signalSummary: text("signal_summary"),
    stage: text("stage", { enum: STAGES }).notNull().default("new"),
    stageChangedAt: integer("stage_changed_at", { mode: "timestamp_ms" }),
    lastTouchAt: integer("last_touch_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("contacts_org_email_uq").on(t.orgId, t.email),
    uniqueIndex("contacts_org_linkedin_uq").on(t.orgId, t.linkedin),
    uniqueIndex("contacts_org_x_uq").on(t.orgId, t.xHandle),
    uniqueIndex("contacts_org_reddit_uq").on(t.orgId, t.redditUser),
    uniqueIndex("contacts_org_github_uq").on(t.orgId, t.github),
    uniqueIndex("contacts_org_threads_uq").on(t.orgId, t.threadsHandle),
    index("contacts_org_source_idx").on(t.orgId, t.source),
    index("contacts_org_campaign_idx").on(t.orgId, t.campaignId),
    index("contacts_org_company_idx").on(t.orgId, t.companyId),
    index("contacts_org_stage_idx").on(t.orgId, t.stage),
  ],
);

export const outreachTouches = sqliteTable(
  "outreach_touches",
  {
    id: id(),
    orgId: orgId(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    sequenceId: text("sequence_id").references(() => sequences.id, { onDelete: "set null" }),
    channel: text("channel").notNull(),
    direction: text("direction", { enum: DIRECTIONS }).notNull().default("outbound"),
    status: text("status", { enum: TOUCH_STATUSES }).notNull().default("sent"),
    subject: text("subject"),
    body: text("body"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    threadId: text("thread_id"), // tweet conversation/status id, gmail threadId, reddit post id
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    repliedAt: integer("replied_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("touches_org_contact_idx").on(t.orgId, t.contactId),
    uniqueIndex("touches_org_channel_external_uq").on(t.orgId, t.channel, t.externalId),
    index("touches_org_channel_thread_idx").on(t.orgId, t.channel, t.threadId),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: id(),
    orgId: orgId(),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    dueAt: integer("due_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    assignee: text("assignee"),
    createdAt: createdAt(),
  },
  (t) => [index("tasks_org_due_idx").on(t.orgId, t.completedAt, t.dueAt)],
);

export const notes = sqliteTable(
  "notes",
  {
    id: id(),
    orgId: orgId(),
    entityType: text("entity_type", { enum: ["contact", "company"] }).notNull(),
    entityId: text("entity_id").notNull(),
    body: text("body").notNull(),
    author: text("author").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("notes_org_entity_idx").on(t.orgId, t.entityType, t.entityId)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("tags_org_name_uq").on(t.orgId, t.name)],
);

export const contactTags = sqliteTable(
  "contact_tags",
  {
    orgId: orgId(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.tagId] })],
);

/** Append-only. The repository layer exposes no update/delete for this table. */
export const activityLog = sqliteTable(
  "activity_log",
  {
    id: id(),
    orgId: orgId(),
    actorType: text("actor_type", { enum: ["user", "agent"] }).notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    reason: text("reason"),
    payload: text("payload", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("activity_org_created_idx").on(t.orgId, t.createdAt),
    index("activity_org_entity_idx").on(t.orgId, t.entityType, t.entityId),
  ],
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    orgId: orgId(),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    response: text("response", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })],
);

/** Per-contact, per-channel pipeline state; next_followup_at doubles as the reminder. */
export const channelStates = sqliteTable(
  "channel_states",
  {
    id: id(),
    orgId: orgId(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    stage: text("stage", { enum: STAGES }).notNull().default("new"),
    lastTouchAt: integer("last_touch_at", { mode: "timestamp_ms" }),
    nextFollowupAt: integer("next_followup_at", { mode: "timestamp_ms" }),
    nextStep: text("next_step"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("channel_states_org_contact_channel_uq").on(t.orgId, t.contactId, t.channel),
    index("channel_states_org_followup_idx").on(t.orgId, t.nextFollowupAt),
    index("channel_states_org_channel_stage_idx").on(t.orgId, t.channel, t.stage),
  ],
);

/** Competitors we must never pitch. value is normalized per kind. */
export const blocklist = sqliteTable(
  "blocklist",
  {
    id: id(),
    orgId: orgId(),
    kind: text("kind", { enum: BLOCK_KINDS }).notNull(),
    value: text("value").notNull(),
    label: text("label"),
    /** Full name as given (e.g. "Orchestrator.inc"); value is the normalized matching key. */
    displayName: text("display_name"),
    match: text("match", { enum: MATCH_MODES }).notNull().default("fuzzy"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("blocklist_org_kind_value_uq").on(t.orgId, t.kind, t.value)],
);

/** Message drafts. The CRM never sends; agents mark a draft sent after sending it themselves. */
export const drafts = sqliteTable(
  "drafts",
  {
    id: id(),
    orgId: orgId(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    campaignId: text("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    intentUrl: text("intent_url"),
    state: text("state", { enum: DRAFT_STATES }).notNull().default("drafted"),
    stateChangedAt: integer("state_changed_at", { mode: "timestamp_ms" }),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    externalId: text("external_id"), // id of the sent message (tweet id, gmail message id...)
    externalUrl: text("external_url"),
    threadId: text("thread_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("drafts_org_channel_thread_idx").on(t.orgId, t.channel, t.threadId),
    index("drafts_org_external_idx").on(t.orgId, t.externalId),
    index("drafts_org_state_idx").on(t.orgId, t.state),
    index("drafts_org_contact_idx").on(t.orgId, t.contactId),
    index("drafts_org_channel_created_idx").on(t.orgId, t.channel, t.createdAt),
  ],
);

export const EVENT_TYPES = ["reply_received", "connection_accepted", "email_reply", "meeting_booked", "connection_requested"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Inbound/outbound pipeline events from automation; deduped per org+channel+type+external_id. */
export const events = sqliteTable(
  "events",
  {
    id: id(),
    orgId: orgId(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    type: text("type", { enum: EVENT_TYPES }).notNull(),
    externalId: text("external_id").notNull(),
    threadId: text("thread_id"),
    summary: text("summary"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("events_org_channel_type_external_uq").on(t.orgId, t.channel, t.type, t.externalId),
    index("events_org_channel_thread_idx").on(t.orgId, t.channel, t.threadId),
    index("events_org_occurred_idx").on(t.orgId, t.occurredAt),
  ],
);

/** Per-org settings. */
export const orgSettings = sqliteTable("org_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  followupRules: text("followup_rules", { mode: "json" }).$type<{ followup_days?: Partial<Record<OutreachChannel, number>>; stale_days?: Partial<Record<OutreachChannel, number>> }>(),
  goals: text("goals", { mode: "json" }).$type<{ targets: { stage: Stage; count: number }[]; deadline?: string }>(),
  updatedAt: updatedAt(),
});

/** Generic identities (source of truth for dedupe/lookup). Legacy contacts columns are mirrored here. */
export const contactIdentities = sqliteTable(
  "contact_identities",
  {
    id: id(),
    orgId: orgId(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    valueNormalized: text("value_normalized").notNull(),
    scope: text("scope").notNull().default(""),
    raw: text("raw"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("contact_identities_uq").on(t.orgId, t.kind, t.scope, t.valueNormalized),
    index("contact_identities_contact_idx").on(t.orgId, t.contactId),
    index("contact_identities_value_idx").on(t.orgId, t.valueNormalized),
  ],
);

/** Org-defined channels added at runtime (no migration needed). */
export const customChannels = sqliteTable(
  "custom_channels",
  {
    orgId: orgId(),
    id: text("id").notNull(),
    label: text("label").notNull(),
    urlPattern: text("url_pattern"),
    prefix: text("prefix"),
    followupDays: integer("followup_days"),
    staleDays: integer("stale_days"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.id] })],
);
