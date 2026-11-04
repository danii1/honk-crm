import { and, asc, desc, eq, inArray, isNull, like, lte, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as s from "./db/schema";
import { CrmError, type OrgContext } from "./context";

export type DB = DrizzleD1Database<typeof s>;
export const createDb = (d1: D1Database): DB => drizzle(d1, { schema: s });

type Contact = typeof s.contacts.$inferSelect;
type Company = typeof s.companies.$inferSelect;

/**
 * The only module that touches CRM tables. It cannot be constructed without an
 * OrgContext, and every query is filtered by (and every insert stamped with)
 * ctx.orgId, so a caller cannot read or write another tenant's rows.
 */
export class Repository {
  readonly orgId: string;
  constructor(
    private db: DB,
    readonly ctx: OrgContext,
  ) {
    if (!ctx?.orgId) throw new CrmError("forbidden", "org context required");
    this.orgId = ctx.orgId;
  }

  // ---- companies
  async companyByDomain(domain: string): Promise<Company | undefined> {
    return this.db.query.companies.findFirst({
      where: and(eq(s.companies.orgId, this.orgId), eq(s.companies.domain, domain)),
    });
  }
  async companyById(id: string) {
    return this.db.query.companies.findFirst({
      where: and(eq(s.companies.orgId, this.orgId), eq(s.companies.id, id)),
    });
  }
  async insertCompany(v: Omit<typeof s.companies.$inferInsert, "orgId" | "id">) {
    const [row] = await this.db.insert(s.companies).values({ ...v, orgId: this.orgId }).returning();
    return row!;
  }
  async updateCompany(id: string, v: Partial<typeof s.companies.$inferInsert>) {
    const [row] = await this.db
      .update(s.companies)
      .set({ ...v, orgId: this.orgId, updatedAt: new Date() })
      .where(and(eq(s.companies.orgId, this.orgId), eq(s.companies.id, id)))
      .returning();
    return row!;
  }

  // ---- contacts
  async contactById(id: string): Promise<Contact | undefined> {
    return this.db.query.contacts.findFirst({
      where: and(eq(s.contacts.orgId, this.orgId), eq(s.contacts.id, id)),
    });
  }
  async contactByEmail(email: string) {
    return this.db.query.contacts.findFirst({
      where: and(eq(s.contacts.orgId, this.orgId), eq(s.contacts.email, email)),
    });
  }
  async contactByLinkedin(linkedin: string) {
    return this.db.query.contacts.findFirst({
      where: and(eq(s.contacts.orgId, this.orgId), eq(s.contacts.linkedin, linkedin)),
    });
  }
  async insertContact(v: Omit<typeof s.contacts.$inferInsert, "orgId" | "id">) {
    const [row] = await this.db.insert(s.contacts).values({ ...v, orgId: this.orgId }).returning();
    return row!;
  }
  async updateContact(id: string, v: Partial<typeof s.contacts.$inferInsert>) {
    const [row] = await this.db
      .update(s.contacts)
      .set({ ...v, orgId: this.orgId, updatedAt: new Date() })
      .where(and(eq(s.contacts.orgId, this.orgId), eq(s.contacts.id, id)))
      .returning();
    if (!row) throw new CrmError("not_found", `contact ${id} not found`);
    return row;
  }
  async searchContacts(q: { query?: string; stage?: s.Stage; companyId?: string; tag?: string; limit: number }) {
    const conds: (SQL | undefined)[] = [eq(s.contacts.orgId, this.orgId)];
    if (q.query) {
      const p = `%${q.query.toLowerCase()}%`;
      conds.push(
        or(
          like(sql`lower(${s.contacts.name})`, p),
          like(s.contacts.email, p),
          like(sql`lower(${s.contacts.title})`, p),
          like(s.contacts.linkedin, p),
          inArray(
            s.contacts.companyId,
            this.db
              .select({ id: s.companies.id })
              .from(s.companies)
              .where(and(eq(s.companies.orgId, this.orgId), or(like(sql`lower(${s.companies.name})`, p), like(s.companies.domain, p)))),
          ),
        ),
      );
    }
    if (q.stage) conds.push(eq(s.contacts.stage, q.stage));
    if (q.companyId) conds.push(eq(s.contacts.companyId, q.companyId));
    if (q.tag) {
      conds.push(
        inArray(
          s.contacts.id,
          this.db
            .select({ id: s.contactTags.contactId })
            .from(s.contactTags)
            .innerJoin(s.tags, eq(s.tags.id, s.contactTags.tagId))
            .where(and(eq(s.contactTags.orgId, this.orgId), eq(s.tags.name, q.tag))),
        ),
      );
    }
    return this.db.select().from(s.contacts).where(and(...conds)).orderBy(desc(s.contacts.updatedAt)).limit(q.limit);
  }
  async stageCounts() {
    return this.db
      .select({ stage: s.contacts.stage, count: sql<number>`count(*)` })
      .from(s.contacts)
      .where(eq(s.contacts.orgId, this.orgId))
      .groupBy(s.contacts.stage);
  }

  // ---- touches
  async insertTouch(v: Omit<typeof s.outreachTouches.$inferInsert, "orgId" | "id">) {
    const [row] = await this.db.insert(s.outreachTouches).values({ ...v, orgId: this.orgId }).returning();
    return row!;
  }
  async touchByExternalId(channel: (typeof s.CHANNELS)[number], externalId: string) {
    return this.db.query.outreachTouches.findFirst({
      where: and(
        eq(s.outreachTouches.orgId, this.orgId),
        eq(s.outreachTouches.channel, channel),
        eq(s.outreachTouches.externalId, externalId),
      ),
    });
  }
  async touchesForContact(contactId: string, limit = 50) {
    return this.db
      .select()
      .from(s.outreachTouches)
      .where(and(eq(s.outreachTouches.orgId, this.orgId), eq(s.outreachTouches.contactId, contactId)))
      .orderBy(desc(s.outreachTouches.createdAt))
      .limit(limit);
  }

  // ---- sequences
  async sequenceById(id: string) {
    return this.db.query.sequences.findFirst({
      where: and(eq(s.sequences.orgId, this.orgId), eq(s.sequences.id, id)),
    });
  }

  // ---- tasks
  async insertTask(v: Omit<typeof s.tasks.$inferInsert, "orgId" | "id">) {
    const [row] = await this.db.insert(s.tasks).values({ ...v, orgId: this.orgId }).returning();
    return row!;
  }
  async taskById(id: string) {
    return this.db.query.tasks.findFirst({ where: and(eq(s.tasks.orgId, this.orgId), eq(s.tasks.id, id)) });
  }
  async completeTask(id: string) {
    const [row] = await this.db
      .update(s.tasks)
      .set({ completedAt: new Date() })
      .where(and(eq(s.tasks.orgId, this.orgId), eq(s.tasks.id, id)))
      .returning();
    return row;
  }
  async openTasksDueBy(before: Date, limit: number) {
    return this.db
      .select({ task: s.tasks, contact: s.contacts })
      .from(s.tasks)
      .leftJoin(s.contacts, and(eq(s.contacts.id, s.tasks.contactId), eq(s.contacts.orgId, this.orgId)))
      .where(and(eq(s.tasks.orgId, this.orgId), isNull(s.tasks.completedAt), lte(s.tasks.dueAt, before)))
      .orderBy(asc(s.tasks.dueAt))
      .limit(limit);
  }
  async openTasksForContact(contactId: string) {
    return this.db
      .select()
      .from(s.tasks)
      .where(and(eq(s.tasks.orgId, this.orgId), eq(s.tasks.contactId, contactId), isNull(s.tasks.completedAt)))
      .orderBy(asc(s.tasks.dueAt));
  }

  // ---- notes & tags
  async insertNote(v: Omit<typeof s.notes.$inferInsert, "orgId" | "id">) {
    const [row] = await this.db.insert(s.notes).values({ ...v, orgId: this.orgId }).returning();
    return row!;
  }
  async notesFor(entityType: "contact" | "company", entityId: string) {
    return this.db
      .select()
      .from(s.notes)
      .where(and(eq(s.notes.orgId, this.orgId), eq(s.notes.entityType, entityType), eq(s.notes.entityId, entityId)))
      .orderBy(desc(s.notes.createdAt));
  }
  async ensureTag(name: string) {
    await this.db.insert(s.tags).values({ orgId: this.orgId, name }).onConflictDoNothing();
    return (await this.db.query.tags.findFirst({ where: and(eq(s.tags.orgId, this.orgId), eq(s.tags.name, name)) }))!;
  }
  async tagContact(contactId: string, tagId: string) {
    await this.db.insert(s.contactTags).values({ orgId: this.orgId, contactId, tagId }).onConflictDoNothing();
  }
  async tagsForContact(contactId: string) {
    const rows = await this.db
      .select({ name: s.tags.name })
      .from(s.contactTags)
      .innerJoin(s.tags, eq(s.tags.id, s.contactTags.tagId))
      .where(and(eq(s.contactTags.orgId, this.orgId), eq(s.contactTags.contactId, contactId)));
    return rows.map((r) => r.name);
  }

  // ---- activity log (append-only: insert + select only)
  async appendActivity(v: {
    action: string;
    entityType: string;
    entityId?: string | null;
    reason?: string | null;
    payload?: unknown;
  }) {
    await this.db.insert(s.activityLog).values({
      orgId: this.orgId,
      actorType: this.ctx.actor.type,
      actorId: this.ctx.actor.id,
      action: v.action,
      entityType: v.entityType,
      entityId: v.entityId ?? null,
      reason: v.reason ?? null,
      payload: v.payload ?? null,
    });
  }
  async activity(q: { entityType?: string; entityId?: string; since?: Date; limit: number }) {
    const conds: SQL[] = [eq(s.activityLog.orgId, this.orgId)];
    if (q.entityType) conds.push(eq(s.activityLog.entityType, q.entityType));
    if (q.entityId) conds.push(eq(s.activityLog.entityId, q.entityId));
    if (q.since) conds.push(sql`${s.activityLog.createdAt} >= ${q.since.getTime()}`);
    return this.db
      .select()
      .from(s.activityLog)
      .where(and(...conds))
      .orderBy(desc(s.activityLog.createdAt), desc(s.activityLog.id))
      .limit(q.limit);
  }

  // ---- idempotency
  async getIdempotency(key: string) {
    return this.db.query.idempotencyKeys.findFirst({
      where: and(eq(s.idempotencyKeys.orgId, this.orgId), eq(s.idempotencyKeys.key, key)),
    });
  }
  async saveIdempotency(key: string, operation: string, requestHash: string, response: unknown) {
    await this.db
      .insert(s.idempotencyKeys)
      .values({ orgId: this.orgId, key, operation, requestHash, response: response as object })
      .onConflictDoNothing();
  }
}
