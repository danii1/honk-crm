import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as s from "./db/schema";
import { CrmError, type OrgContext } from "./context";
import { LEGACY_KINDS, type CustomChannelConfig, type Identity } from "./channels";
import { stagesForLifecycle, type Lifecycle } from "./lifecycle";

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
  /** Legacy identity fields -> generic identities. */
  static legacyIdentities(ids: { email?: string | null; linkedin?: string | null; xHandle?: string | null; redditUser?: string | null; github?: string | null; threadsHandle?: string | null }): Identity[] {
    return LEGACY_KINDS.flatMap((k) => (ids[k.legacyColumn!] ? [{ kind: k.kind, value: ids[k.legacyColumn!]!, scope: "" }] : []));
  }
  /** Rows of contact_identities matching any of the given identities. */
  async identityMatches(list: Identity[]) {
    const t = s.contactIdentities;
    const ors = list.map((i) => and(eq(t.kind, i.kind), eq(t.scope, i.scope ?? ""), eq(t.valueNormalized, i.value))!);
    if (!ors.length) return [];
    const out: (typeof t.$inferSelect)[] = [];
    for (let n = 0; n < ors.length; n += 40) out.push(...(await this.db.select().from(t).where(and(eq(t.orgId, this.orgId), or(...ors.slice(n, n + 40))))));
    return out;
  }
  /** Contacts owning any identity (legacy fields and/or generic identities); backed by contact_identities. */
  async contactsByIdentity(ids: { email?: string | null; linkedin?: string | null; xHandle?: string | null; redditUser?: string | null; github?: string | null; threadsHandle?: string | null }, extra: Identity[] = []) {
    const rows = await this.identityMatches([...Repository.legacyIdentities(ids), ...extra]);
    const contactIds = [...new Set(rows.map((r) => r.contactId))];
    if (!contactIds.length) return [];
    const cs = await this.db.select().from(s.contacts).where(and(eq(s.contacts.orgId, this.orgId), inArray(s.contacts.id, contactIds)));
    return cs.map((c) => Object.assign(c, { matchedKinds: rows.filter((r) => r.contactId === c.id).map((r) => r.kind) }));
  }
  async identitiesFor(contactId: string) {
    const t = s.contactIdentities;
    return this.db.select().from(t).where(and(eq(t.orgId, this.orgId), eq(t.contactId, contactId))).orderBy(asc(t.kind));
  }
  /** Runs an id-batched query in chunks small enough for D1's 100-parameter statement limit. */
  private async inIdChunks<T>(ids: string[], load: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
    const chunks: string[][] = [];
    for (let n = 0; n < ids.length; n += 80) chunks.push(ids.slice(n, n + 80));
    // Chunks are independent; run them concurrently so large pages do not pay one round trip each.
    return (await Promise.all(chunks.map(load))).flat();
  }
  /** Identities for many contacts in one query (list views). */
  async identitiesForMany(contactIds: string[]) {
    if (!contactIds.length) return [];
    const t = s.contactIdentities;
    return this.inIdChunks(contactIds, (chunk) => this.db.select().from(t).where(and(eq(t.orgId, this.orgId), inArray(t.contactId, chunk))).orderBy(asc(t.kind)));
  }
  async allIdentities() {
    return this.db.select().from(s.contactIdentities).where(eq(s.contactIdentities.orgId, this.orgId));
  }
  /** Adds generic identities to a contact; an identity owned by another contact is a conflict. */
  async addIdentities(contactId: string, list: Identity[]) {
    if (!list.length) return [];
    const owners = await this.identityMatches(list);
    const clash = owners.find((o) => o.contactId !== contactId);
    if (clash) throw new CrmError("conflict", `${clash.kind} ${clash.scope ? `${clash.scope}/` : ""}${clash.valueNormalized} already belongs to contact ${clash.contactId}`);
    const have = new Set(owners.map((o) => `${o.kind}|${o.scope}|${o.valueNormalized}`));
    const fresh = list.filter((i, n) => !have.has(`${i.kind}|${i.scope}|${i.value}`) && list.findIndex((j) => j.kind === i.kind && j.scope === i.scope && j.value === i.value) === n);
    if (!fresh.length) return [];
    return this.db.insert(s.contactIdentities).values(fresh.map((i) => ({ orgId: this.orgId, contactId, kind: i.kind, valueNormalized: i.value, scope: i.scope ?? "", raw: i.raw ?? i.value }))).returning();
  }
  async removeIdentity(contactId: string, i: Identity) {
    const t = s.contactIdentities;
    await this.db.delete(t).where(and(eq(t.orgId, this.orgId), eq(t.contactId, contactId), eq(t.kind, i.kind), eq(t.scope, i.scope ?? ""), eq(t.valueNormalized, i.value)));
  }
  /** Mirrors the legacy identity columns of a contact row into contact_identities. */
  private async syncLegacy(c: Contact) {
    const t = s.contactIdentities;
    const want = Repository.legacyIdentities(c);
    const have = (await this.db.select().from(t).where(and(eq(t.orgId, this.orgId), eq(t.contactId, c.id), inArray(t.kind, LEGACY_KINDS.map((k) => k.kind)))));
    const stale = have.filter((h) => !want.some((w) => w.kind === h.kind && w.value === h.valueNormalized));
    if (stale.length) await this.db.delete(t).where(and(eq(t.orgId, this.orgId), inArray(t.id, stale.map((h) => h.id))));
    const add = want.filter((w) => !have.some((h) => h.kind === w.kind && h.valueNormalized === w.value));
    if (add.length) await this.db.insert(t).values(add.map((w) => ({ orgId: this.orgId, contactId: c.id, kind: w.kind, valueNormalized: w.value, scope: "", raw: w.value }))).onConflictDoNothing();
  }
  // ---- custom channels
  async customChannels(): Promise<CustomChannelConfig[]> {
    return this.db.select().from(s.customChannels).where(eq(s.customChannels.orgId, this.orgId)).orderBy(asc(s.customChannels.id));
  }
  async upsertCustomChannel(v: CustomChannelConfig) {
    const [row] = await this.db
      .insert(s.customChannels)
      .values({ ...v, orgId: this.orgId })
      .onConflictDoUpdate({ target: [s.customChannels.orgId, s.customChannels.id], set: { label: v.label, urlPattern: v.urlPattern, prefix: v.prefix, followupDays: v.followupDays, staleDays: v.staleDays } })
      .returning();
    return row!;
  }
  async contactsByDomain(domain: string) {
    const c = s.contacts;
    return this.db
      .select()
      .from(c)
      .where(
        and(
          eq(c.orgId, this.orgId),
          or(
            like(c.email, `%@${domain}`),
            inArray(c.companyId, this.db.select({ id: s.companies.id }).from(s.companies).where(and(eq(s.companies.orgId, this.orgId), eq(s.companies.domain, domain)))),
          ),
        ),
      );
  }
  async allContacts() {
    return this.db.select().from(s.contacts).where(eq(s.contacts.orgId, this.orgId));
  }
  async allCompanies() {
    return this.db.select().from(s.companies).where(eq(s.companies.orgId, this.orgId));
  }
  private companyConds(query?: string) {
    const c = s.companies;
    const conds: (SQL | undefined)[] = [eq(c.orgId, this.orgId)];
    if (query?.trim()) {
      const p = `%${query.trim().toLowerCase()}%`;
      conds.push(or(like(sql`lower(${c.name})`, p), like(c.domain, p), like(c.website, p)));
    }
    return conds;
  }
  async listCompanies(q: { query?: string; limit: number; offset?: number }) {
    const c = s.companies;
    return this.db.select().from(c).where(and(...this.companyConds(q.query))).orderBy(asc(c.name), asc(c.id)).limit(q.limit).offset(q.offset ?? 0);
  }
  async countCompanies(q: { query?: string }) {
    const c = s.companies;
    const [row] = await this.db.select({ count: sql<number>`count(*)` }).from(c).where(and(...this.companyConds(q.query)));
    return Number(row?.count ?? 0);
  }
  /** Contact/lead/relationship counts per company, grouped in SQL for the given page of companies. */
  async contactStageCountsByCompany(companyIds: string[]) {
    const c = s.contacts;
    if (!companyIds.length) return [];
    return this.inIdChunks(companyIds, (chunk) =>
      this.db
        .select({ companyId: c.companyId, stage: c.stage, count: sql<number>`count(*)` })
        .from(c)
        .where(and(eq(c.orgId, this.orgId), inArray(c.companyId, chunk)))
        .groupBy(c.companyId, c.stage),
    );
  }
  async companyByName(name: string) {
    return this.db.query.companies.findFirst({
      where: and(eq(s.companies.orgId, this.orgId), sql`lower(${s.companies.name}) = ${name.trim().toLowerCase()}`),
    });
  }
  private contactConds(q: { stage?: s.Stage; lifecycle?: Lifecycle; source?: string; campaignId?: string; contactType?: string; channel?: s.OutreachChannel; channelStage?: s.Stage; query?: string }, intersectLifecycle = false) {
    const c = s.contacts;
    const conds: (SQL | undefined)[] = [eq(c.orgId, this.orgId)];
    if (q.stage) {
      conds.push(eq(c.stage, q.stage));
      if (intersectLifecycle && q.lifecycle) conds.push(inArray(c.stage, stagesForLifecycle(q.lifecycle)));
    } else if (q.lifecycle) conds.push(inArray(c.stage, stagesForLifecycle(q.lifecycle)));
    if (q.source) conds.push(eq(c.source, q.source as (typeof s.SOURCES)[number]));
    if (q.campaignId) conds.push(eq(c.campaignId, q.campaignId));
    if (q.contactType) conds.push(eq(c.contactType, q.contactType as (typeof s.CONTACT_TYPES)[number]));
    if (q.channel || q.channelStage) {
      const cs = s.channelStates;
      const sub = [eq(cs.orgId, this.orgId), q.channel ? eq(cs.channel, q.channel) : undefined, q.channelStage ? eq(cs.stage, q.channelStage) : undefined];
      conds.push(inArray(c.id, this.db.select({ id: cs.contactId }).from(cs).where(and(...sub))));
    }
    if (q.query?.trim()) {
      const p = `%${q.query.trim().toLowerCase()}%`;
      conds.push(
        or(
          like(sql`lower(${c.name})`, p),
          like(c.email, p),
          like(sql`lower(${c.role})`, p),
          like(c.xHandle, p),
          like(c.github, p),
          like(c.redditUser, p),
          like(c.threadsHandle, p),
          like(c.linkedin, p),
          inArray(
            c.id,
            this.db.select({ id: s.contactIdentities.contactId }).from(s.contactIdentities).where(and(eq(s.contactIdentities.orgId, this.orgId), like(sql`lower(${s.contactIdentities.valueNormalized})`, p))),
          ),
          inArray(
            c.companyId,
            this.db
              .select({ id: s.companies.id })
              .from(s.companies)
              .where(and(eq(s.companies.orgId, this.orgId), or(like(sql`lower(${s.companies.name})`, p), like(s.companies.domain, p)))),
          ),
        ),
      );
    }
    return conds;
  }
  async listContacts(q: { stage?: s.Stage; lifecycle?: Lifecycle; source?: string; campaignId?: string; contactType?: string; channel?: s.OutreachChannel; channelStage?: s.Stage; query?: string; limit: number }, intersectLifecycle = false) {
    return this.db.select().from(s.contacts).where(and(...this.contactConds(q, intersectLifecycle))).orderBy(desc(s.contacts.updatedAt)).limit(q.limit);
  }
  /** Number of contacts matching a list filter (for pagination / "showing N of M"). */
  async countContacts(q: { stage?: s.Stage; lifecycle?: Lifecycle; source?: string; campaignId?: string; contactType?: string; channel?: s.OutreachChannel; channelStage?: s.Stage; query?: string }, intersectLifecycle = true) {
    const [row] = await this.db.select({ count: sql<number>`count(*)` }).from(s.contacts).where(and(...this.contactConds(q, intersectLifecycle)));
    return Number(row?.count ?? 0);
  }
  /** List rows with the data the dashboard needs: company, identities and lifecycle. */
  async listContactsView(q: { stage?: s.Stage; lifecycle?: Lifecycle; source?: string; campaignId?: string; contactType?: string; channel?: s.OutreachChannel; channelStage?: s.Stage; query?: string; limit: number; offset?: number }) {
    const contacts = await this.db
      .select({
        id: s.contacts.id,
        name: s.contacts.name,
        email: s.contacts.email,
        role: s.contacts.role,
        contactType: s.contacts.contactType,
        source: s.contacts.source,
        stage: s.contacts.stage,
        score: s.contacts.score,
        companyId: s.contacts.companyId,
        website: s.contacts.website,
        profileUrl: s.contacts.profileUrl,
        firstSeenAt: s.contacts.firstSeenAt,
        lastTouchAt: s.contacts.lastTouchAt,
        company: s.companies,
      })
      .from(s.contacts)
      .leftJoin(s.companies, and(eq(s.companies.id, s.contacts.companyId), eq(s.companies.orgId, this.orgId)))
      .where(and(...this.contactConds(q, true)))
      .orderBy(desc(s.contacts.updatedAt), asc(s.contacts.id))
      .limit(q.limit)
      .offset(q.offset ?? 0);
    const ids = contacts.map((c) => c.id);
    const [identities, states] = await Promise.all([
      this.identitiesForMany(ids),
      this.inIdChunks(ids, (chunk) => this.db.select({ contactId: s.channelStates.contactId, lastTouchAt: s.channelStates.lastTouchAt }).from(s.channelStates).where(and(eq(s.channelStates.orgId, this.orgId), inArray(s.channelStates.contactId, chunk)))),
    ]);
    const idsBy = new Map<string, (typeof identities)[number][]>();
    for (const r of identities) idsBy.set(r.contactId, [...(idsBy.get(r.contactId) ?? []), r]);
    const channelTouch = new Map<string, Date>();
    for (const st of states) if (st.lastTouchAt && (!channelTouch.has(st.contactId) || channelTouch.get(st.contactId)! < st.lastTouchAt)) channelTouch.set(st.contactId, st.lastTouchAt);
    return contacts.map((c) => ({ ...c, lastTouchAt: c.lastTouchAt ?? channelTouch.get(c.id) ?? null, company: c.companyId ? c.company ?? null : null, identities: idsBy.get(c.id) ?? [] }));
  }
  async contactByLinkedin(linkedin: string) {
    return this.db.query.contacts.findFirst({
      where: and(eq(s.contacts.orgId, this.orgId), eq(s.contacts.linkedin, linkedin)),
    });
  }
  async insertContact(v: Omit<typeof s.contacts.$inferInsert, "orgId" | "id">) {
    const [row] = await this.db.insert(s.contacts).values({ ...v, orgId: this.orgId }).returning();
    await this.syncLegacy(row!);
    return row!;
  }
  async updateContact(id: string, v: Partial<typeof s.contacts.$inferInsert>) {
    const [row] = await this.db
      .update(s.contacts)
      .set({ ...v, orgId: this.orgId, updatedAt: new Date() })
      .where(and(eq(s.contacts.orgId, this.orgId), eq(s.contacts.id, id)))
      .returning();
    if (!row) throw new CrmError("not_found", `contact ${id} not found`);
    if (LEGACY_KINDS.some((k) => (k.legacyColumn as string) in v)) await this.syncLegacy(row);
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
          like(sql`lower(${s.contacts.role})`, p),
          like(s.contacts.xHandle, p),
          like(s.contacts.github, p),
          like(s.contacts.redditUser, p),
          like(s.contacts.threadsHandle, p),
          like(s.contacts.linkedin, p),
          inArray(
            s.contacts.id,
            this.db.select({ id: s.contactIdentities.contactId }).from(s.contactIdentities).where(and(eq(s.contactIdentities.orgId, this.orgId), like(sql`lower(${s.contactIdentities.valueNormalized})`, p))),
          ),
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
  async stageCounts(q: { stage?: s.Stage; lifecycle?: Lifecycle; source?: string; campaignId?: string; contactType?: string; channel?: s.OutreachChannel; channelStage?: s.Stage; query?: string } = {}) {
    return this.db
      .select({ stage: s.contacts.stage, count: sql<number>`count(*)` })
      .from(s.contacts)
      .where(and(...this.contactConds(q, true)))
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

  // ---- channel states
  async channelState(contactId: string, channel: s.OutreachChannel) {
    return this.db.query.channelStates.findFirst({
      where: and(eq(s.channelStates.orgId, this.orgId), eq(s.channelStates.contactId, contactId), eq(s.channelStates.channel, channel)),
    });
  }
  async channelStatesFor(contactId: string) {
    return this.db.select().from(s.channelStates).where(and(eq(s.channelStates.orgId, this.orgId), eq(s.channelStates.contactId, contactId)));
  }
  async allChannelStates() {
    return this.db.select().from(s.channelStates).where(eq(s.channelStates.orgId, this.orgId));
  }
  async upsertChannelState(contactId: string, channel: s.OutreachChannel, v: Partial<Pick<typeof s.channelStates.$inferInsert, "stage" | "lastTouchAt" | "nextFollowupAt" | "nextStep">>) {
    const [row] = await this.db
      .insert(s.channelStates)
      .values({ orgId: this.orgId, contactId, channel, ...v })
      .onConflictDoUpdate({ target: [s.channelStates.orgId, s.channelStates.contactId, s.channelStates.channel], set: { ...v, updatedAt: new Date() } })
      .returning();
    return row!;
  }
  async followupsDueBefore(before: Date, limit: number) {
    const cs = s.channelStates;
    return this.db
      .select({ state: cs, contact: s.contacts })
      .from(cs)
      .innerJoin(s.contacts, and(eq(s.contacts.id, cs.contactId), eq(s.contacts.orgId, this.orgId)))
      .where(and(eq(cs.orgId, this.orgId), isNotNull(cs.nextFollowupAt), lt(cs.nextFollowupAt, before), sql`${cs.stage} not in ('lost','do_not_contact','paying')`))
      .orderBy(asc(cs.nextFollowupAt))
      .limit(limit);
  }
  async staleStates(before: Date, stages: s.Stage[], limit: number) {
    const cs = s.channelStates;
    return this.db
      .select({ state: cs, contact: s.contacts })
      .from(cs)
      .innerJoin(s.contacts, and(eq(s.contacts.id, cs.contactId), eq(s.contacts.orgId, this.orgId)))
      .where(and(eq(cs.orgId, this.orgId), inArray(cs.stage, stages), isNotNull(cs.lastTouchAt), lt(cs.lastTouchAt, before)))
      .orderBy(asc(cs.lastTouchAt))
      .limit(limit);
  }
  async statesByChannelStage(channel: s.OutreachChannel, stages: s.Stage[]) {
    const cs = s.channelStates;
    return this.db
      .select({ state: cs, contact: s.contacts })
      .from(cs)
      .innerJoin(s.contacts, and(eq(s.contacts.id, cs.contactId), eq(s.contacts.orgId, this.orgId)))
      .where(and(eq(cs.orgId, this.orgId), eq(cs.channel, channel), inArray(cs.stage, stages)));
  }
  async outboundTouchContactIds(channel: (typeof s.CHANNELS)[number]) {
    const t = s.outreachTouches;
    const rows = await this.db
      .selectDistinct({ id: t.contactId })
      .from(t)
      .where(and(eq(t.orgId, this.orgId), eq(t.channel, channel), eq(t.direction, "outbound"), ne(t.status, "draft")));
    return new Set(rows.map((r) => r.id));
  }
  async touchesSince(channel: (typeof s.CHANNELS)[number], since: Date) {
    const t = s.outreachTouches;
    return this.db
      .select()
      .from(t)
      .where(and(eq(t.orgId, this.orgId), eq(t.channel, channel), eq(t.direction, "outbound"), eq(t.status, "sent"), gte(t.sentAt, since)))
      .orderBy(desc(t.sentAt));
  }
  async lastSentTouch(channel: (typeof s.CHANNELS)[number]) {
    const t = s.outreachTouches;
    const [row] = await this.db
      .select()
      .from(t)
      .where(and(eq(t.orgId, this.orgId), eq(t.channel, channel), eq(t.direction, "outbound"), eq(t.status, "sent"), isNotNull(t.sentAt)))
      .orderBy(desc(t.sentAt))
      .limit(1);
    return row;
  }
  async allTouches() {
    return this.db.select().from(s.outreachTouches).where(eq(s.outreachTouches.orgId, this.orgId));
  }

  // ---- blocklist
  async blocklistAll() {
    return this.db.select().from(s.blocklist).where(eq(s.blocklist.orgId, this.orgId)).orderBy(asc(s.blocklist.kind), asc(s.blocklist.value));
  }
  async insertBlock(kind: (typeof s.BLOCK_KINDS)[number], value: string, label?: string | null, match: (typeof s.MATCH_MODES)[number] = "fuzzy", displayName?: string | null) {
    await this.db.insert(s.blocklist).values({ orgId: this.orgId, kind, value, label, match, displayName }).onConflictDoNothing();
    return (await this.db.query.blocklist.findFirst({
      where: and(eq(s.blocklist.orgId, this.orgId), eq(s.blocklist.kind, kind), eq(s.blocklist.value, value)),
    }))!;
  }
  async blockById(id: string) {
    return this.db.query.blocklist.findFirst({ where: and(eq(s.blocklist.orgId, this.orgId), eq(s.blocklist.id, id)) });
  }
  async updateBlock(id: string, patch: Partial<{ value: string; label: string | null; displayName: string | null; match: (typeof s.MATCH_MODES)[number] }>) {
    const rows = await this.db.update(s.blocklist).set(patch).where(and(eq(s.blocklist.orgId, this.orgId), eq(s.blocklist.id, id))).returning();
    return rows[0];
  }
  async deleteBlock(id: string) {
    const rows = await this.db.delete(s.blocklist).where(and(eq(s.blocklist.orgId, this.orgId), eq(s.blocklist.id, id))).returning();
    return rows[0];
  }

  // ---- campaigns
  async campaignById(id: string) {
    return this.db.query.campaigns.findFirst({ where: and(eq(s.campaigns.orgId, this.orgId), eq(s.campaigns.id, id)) });
  }
  async campaignByName(name: string) {
    return this.db.query.campaigns.findFirst({ where: and(eq(s.campaigns.orgId, this.orgId), eq(s.campaigns.name, name)) });
  }
  async insertCampaign(v: { name: string; offerText?: string | null; status?: "active" | "paused" | "archived" }) {
    const [row] = await this.db.insert(s.campaigns).values({ ...v, orgId: this.orgId }).returning();
    return row!;
  }
  async updateCampaign(id: string, v: Partial<typeof s.campaigns.$inferInsert>) {
    const [row] = await this.db
      .update(s.campaigns)
      .set({ ...v, orgId: this.orgId, updatedAt: new Date() })
      .where(and(eq(s.campaigns.orgId, this.orgId), eq(s.campaigns.id, id)))
      .returning();
    return row!;
  }
  async listCampaigns() {
    return this.db.select().from(s.campaigns).where(eq(s.campaigns.orgId, this.orgId)).orderBy(asc(s.campaigns.name));
  }

  // ---- drafts
  async insertDraft(v: Omit<typeof s.drafts.$inferInsert, "orgId" | "id">) {
    const [row] = await this.db.insert(s.drafts).values({ ...v, orgId: this.orgId }).returning();
    return row!;
  }
  async draftById(id: string) {
    return this.db.query.drafts.findFirst({ where: and(eq(s.drafts.orgId, this.orgId), eq(s.drafts.id, id)) });
  }
  async updateDraft(id: string, v: Partial<typeof s.drafts.$inferInsert>) {
    const [row] = await this.db
      .update(s.drafts)
      .set({ ...v, orgId: this.orgId, updatedAt: new Date() })
      .where(and(eq(s.drafts.orgId, this.orgId), eq(s.drafts.id, id)))
      .returning();
    return row!;
  }
  async listDrafts(q: { state?: s.DraftState; channel?: s.OutreachChannel; contactId?: string; campaignId?: string; limit: number }) {
    const d = s.drafts;
    const conds = [
      eq(d.orgId, this.orgId),
      q.state ? eq(d.state, q.state) : undefined,
      q.channel ? eq(d.channel, q.channel) : undefined,
      q.contactId ? eq(d.contactId, q.contactId) : undefined,
      q.campaignId ? eq(d.campaignId, q.campaignId) : undefined,
    ];
    return this.db.select().from(d).where(and(...conds)).orderBy(desc(d.createdAt)).limit(q.limit);
  }
  async draftsCreatedSince(channel: s.OutreachChannel, since: Date) {
    const d = s.drafts;
    return this.db.select().from(d).where(and(eq(d.orgId, this.orgId), eq(d.channel, channel), gte(d.createdAt, since)));
  }
  async sentDraftContactIds(channel: s.OutreachChannel) {
    const d = s.drafts;
    const rows = await this.db.selectDistinct({ id: d.contactId }).from(d).where(and(eq(d.orgId, this.orgId), eq(d.channel, channel), eq(d.state, "sent")));
    return new Set(rows.map((r) => r.id));
  }

  // ---- automation: draft lookup, events, threads, settings
  async draftsByIntentUrl(url: string) {
    const d = s.drafts;
    return this.db.select().from(d).where(and(eq(d.orgId, this.orgId), eq(d.intentUrl, url))).orderBy(desc(d.createdAt));
  }
  /** Drafts whose sent external id equals `id`, or whose intent URL mentions it (e.g. in_reply_to=<tweet id>). */
  async draftsByExternalRef(id: string) {
    const d = s.drafts;
    return this.db
      .select()
      .from(d)
      .where(and(eq(d.orgId, this.orgId), or(eq(d.externalId, id), eq(d.threadId, id), like(d.intentUrl, `%${id.replace(/[%_]/g, "")}%`))))
      .orderBy(desc(d.createdAt));
  }
  async allDrafts() {
    return this.db.select().from(s.drafts).where(eq(s.drafts.orgId, this.orgId));
  }
  async eventByKey(channel: s.OutreachChannel, type: s.EventType, externalId: string) {
    const e = s.events;
    return this.db.query.events.findFirst({ where: and(eq(e.orgId, this.orgId), eq(e.channel, channel), eq(e.type, type), eq(e.externalId, externalId)) });
  }
  async insertEvent(v: Omit<typeof s.events.$inferInsert, "orgId" | "id">) {
    const [row] = await this.db.insert(s.events).values({ ...v, orgId: this.orgId }).returning();
    return row!;
  }
  async eventsSince(since: Date) {
    const e = s.events;
    return this.db.select().from(e).where(and(eq(e.orgId, this.orgId), gte(e.occurredAt, since))).orderBy(desc(e.occurredAt));
  }
  async eventsForContact(contactId: string, limit = 100) {
    const e = s.events;
    return this.db.select().from(e).where(and(eq(e.orgId, this.orgId), eq(e.contactId, contactId))).orderBy(desc(e.occurredAt)).limit(limit);
  }
  /** Contact ids that own a thread on a channel, via touches, drafts or events (newest first). */
  async contactIdsByThread(channel: s.OutreachChannel, threadId: string) {
    const t = s.outreachTouches, d = s.drafts, e = s.events;
    const [a, b, c] = await Promise.all([
      this.db.select({ id: t.contactId, at: t.createdAt, src: sql<string>`'touch'` }).from(t).where(and(eq(t.orgId, this.orgId), eq(t.channel, channel), or(eq(t.threadId, threadId), eq(t.externalId, threadId)))),
      this.db.select({ id: d.contactId, at: d.createdAt, src: sql<string>`'draft'` }).from(d).where(and(eq(d.orgId, this.orgId), eq(d.channel, channel), or(eq(d.threadId, threadId), eq(d.externalId, threadId)))),
      this.db.select({ id: e.contactId, at: e.createdAt, src: sql<string>`'event'` }).from(e).where(and(eq(e.orgId, this.orgId), eq(e.channel, channel), or(eq(e.threadId, threadId), eq(e.externalId, threadId)))),
    ]);
    return [...a, ...b, ...c].toSorted((x, y) => y.at.getTime() - x.at.getTime());
  }
  async getSettings() {
    return this.db.query.orgSettings.findFirst({ where: eq(s.orgSettings.orgId, this.orgId) });
  }
  async setFollowupRules(rules: NonNullable<(typeof s.orgSettings.$inferInsert)["followupRules"]>) {
    await this.db
      .insert(s.orgSettings)
      .values({ orgId: this.orgId, followupRules: rules })
      .onConflictDoUpdate({ target: s.orgSettings.orgId, set: { followupRules: rules, updatedAt: new Date() } });
    return (await this.getSettings())!;
  }
  async setGoals(goals: NonNullable<(typeof s.orgSettings.$inferInsert)["goals"]>) {
    await this.db
      .insert(s.orgSettings)
      .values({ orgId: this.orgId, goals })
      .onConflictDoUpdate({ target: s.orgSettings.orgId, set: { goals, updatedAt: new Date() } });
    return (await this.getSettings())!;
  }
  /** Latest occurrence per contact of an event type on a channel. */
  async eventTimes(channel: s.OutreachChannel, type: s.EventType) {
    const e = s.events;
    const rows = await this.db.select({ id: e.contactId, at: e.occurredAt }).from(e).where(and(eq(e.orgId, this.orgId), eq(e.channel, channel), eq(e.type, type)));
    const m = new Map<string, Date>();
    for (const r of rows) if (!m.has(r.id) || m.get(r.id)! < r.at) m.set(r.id, r.at);
    return m;
  }
  /** Send times per contact from outbound sent touches and sent drafts on a channel. */
  async outboundSends(channel: s.OutreachChannel) {
    const t = s.outreachTouches, d = s.drafts;
    const [a, b] = await Promise.all([
      this.db.select({ id: t.contactId, at: t.sentAt }).from(t).where(and(eq(t.orgId, this.orgId), eq(t.channel, channel), eq(t.direction, "outbound"), eq(t.status, "sent"))),
      this.db.select({ id: d.contactId, at: d.sentAt }).from(d).where(and(eq(d.orgId, this.orgId), eq(d.channel, channel), eq(d.state, "sent"))),
    ]);
    const m = new Map<string, Date[]>();
    for (const r of [...a, ...b]) if (r.at) m.set(r.id, [...(m.get(r.id) ?? []), r.at]);
    return m;
  }
}
