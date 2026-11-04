import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organization } from "./auth-schema";

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

export const STAGES = ["new", "contacted", "replied", "meeting", "won", "lost"] as const;
export const CHANNELS = ["email", "linkedin", "x", "other"] as const;
export const DIRECTIONS = ["outbound", "inbound"] as const;
export const TOUCH_STATUSES = ["draft", "sent", "replied", "bounced"] as const;
export type Stage = (typeof STAGES)[number];

export const companies = sqliteTable(
  "companies",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    domain: text("domain"), // normalized: lowercase, no www., no scheme
    website: text("website"),
    linkedin: text("linkedin"),
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

export const contacts = sqliteTable(
  "contacts",
  {
    id: id(),
    orgId: orgId(),
    email: text("email"), // normalized: trimmed + lowercase
    name: text("name"),
    title: text("title"),
    linkedin: text("linkedin"),
    x: text("x"),
    companyId: text("company_id").references(() => companies.id, { onDelete: "set null" }),
    sequenceId: text("sequence_id").references(() => sequences.id, { onDelete: "set null" }),
    stage: text("stage", { enum: STAGES }).notNull().default("new"),
    stageChangedAt: integer("stage_changed_at", { mode: "timestamp_ms" }),
    lastTouchAt: integer("last_touch_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("contacts_org_email_uq").on(t.orgId, t.email),
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
    channel: text("channel", { enum: CHANNELS }).notNull(),
    direction: text("direction", { enum: DIRECTIONS }).notNull().default("outbound"),
    status: text("status", { enum: TOUCH_STATUSES }).notNull().default("sent"),
    subject: text("subject"),
    body: text("body"),
    externalId: text("external_id"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    repliedAt: integer("replied_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("touches_org_contact_idx").on(t.orgId, t.contactId),
    uniqueIndex("touches_org_channel_external_uq").on(t.orgId, t.channel, t.externalId),
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
