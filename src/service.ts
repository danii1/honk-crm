import { z } from "zod";
import { BLOCK_KINDS, CHANNELS, CONTACT_TYPES, DIRECTIONS, DRAFT_STATES, OUTREACH_CHANNELS, SOURCES, STAGES, TOUCH_STATUSES, type OutreachChannel, type Stage } from "./db/schema";
import { CrmError, requireRole, requireScope, type OrgContext } from "./context";
import {
  companyDomainFromEmail, endOfLocalDay, localDateString, normalizeDomain, normalizeEmail, normalizeGithub, normalizeLinkedin,
  isRedditRef, normalizeName, normalizeRedditUser, normalizeUrl, normalizeXHandle, sha256, similarNames, startOfLocalDay,
} from "./normalize";
import { advance, defaultMatchMode, DRAFT_TRANSITIONS, matchBlocklist, normalizeBlockValue, normalizeHandle, rank, rollup, type Probe } from "./rules";
import { extractIdentities, mapStatus, parseCsvObjects, toCsv } from "./csv";
import { Repository, type DB } from "./repository";

// ---------- input schemas (shared by MCP tools and REST routes)
const idem = z.string().min(8).max(200).optional().describe("Idempotency key; retries with the same key return the original result");
const reasonField = z.string().max(2000).optional().describe("Why the agent is doing this; stored in the activity log");
// Plain ISO strings (not z.date) so the schema converts to JSON Schema for MCP.
const date = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "expected an ISO 8601 date/time").describe("ISO 8601 date/time");
const toDate = (v: string | undefined) => (v === undefined ? undefined : new Date(v));

export const schemas = {
  search_contacts: z.object({
    query: z.string().optional().describe("Matches name, email, title, linkedin, company name/domain"),
    stage: z.enum(STAGES).optional(),
    company_id: z.string().optional(),
    tag: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(25),
  }),
  get_contact: z.object({ id: z.string() }),
  upsert_contact: z.object({
    email: z.string().optional(),
    name: z.string().optional(),
    role: z.string().optional(),
    title: z.string().optional().describe("Alias of role"),
    linkedin_url: z.string().optional(),
    linkedin: z.string().optional().describe("Alias of linkedin_url"),
    x_handle: z.string().optional().describe("@handle or x.com URL"),
    x: z.string().optional().describe("Alias of x_handle"),
    reddit_user: z.string().optional().describe("u/name or reddit.com/user URL"),
    github: z.string().optional().describe("login or github.com URL"),
    campaign_id: z.string().optional(),
    contact_type: z.enum(CONTACT_TYPES).optional().describe("lead (default) or competitor. Leads matching the competitor blocklist are rejected."),
    source: z.enum(SOURCES).optional(),
    bio_summary: z.string().optional(),
    followers: z.number().int().min(0).optional(),
    est_team_size: z.number().int().min(0).optional(),
    score: z.number().int().min(1).max(5).optional(),
    first_seen: date.optional(),
    notes: z.string().optional().describe("Free-text notes field on the contact (see add_note for timestamped notes)"),
    signal_post_url: z.string().optional(),
    signal_date: z.string().optional(),
    signal_summary: z.string().optional(),
    stage: z.enum(STAGES).optional().describe("Overall stage; only moves forward unless set via update_stage"),
    company_id: z.string().optional(),
    company_domain: z.string().optional().describe("Defaults to the email's domain unless it is a free-mail provider"),
    company_name: z.string().optional(),
    sequence_id: z.string().optional(),
    tags: z.array(z.string()).optional(),
    idempotency_key: idem,
    reason: reasonField,
  }),
  upsert_company: z.object({
    domain: z.string(),
    name: z.string().optional(),
    website: z.string().optional(),
    linkedin: z.string().optional(),
    team_size: z.number().int().min(0).optional(),
    stack: z.array(z.string()).optional(),
    type: z.string().optional().describe("agency | startup | enterprise | ..."),
    published_email: z.string().optional(),
    idempotency_key: idem,
    reason: reasonField,
  }),
  log_touch: z.object({
    contact_id: z.string(),
    channel: z.enum(CHANNELS),
    direction: z.enum(DIRECTIONS).default("outbound"),
    status: z.enum(TOUCH_STATUSES).default("sent"),
    subject: z.string().optional(),
    body: z.string().optional(),
    external_id: z.string().optional().describe("Message id in the sending system; deduped per org+channel"),
    sequence_id: z.string().optional(),
    sent_at: date.optional(),
    follow_up_in_days: z.number().min(0).max(365).optional().describe("Also create a follow-up task"),
    next_followup_at: date.optional().describe("Set the channel's next_followup_at"),
    idempotency_key: idem,
    reason: reasonField,
  }),
  update_stage: z.object({ contact_id: z.string(), stage: z.enum(STAGES), idempotency_key: idem, reason: reasonField }),
  list_due_followups: z.object({
    before: date.optional().describe("Defaults to now"),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  create_task: z.object({
    title: z.string().min(1),
    contact_id: z.string().optional(),
    due_at: date.optional(),
    assignee: z.string().optional(),
    idempotency_key: idem,
    reason: reasonField,
  }),
  complete_task: z.object({ id: z.string(), idempotency_key: idem, reason: reasonField }),
  add_note: z.object({
    entity_type: z.enum(["contact", "company"]).default("contact"),
    entity_id: z.string(),
    body: z.string().min(1),
    idempotency_key: idem,
    reason: reasonField,
  }),
  get_activity: z.object({
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    since: date.optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  pipeline_summary: z.object({}),

  // ---------- Sales Outbound
  find_existing: z.object({
    identity: z.string().optional().describe("Any handle/URL/email; tried as every identity type"),
    email: z.string().optional(),
    x_handle: z.string().optional(),
    linkedin_url: z.string().optional(),
    reddit_user: z.string().optional(),
    github: z.string().optional(),
    domain: z.string().optional().describe("Company domain or website"),
    name: z.string().optional(),
    company: z.string().optional().describe("Company name for fuzzy name+company matching"),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  is_competitor: z.object({
    name: z.string().optional(),
    company: z.string().optional(),
    handle: z.string().optional(),
    domain: z.string().optional(),
    email: z.string().optional(),
    contact_id: z.string().optional().describe("Check an existing contact (identities + company)"),
  }),
  add_competitor: z.object({
    value: z.string().min(1).describe("Company name, handle/profile URL, or domain"),
    kind: z.enum(BLOCK_KINDS).optional().describe("Inferred when omitted"),
    label: z.string().optional().describe("e.g. the competitor's product name"),
    match: z.enum(["exact", "fuzzy"]).optional().describe("Name entries: exact = only the exact full company name; fuzzy = whole-word match inside company names and exact person names. Default exact for single words of <=7 chars, else fuzzy"),
    idempotency_key: idem,
    reason: reasonField,
  }),
  remove_competitor: z.object({ id: z.string(), idempotency_key: idem, reason: reasonField }),
  list_competitors: z.object({}),
  purge_competitors: z.object({
    ids: z.array(z.string()).optional().describe("Entry ids to delete"),
    value_regex: z.string().optional().describe("Case-insensitive regex matched against the normalized value (e.g. ^u [a-z0-9_-]+$)"),
    kind: z.enum(BLOCK_KINDS).optional(),
    dry_run: z.boolean().default(true).describe("Default true: only list what would be deleted"),
    idempotency_key: idem,
    reason: reasonField,
  }),
  set_channel_state: z.object({
    contact_id: z.string(),
    channel: z.enum(OUTREACH_CHANNELS),
    stage: z.enum(STAGES).optional().describe("Set exactly (may move backwards). Omit to keep."),
    last_touch_at: date.optional(),
    next_followup_at: date.nullable().optional().describe("null clears the reminder"),
    next_step: z.string().nullable().optional(),
    idempotency_key: idem,
    reason: reasonField,
  }),
  create_draft: z.object({
    contact_id: z.string(),
    channel: z.enum(OUTREACH_CHANNELS),
    text: z.string().min(1),
    intent_url: z.string().optional().describe("e.g. an x.com/intent URL the human clicks to send"),
    campaign_id: z.string().optional().describe("Defaults to the contact's campaign"),
    idempotency_key: idem,
    reason: reasonField,
  }),
  transition_draft: z.object({
    draft_id: z.string(),
    to: z.enum(DRAFT_STATES).describe("drafted->approved|discarded|drafted(edit), approved->sent|discarded|drafted. sent/discarded are final."),
    text: z.string().min(1).optional().describe("New text; only when moving to drafted"),
    intent_url: z.string().optional(),
    external_id: z.string().optional().describe("When to=sent: id/URL of the sent message"),
    sent_at: date.optional().describe("When to=sent; defaults to now"),
    next_followup_at: date.optional().describe("When to=sent: reminder on the channel"),
    follow_up_in_days: z.number().min(0).max(365).optional().describe("When to=sent: reminder N days after sending"),
    idempotency_key: idem,
    reason: reasonField,
  }),
  list_drafts: z.object({
    state: z.enum(DRAFT_STATES).optional(),
    channel: z.enum(OUTREACH_CHANNELS).optional(),
    contact_id: z.string().optional(),
    campaign_id: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  upsert_campaign: z.object({
    name: z.string().min(1),
    offer_text: z.string().optional(),
    status: z.enum(["active", "paused", "archived"]).optional(),
    idempotency_key: idem,
    reason: reasonField,
  }),
  list_campaigns: z.object({}),
  list_contacts: z.object({
    stage: z.enum(STAGES).optional().describe("Overall stage"),
    channel: z.enum(OUTREACH_CHANNELS).optional(),
    channel_stage: z.enum(STAGES).optional().describe("Stage on `channel` (or any channel)"),
    source: z.enum(SOURCES).optional(),
    campaign_id: z.string().optional(),
    contact_type: z.enum(CONTACT_TYPES).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  due_followups: z.object({
    today: z.string().optional().describe("YYYY-MM-DD or ISO time in `tz`; defaults to now"),
    tz: z.string().default("Asia/Saigon"),
    include_tasks: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  stale_no_response: z.object({
    days: z.number().min(0).max(365),
    channel: z.enum(OUTREACH_CHANNELS).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  linkedin_needs_first_message: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
  x_pacing_today: z.object({
    tz: z.string().default("Asia/Saigon"),
    max_per_day: z.number().int().min(1).default(8),
    min_gap_minutes: z.number().int().min(0).default(60),
    now: date.optional().describe("For testing; defaults to now"),
  }),
  outreach_report: z.object({
    tz: z.string().default("Asia/Saigon"),
    goal_deadline: z.string().default("2026-12-15"),
    goal_paying: z.number().int().default(3),
    goal_pilots: z.number().int().default(10),
  }),
  import_leads_csv: z.object({
    csv: z.string().min(1).describe("CSV text with header handle,name,profile_url,bio_summary,followers,company,role,est_team_size,signal_post_url,signal_post_date,signal_summary,score,source,status,first_seen,notes"),
    dry_run: z.boolean().default(true).describe("Default true: report what would happen without writing"),
    campaign_id: z.string().optional(),
    row_offset: z.number().int().min(0).default(0).describe("Added to row numbers in the report (for chunked uploads)"),
    idempotency_key: idem,
    reason: reasonField,
  }),
  export_csv: z.object({
    contact_type: z.enum(CONTACT_TYPES).optional(),
    stage: z.enum(STAGES).optional(),
    campaign_id: z.string().optional(),
  }),
};
export type Input<K extends keyof typeof schemas> = z.input<(typeof schemas)[K]>;

const DAY = 86_400_000;

export class CrmService {
  readonly repo: Repository;
  constructor(db: DB, readonly ctx: OrgContext) {
    this.repo = new Repository(db, ctx);
  }

  /** Replays a stored response for a repeated key; rejects a reused key with a different payload. */
  private async idempotent<T>(op: string, input: { idempotency_key?: string }, fn: () => Promise<T>): Promise<T> {
    requireScope(this.ctx, "crm:write");
    const key = input.idempotency_key;
    if (!key) return fn();
    const { idempotency_key: _k, ...rest } = input;
    const hash = await sha256({ op, rest });
    const existing = await this.repo.getIdempotency(key);
    if (existing) {
      if (existing.requestHash !== hash) throw new CrmError("conflict", `idempotency key reused with a different ${existing.operation} request`);
      return existing.response as T;
    }
    const result = await fn();
    await this.repo.saveIdempotency(key, op, hash, result);
    return result;
  }

  // ---------- reads
  async search_contacts(raw: Input<"search_contacts">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.search_contacts.parse(raw);
    return this.repo.searchContacts({ query: i.query, stage: i.stage, companyId: i.company_id, tag: i.tag, limit: i.limit });
  }

  async get_contact(raw: Input<"get_contact">) {
    requireScope(this.ctx, "crm:read");
    const { id } = schemas.get_contact.parse(raw);
    const contact = await this.repo.contactById(id);
    if (!contact) throw new CrmError("not_found", `contact ${id} not found`);
    const [company, touches, tasks, notes, tags, channel_states, drafts] = await Promise.all([
      contact.companyId ? this.repo.companyById(contact.companyId) : undefined,
      this.repo.touchesForContact(id),
      this.repo.openTasksForContact(id),
      this.repo.notesFor("contact", id),
      this.repo.tagsForContact(id),
      this.repo.channelStatesFor(id),
      this.repo.listDrafts({ contactId: id, limit: 50 }),
    ]);
    return { ...contact, company: company ?? null, tags, channel_states, drafts, touches, open_tasks: tasks, notes };
  }

  async list_due_followups(raw: Input<"list_due_followups">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.list_due_followups.parse(raw);
    return this.repo.openTasksDueBy(toDate(i.before) ?? new Date(), i.limit);
  }

  async get_activity(raw: Input<"get_activity">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.get_activity.parse(raw);
    return this.repo.activity({ entityType: i.entity_type, entityId: i.entity_id, since: toDate(i.since), limit: i.limit });
  }

  async pipeline_summary(_raw: Input<"pipeline_summary"> = {}) {
    requireScope(this.ctx, "crm:read");
    const counts = await this.repo.stageCounts();
    const by = Object.fromEntries(STAGES.map((st) => [st, 0])) as Record<(typeof STAGES)[number], number>;
    for (const c of counts) by[c.stage] = Number(c.count);
    const due = await this.repo.openTasksDueBy(new Date(), 500);
    return { stages: by, total: Object.values(by).reduce((a, b) => a + b, 0), due_followups: due.length };
  }

  // ---------- writes
  async upsert_company(raw: Input<"upsert_company">) {
    const i = schemas.upsert_company.parse(raw);
    return this.idempotent("upsert_company", i, async () => {
      const domain = normalizeDomain(i.domain);
      if (!domain) throw new CrmError("invalid", `invalid domain ${i.domain}`);
      const res = await this.ensureCompany(domain, i);
      return { company: res.company, created: res.created, deduped: !res.created };
    });
  }

  private async ensureCompany(
    domain: string,
    i: { name?: string; website?: string; linkedin?: string; team_size?: number; stack?: string[]; type?: string; published_email?: string; reason?: string },
  ) {
    const existing = await this.repo.companyByDomain(domain);
    const fields = {
      ...(i.name && { name: i.name }),
      ...(i.website && { website: i.website }),
      ...(i.linkedin && { linkedin: normalizeUrl(i.linkedin) }),
      ...(i.team_size !== undefined && { teamSize: i.team_size }),
      ...(i.stack && { stack: i.stack }),
      ...(i.type && { type: i.type.trim().toLowerCase() }),
      ...(i.published_email && { publishedEmail: normalizeEmail(i.published_email) }),
    };
    if (existing) {
      if (Object.keys(fields).length === 0) return { company: existing, created: false };
      const company = await this.repo.updateCompany(existing.id, fields);
      await this.repo.appendActivity({ action: "company.updated", entityType: "company", entityId: company.id, reason: i.reason, payload: fields });
      return { company, created: false };
    }
    const company = await this.repo.insertCompany({ name: i.name ?? domain, domain, ...fields });
    await this.repo.appendActivity({ action: "company.created", entityType: "company", entityId: company.id, reason: i.reason, payload: { domain, ...fields } });
    return { company, created: true };
  }

  /** Company by name when there is no domain (e.g. from a CSV). */
  private async ensureCompanyByName(name: string, reason?: string) {
    const existing = await this.repo.companyByName(name);
    if (existing) return existing;
    const company = await this.repo.insertCompany({ name: name.trim() });
    await this.repo.appendActivity({ action: "company.created", entityType: "company", entityId: company.id, reason, payload: { name } });
    return company;
  }

  private async blockProbe(p: { names?: (string | null | undefined)[]; companies?: (string | null | undefined)[]; handles?: (string | null | undefined)[]; domains?: (string | null | undefined)[] }): Promise<Probe> {
    return { personNames: f(p.names), companyNames: f(p.companies), handles: f(p.handles), domains: f(p.domains) };
  }

  private async competitorHits(probe: Probe) {
    return matchBlocklist(await this.repo.blocklistAll(), probe);
  }

  private identitiesOf(i: { email?: string; linkedin_url?: string; linkedin?: string; x_handle?: string; x?: string; reddit_user?: string; github?: string }) {
    return {
      email: normalizeEmail(i.email),
      linkedin: normalizeLinkedin(i.linkedin_url ?? i.linkedin),
      xHandle: normalizeXHandle(i.x_handle ?? i.x),
      redditUser: normalizeRedditUser(i.reddit_user),
      github: normalizeGithub(i.github),
    };
  }

  async upsert_contact(raw: Input<"upsert_contact">) {
    const i = schemas.upsert_contact.parse(raw);
    return this.idempotent("upsert_contact", i, async () => {
      const ids = this.identitiesOf(i);
      for (const [k, v] of [["linkedin_url", i.linkedin_url ?? i.linkedin], ["x_handle", i.x_handle ?? i.x], ["reddit_user", i.reddit_user], ["github", i.github]] as const) {
        const key = ({ linkedin_url: "linkedin", x_handle: "xHandle", reddit_user: "redditUser", github: "github" } as const)[k];
        if (v && !ids[key]) throw new CrmError("invalid", `could not parse ${k} from ${JSON.stringify(v)}`);
      }
      if (!Object.values(ids).some(Boolean) && !i.name) throw new CrmError("invalid", "need at least one identity (email, x_handle, linkedin_url, reddit_user, github) or a name");

      // Dedupe across every identity. Two different contacts matching = conflict the caller must resolve.
      const matches = await this.repo.contactsByIdentity(ids);
      if (matches.length > 1) throw new CrmError("conflict", `identities match ${matches.length} different contacts: ${matches.map((m) => m.id).join(", ")}`);
      const existing = matches[0];

      // Company: explicit id > explicit domain > work-email domain > name.
      let companyId = i.company_id;
      let companyName = i.company_name;
      let companyDomain = normalizeDomain(i.company_domain) ?? companyDomainFromEmail(ids.email);
      if (companyId) {
        const co = await this.repo.companyById(companyId);
        if (!co) throw new CrmError("not_found", `company ${companyId} not found`);
        companyName ??= co.name;
        companyDomain ??= co.domain;
      }
      const contactType = i.contact_type ?? existing?.contactType ?? "lead";
      if (contactType === "lead") {
        const probe = await this.blockProbe({
          names: [i.name ?? existing?.name],
          companies: [companyName],
          handles: [ids.xHandle, ids.github, ids.redditUser, ids.linkedin?.split("/").pop()],
          domains: [companyDomain, normalizeDomain(ids.email)],
        });
        const hits = await this.competitorHits(probe);
        if (hits.length) throw new CrmError("blocked", `matches competitor blocklist (${hits.map((h) => h.matched_on).join(", ")}); use contact_type=competitor to record a competitor`);
      }
      if (!companyId && companyDomain) companyId = (await this.ensureCompany(companyDomain, { name: companyName, reason: i.reason })).company.id;
      else if (!companyId && companyName) companyId = (await this.ensureCompanyByName(companyName, i.reason)).id;
      if (i.sequence_id && !(await this.repo.sequenceById(i.sequence_id))) throw new CrmError("not_found", `sequence ${i.sequence_id} not found`);
      if (i.campaign_id && !(await this.repo.campaignById(i.campaign_id))) throw new CrmError("not_found", `campaign ${i.campaign_id} not found`);

      const role = i.role ?? i.title;
      const fields = {
        ...(ids.email && { email: ids.email }),
        ...(ids.linkedin && { linkedin: ids.linkedin }),
        ...(ids.xHandle && { xHandle: ids.xHandle }),
        ...(ids.redditUser && { redditUser: ids.redditUser }),
        ...(ids.github && { github: ids.github }),
        ...(i.name && { name: i.name }),
        ...(role && { role }),
        ...(companyId && { companyId }),
        ...(i.sequence_id && { sequenceId: i.sequence_id }),
        ...(i.campaign_id && { campaignId: i.campaign_id }),
        ...(i.contact_type && { contactType: i.contact_type }),
        ...(i.source && { source: i.source }),
        ...(i.bio_summary && { bioSummary: i.bio_summary }),
        ...(i.followers !== undefined && { followers: i.followers }),
        ...(i.est_team_size !== undefined && { estTeamSize: i.est_team_size }),
        ...(i.score !== undefined && { score: i.score }),
        ...(i.first_seen && { firstSeenAt: new Date(i.first_seen) }),
        ...(i.notes && { notesText: i.notes }),
        ...(i.signal_post_url && { signalPostUrl: i.signal_post_url }),
        ...(i.signal_date && { signalDate: i.signal_date }),
        ...(i.signal_summary && { signalSummary: i.signal_summary }),
      };
      const stage = i.stage ? advance(existing?.stage ?? "new", i.stage) : undefined;
      let contact;
      let created = false;
      if (existing) {
        contact = await this.repo.updateContact(existing.id, { ...fields, ...(stage && stage !== existing.stage && { stage, stageChangedAt: new Date() }) });
        await this.repo.appendActivity({ action: "contact.updated", entityType: "contact", entityId: contact.id, reason: i.reason, payload: { ...fields, stage } });
      } else {
        contact = await this.repo.insertContact({ ...fields, firstSeenAt: fields.firstSeenAt ?? new Date(), ...(stage && { stage, stageChangedAt: new Date() }) });
        created = true;
        await this.repo.appendActivity({ action: "contact.created", entityType: "contact", entityId: contact.id, reason: i.reason, payload: { ...fields, stage } });
      }
      for (const name of i.tags ?? []) {
        const tag = await this.repo.ensureTag(name.trim().toLowerCase());
        await this.repo.tagContact(contact.id, tag.id);
      }
      return { contact, created, deduped: !created };
    });
  }

  /** Applies a channel stage change automatically (forward only) and re-rolls the overall stage. */
  private async bumpChannel(
    contactId: string,
    channel: OutreachChannel,
    v: { stage?: Stage; exact?: boolean; lastTouchAt?: Date; nextFollowupAt?: Date | null; nextStep?: string | null },
    reason?: string,
  ) {
    const before = await this.repo.channelState(contactId, channel);
    const from = before?.stage ?? "new";
    const to = v.stage ? (v.exact ? v.stage : advance(from, v.stage)) : from;
    const state = await this.repo.upsertChannelState(contactId, channel, {
      stage: to,
      ...(v.lastTouchAt && { lastTouchAt: v.lastTouchAt }),
      ...(v.nextFollowupAt !== undefined && { nextFollowupAt: v.nextFollowupAt }),
      ...(v.nextStep !== undefined && { nextStep: v.nextStep }),
    });
    if (to !== from) await this.repo.appendActivity({ action: "channel.stage_changed", entityType: "contact", entityId: contactId, reason, payload: { channel, from, to } });
    await this.rollupOverall(contactId, reason);
    return state;
  }

  private async rollupOverall(contactId: string, reason?: string) {
    const contact = (await this.repo.contactById(contactId))!;
    const states = await this.repo.channelStatesFor(contactId);
    const next = rollup(contact.stage, states.map((x) => x.stage));
    if (next === contact.stage) return contact;
    const updated = await this.repo.updateContact(contactId, { stage: next, stageChangedAt: new Date() });
    await this.repo.appendActivity({ action: "contact.stage_changed", entityType: "contact", entityId: contactId, reason, payload: { from: contact.stage, to: next, via: "channel_rollup" } });
    return updated;
  }

  async log_touch(raw: Input<"log_touch">) {
    const i = schemas.log_touch.parse(raw);
    return this.idempotent("log_touch", i, async () => {
      const contact = await this.repo.contactById(i.contact_id);
      if (!contact) throw new CrmError("not_found", `contact ${i.contact_id} not found`);
      if (i.external_id) {
        const dup = await this.repo.touchByExternalId(i.channel, i.external_id);
        if (dup) return { touch: dup, deduped: true, follow_up_task: null };
      }
      const now = new Date();
      const touch = await this.recordTouch(contact.id, { ...i, sentAt: toDate(i.sent_at) ?? now, sequenceId: i.sequence_id ?? contact.sequenceId });
      if (i.channel === "other") {
        // No channel state for "other": advance the overall stage directly.
        const inbound = i.direction === "inbound" || i.status === "replied";
        const next = advance(contact.stage, inbound ? "responded" : i.status === "sent" ? "contacted" : contact.stage);
        if (next !== contact.stage) await this.repo.updateContact(contact.id, { stage: next, stageChangedAt: now });
      } else {
        const inbound = i.direction === "inbound" || i.status === "replied";
        await this.bumpChannel(
          contact.id,
          i.channel,
          {
            stage: inbound ? "responded" : i.status === "sent" ? "contacted" : undefined,
            lastTouchAt: i.status === "draft" ? undefined : now,
            ...(i.next_followup_at && { nextFollowupAt: new Date(i.next_followup_at) }),
          },
          i.reason,
        );
      }
      await this.repo.updateContact(contact.id, { lastTouchAt: now });
      const after = (await this.repo.contactById(contact.id))!;
      await this.repo.appendActivity({
        action: "touch.logged",
        entityType: "contact",
        entityId: contact.id,
        reason: i.reason,
        payload: { touch_id: touch.id, channel: i.channel, direction: i.direction, status: i.status, subject: i.subject, stage_from: contact.stage, stage_to: after.stage },
      });
      let follow_up_task = null;
      if (i.follow_up_in_days !== undefined) {
        follow_up_task = await this.createTask({
          title: `Follow up with ${contact.name ?? contact.email ?? "contact"} (${i.channel})`,
          contactId: contact.id,
          dueAt: new Date(now.getTime() + i.follow_up_in_days * DAY),
          reason: i.reason,
        });
      }
      return { touch, deduped: false, follow_up_task };
    });
  }

  private recordTouch(
    contactId: string,
    t: { channel: (typeof CHANNELS)[number]; direction: "outbound" | "inbound"; status: (typeof TOUCH_STATUSES)[number]; subject?: string; body?: string; external_id?: string; sentAt: Date; sequenceId?: string | null },
  ) {
    return this.repo.insertTouch({
      contactId,
      sequenceId: t.sequenceId,
      channel: t.channel,
      direction: t.direction,
      status: t.status,
      subject: t.subject,
      body: t.body,
      externalId: t.external_id,
      sentAt: t.status === "draft" ? null : t.sentAt,
      repliedAt: t.status === "replied" || t.direction === "inbound" ? t.sentAt : null,
    });
  }

  async update_stage(raw: Input<"update_stage">) {
    const i = schemas.update_stage.parse(raw);
    return this.idempotent("update_stage", i, async () => {
      const contact = await this.repo.contactById(i.contact_id);
      if (!contact) throw new CrmError("not_found", `contact ${i.contact_id} not found`);
      if (contact.stage === i.stage) return contact;
      const updated = await this.repo.updateContact(contact.id, { stage: i.stage, stageChangedAt: new Date() });
      await this.repo.appendActivity({ action: "contact.stage_changed", entityType: "contact", entityId: contact.id, reason: i.reason, payload: { from: contact.stage, to: i.stage } });
      return updated;
    });
  }

  private async createTask(t: { title: string; contactId?: string; dueAt?: Date; assignee?: string; reason?: string }) {
    if (t.contactId && !(await this.repo.contactById(t.contactId))) throw new CrmError("not_found", `contact ${t.contactId} not found`);
    const task = await this.repo.insertTask({ title: t.title, contactId: t.contactId, dueAt: t.dueAt, assignee: t.assignee });
    await this.repo.appendActivity({ action: "task.created", entityType: "task", entityId: task.id, reason: t.reason, payload: { title: t.title, contact_id: t.contactId, due_at: t.dueAt } });
    return task;
  }

  async create_task(raw: Input<"create_task">) {
    const i = schemas.create_task.parse(raw);
    return this.idempotent("create_task", i, () =>
      this.createTask({ title: i.title, contactId: i.contact_id, dueAt: toDate(i.due_at), assignee: i.assignee, reason: i.reason }),
    );
  }

  async complete_task(raw: Input<"complete_task">) {
    const i = schemas.complete_task.parse(raw);
    return this.idempotent("complete_task", i, async () => {
      const task = await this.repo.taskById(i.id);
      if (!task) throw new CrmError("not_found", `task ${i.id} not found`);
      if (task.completedAt) return task; // naturally idempotent
      const done = (await this.repo.completeTask(i.id))!;
      await this.repo.appendActivity({ action: "task.completed", entityType: "task", entityId: i.id, reason: i.reason, payload: { title: task.title } });
      return done;
    });
  }

  async add_note(raw: Input<"add_note">) {
    const i = schemas.add_note.parse(raw);
    return this.idempotent("add_note", i, async () => {
      const target = i.entity_type === "contact" ? await this.repo.contactById(i.entity_id) : await this.repo.companyById(i.entity_id);
      if (!target) throw new CrmError("not_found", `${i.entity_type} ${i.entity_id} not found`);
      const note = await this.repo.insertNote({ entityType: i.entity_type, entityId: i.entity_id, body: i.body, author: `${this.ctx.actor.type}:${this.ctx.actor.id}` });
      await this.repo.appendActivity({ action: "note.added", entityType: i.entity_type, entityId: i.entity_id, reason: i.reason, payload: { note_id: note.id } });
      return note;
    });
  }

  // =====================================================================
  // Sales Outbound tools
  // =====================================================================

  async find_existing(raw: Input<"find_existing">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.find_existing.parse(raw);
    const any = i.identity;
    const ids = {
      email: normalizeEmail(i.email ?? (any?.includes("@") && !any.startsWith("@") ? any : undefined)),
      linkedin: normalizeLinkedin(i.linkedin_url ?? (any && /linkedin\.com/i.test(any) ? any : undefined)),
      xHandle: normalizeXHandle(i.x_handle ?? (any && !/linkedin|github|reddit/i.test(any) ? any : undefined)),
      redditUser: normalizeRedditUser(i.reddit_user ?? (any && (/reddit\.com|^\/?u\//i.test(any) || !/[./@]/.test(any)) ? any : undefined)),
      github: normalizeGithub(i.github ?? (any && (/github\.com/i.test(any) || !/[./@]/.test(any)) ? any : undefined)),
    };
    const domain = normalizeDomain(i.domain) ?? companyDomainFromEmail(ids.email);
    const exact = (await this.repo.contactsByIdentity(ids)).map((c) => ({
      contact: c,
      match: (["email", "linkedin", "xHandle", "redditUser", "github"] as const).filter((k) => ids[k] && c[k] === ids[k]).map((k) => ({ xHandle: "x_handle", redditUser: "reddit_user", linkedin: "linkedin_url" } as Record<string, string>)[k] ?? k),
    }));
    const seen = new Set(exact.map((e) => e.contact.id));
    const by_domain = domain
      ? (await this.repo.contactsByDomain(domain)).filter((c) => !seen.has(c.id)).map((c) => ({ contact: c, match: [`domain:${domain}`] }))
      : [];
    by_domain.forEach((d) => seen.add(d.contact.id));

    const candidates: { contact: unknown; reason: string; score: number }[] = [];
    if (i.name) {
      const companies = new Map((await this.repo.allCompanies()).map((c) => [c.id, c]));
      for (const c of await this.repo.allContacts()) {
        if (seen.has(c.id) || !similarNames(i.name, c.name)) continue;
        const co = c.companyId ? companies.get(c.companyId) : undefined;
        const companyMatch = i.company && co && (similarNames(i.company, co.name) || (normalizeDomain(i.company) && normalizeDomain(i.company) === co.domain));
        const exactName = normalizeName(i.name) === normalizeName(c.name);
        if (i.company && !companyMatch && !exactName) continue;
        candidates.push({
          contact: { ...c, company: co ?? null },
          reason: companyMatch ? `name~"${c.name}" + company~"${co!.name}"` : `name${exactName ? "=" : "~"}"${c.name}"${i.company ? " (company differs)" : ""}`,
          score: (companyMatch ? 2 : 0) + (exactName ? 1 : 0),
        });
      }
      candidates.sort((a, b) => b.score - a.score);
    }
    const hits = await this.competitorHits(
      await this.blockProbe({ names: [i.name], companies: [i.company], handles: [ids.xHandle, ids.github, ids.redditUser, ids.linkedin?.split("/").pop()], domains: [domain] }),
    );
    return {
      found: exact.length > 0,
      exact: exact.slice(0, i.limit),
      by_domain: by_domain.slice(0, i.limit),
      candidates: candidates.slice(0, i.limit),
      is_competitor: hits.length > 0,
      competitor_matches: hits,
    };
  }

  async is_competitor(raw: Input<"is_competitor">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.is_competitor.parse(raw);
    const probe = await this.blockProbe({ names: [i.name], companies: [i.company], handles: i.handle ? [normalizeHandle(i.handle)] : [], domains: [i.domain, normalizeDomain(i.email)] });
    if (i.contact_id) {
      const c = await this.repo.contactById(i.contact_id);
      if (!c) throw new CrmError("not_found", `contact ${i.contact_id} not found`);
      const co = c.companyId ? await this.repo.companyById(c.companyId) : undefined;
      probe.personNames.push(...[c.name].filter((x): x is string => !!x));
      probe.companyNames.push(...[co?.name].filter((x): x is string => !!x));
      probe.handles.push(...[c.xHandle, c.github, c.redditUser, c.linkedin?.split("/").pop()].filter((x): x is string => !!x));
      probe.domains.push(...[co?.domain, normalizeDomain(c.email)].filter((x): x is string => !!x));
      if (c.contactType === "competitor") return { is_competitor: true, matches: [{ entry: null, matched_on: "contact_type:competitor" }] };
    }
    const matches = await this.competitorHits(probe);
    return { is_competitor: matches.length > 0, matches };
  }

  async add_competitor(raw: Input<"add_competitor">) {
    const i = schemas.add_competitor.parse(raw);
    requireRole(this.ctx, "admin");
    return this.idempotent("add_competitor", i, async () => {
      const n = normalizeBlockValue(i.kind, i.value);
      if (!n) throw new CrmError("invalid", `could not normalize ${JSON.stringify(i.value)}`);
      const entry = await this.repo.insertBlock(n.kind, n.value, i.label ?? i.value, i.match ?? defaultMatchMode(n.kind, n.value, i.value));
      await this.repo.appendActivity({ action: "blocklist.added", entityType: "blocklist", entityId: entry.id, reason: i.reason, payload: n });
      return entry;
    });
  }

  async remove_competitor(raw: Input<"remove_competitor">) {
    const i = schemas.remove_competitor.parse(raw);
    requireRole(this.ctx, "admin");
    return this.idempotent("remove_competitor", i, async () => {
      const gone = await this.repo.deleteBlock(i.id);
      if (!gone) throw new CrmError("not_found", `blocklist entry ${i.id} not found`);
      await this.repo.appendActivity({ action: "blocklist.removed", entityType: "blocklist", entityId: i.id, reason: i.reason, payload: { kind: gone.kind, value: gone.value } });
      return { removed: gone };
    });
  }

  async purge_competitors(raw: Input<"purge_competitors">) {
    const i = schemas.purge_competitors.parse(raw);
    requireRole(this.ctx, "admin");
    if (!i.ids?.length && !i.value_regex) throw new CrmError("invalid", "give ids or value_regex");
    let re: RegExp | null = null;
    try {
      re = i.value_regex ? new RegExp(i.value_regex, "i") : null;
    } catch {
      throw new CrmError("invalid", "value_regex is not a valid regex");
    }
    const ids = new Set(i.ids ?? []);
    const all = await this.repo.blocklistAll();
    const matched = all.filter((e) => (!i.kind || e.kind === i.kind) && (!ids.size || ids.has(e.id)) && (!re || re.test(e.value)));
    if (i.dry_run) return { dry_run: true, count: matched.length, entries: matched };
    return this.idempotent("purge_competitors", i, async () => {
      for (const e of matched) {
        await this.repo.deleteBlock(e.id);
        await this.repo.appendActivity({ action: "blocklist.removed", entityType: "blocklist", entityId: e.id, reason: i.reason, payload: { kind: e.kind, value: e.value, purge: true } });
      }
      return { dry_run: false, count: matched.length, removed: matched };
    });
  }

  async list_competitors(_raw: Input<"list_competitors"> = {}) {
    requireScope(this.ctx, "crm:read");
    return this.repo.blocklistAll();
  }

  async set_channel_state(raw: Input<"set_channel_state">) {
    const i = schemas.set_channel_state.parse(raw);
    return this.idempotent("set_channel_state", i, async () => {
      if (!(await this.repo.contactById(i.contact_id))) throw new CrmError("not_found", `contact ${i.contact_id} not found`);
      const state = await this.bumpChannel(
        i.contact_id,
        i.channel,
        {
          stage: i.stage,
          exact: true,
          lastTouchAt: toDate(i.last_touch_at),
          ...(i.next_followup_at !== undefined && { nextFollowupAt: i.next_followup_at === null ? null : new Date(i.next_followup_at) }),
          ...(i.next_step !== undefined && { nextStep: i.next_step }),
        },
        i.reason,
      );
      await this.repo.appendActivity({ action: "channel.updated", entityType: "contact", entityId: i.contact_id, reason: i.reason, payload: { channel: i.channel, stage: i.stage, next_followup_at: i.next_followup_at, next_step: i.next_step } });
      const contact = (await this.repo.contactById(i.contact_id))!;
      return { state, overall_stage: contact.stage };
    });
  }

  async create_draft(raw: Input<"create_draft">) {
    const i = schemas.create_draft.parse(raw);
    return this.idempotent("create_draft", i, async () => {
      const contact = await this.repo.contactById(i.contact_id);
      if (!contact) throw new CrmError("not_found", `contact ${i.contact_id} not found`);
      if (contact.contactType === "competitor") throw new CrmError("blocked", "contact is a competitor");
      if (contact.stage === "do_not_contact") throw new CrmError("blocked", "contact is do_not_contact");
      const state = await this.repo.channelState(contact.id, i.channel);
      if (state?.stage === "do_not_contact") throw new CrmError("blocked", `contact is do_not_contact on ${i.channel}`);
      const campaignId = i.campaign_id ?? contact.campaignId;
      if (i.campaign_id && !(await this.repo.campaignById(i.campaign_id))) throw new CrmError("not_found", `campaign ${i.campaign_id} not found`);
      const draft = await this.repo.insertDraft({ contactId: contact.id, channel: i.channel, text: i.text, intentUrl: i.intent_url, campaignId, state: "drafted", stateChangedAt: new Date() });
      await this.repo.appendActivity({ action: "draft.created", entityType: "draft", entityId: draft.id, reason: i.reason, payload: { contact_id: contact.id, channel: i.channel, campaign_id: campaignId } });
      await this.bumpChannel(contact.id, i.channel, { stage: "drafted" }, i.reason);
      return draft;
    });
  }

  async transition_draft(raw: Input<"transition_draft">) {
    const i = schemas.transition_draft.parse(raw);
    return this.idempotent("transition_draft", i, async () => {
      const draft = await this.repo.draftById(i.draft_id);
      if (!draft) throw new CrmError("not_found", `draft ${i.draft_id} not found`);
      if (!DRAFT_TRANSITIONS[draft.state].includes(i.to)) throw new CrmError("conflict", `cannot move draft from ${draft.state} to ${i.to}`);
      if (i.text && i.to !== "drafted") throw new CrmError("invalid", "text can only change when moving to drafted (re-approve after editing)");
      const now = new Date();
      const sentAt = i.to === "sent" ? (toDate(i.sent_at) ?? now) : undefined;
      const updated = await this.repo.updateDraft(draft.id, {
        state: i.to,
        stateChangedAt: now,
        ...(i.text && { text: i.text }),
        ...(i.intent_url && { intentUrl: i.intent_url }),
        ...(sentAt && { sentAt }),
      });
      await this.repo.appendActivity({ action: "draft.state_changed", entityType: "draft", entityId: draft.id, reason: i.reason, payload: { from: draft.state, to: i.to, contact_id: draft.contactId, channel: draft.channel, edited: !!i.text } });
      let touch = null;
      let pacing = null;
      if (i.to === "sent") {
        const contact = (await this.repo.contactById(draft.contactId))!;
        if (draft.channel === "x") pacing = await this.x_pacing_today({ now: sentAt!.toISOString() });
        touch = await this.recordTouch(draft.contactId, { channel: draft.channel, direction: "outbound", status: "sent", body: updated.text, external_id: i.external_id, sentAt: sentAt!, sequenceId: contact.sequenceId });
        const followup = i.next_followup_at ? new Date(i.next_followup_at) : i.follow_up_in_days !== undefined ? new Date(sentAt!.getTime() + i.follow_up_in_days * DAY) : undefined;
        await this.bumpChannel(draft.contactId, draft.channel, { stage: "contacted", lastTouchAt: sentAt, ...(followup && { nextFollowupAt: followup }) }, i.reason);
        await this.repo.updateContact(draft.contactId, { lastTouchAt: sentAt });
        await this.repo.appendActivity({ action: "touch.logged", entityType: "contact", entityId: draft.contactId, reason: i.reason, payload: { touch_id: touch.id, channel: draft.channel, draft_id: draft.id } });
      } else if (i.to === "discarded") {
        // A discarded draft no longer holds the channel at "drafted".
        const st = await this.repo.channelState(draft.contactId, draft.channel);
        const open = (await this.repo.listDrafts({ contactId: draft.contactId, channel: draft.channel, limit: 200 })).some((d) => d.state === "drafted" || d.state === "approved");
        if (st?.stage === "drafted" && !open) await this.bumpChannel(draft.contactId, draft.channel, { stage: "qualified", exact: true }, i.reason);
      }
      return { draft: updated, touch, x_pacing_before_send: pacing };
    });
  }

  async list_drafts(raw: Input<"list_drafts">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.list_drafts.parse(raw);
    return this.repo.listDrafts({ state: i.state, channel: i.channel, contactId: i.contact_id, campaignId: i.campaign_id, limit: i.limit });
  }

  async upsert_campaign(raw: Input<"upsert_campaign">) {
    const i = schemas.upsert_campaign.parse(raw);
    requireRole(this.ctx, "admin");
    return this.idempotent("upsert_campaign", i, async () => {
      const existing = await this.repo.campaignByName(i.name.trim());
      const fields = { ...(i.offer_text !== undefined && { offerText: i.offer_text }), ...(i.status && { status: i.status }) };
      if (existing) {
        if (!Object.keys(fields).length) return { campaign: existing, created: false };
        const campaign = await this.repo.updateCampaign(existing.id, fields);
        await this.repo.appendActivity({ action: "campaign.updated", entityType: "campaign", entityId: campaign.id, reason: i.reason, payload: fields });
        return { campaign, created: false };
      }
      const campaign = await this.repo.insertCampaign({ name: i.name.trim(), ...fields });
      await this.repo.appendActivity({ action: "campaign.created", entityType: "campaign", entityId: campaign.id, reason: i.reason, payload: { name: campaign.name, ...fields } });
      return { campaign, created: true };
    });
  }

  async list_campaigns(_raw: Input<"list_campaigns"> = {}) {
    requireScope(this.ctx, "crm:read");
    return this.repo.listCampaigns();
  }

  async list_contacts(raw: Input<"list_contacts">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.list_contacts.parse(raw);
    return this.repo.listContacts({ stage: i.stage, source: i.source, campaignId: i.campaign_id, contactType: i.contact_type, channel: i.channel, channelStage: i.channel_stage, limit: i.limit });
  }

  async due_followups(raw: Input<"due_followups">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.due_followups.parse(raw);
    const ref = i.today ? (/^\d{4}-\d{2}-\d{2}$/.test(i.today) ? localNoon(i.today, i.tz) : new Date(i.today)) : new Date();
    if (Number.isNaN(ref.getTime())) throw new CrmError("invalid", `bad today ${i.today}`);
    const end = endOfLocalDay(ref, i.tz);
    const channel = (await this.repo.followupsDueBefore(end, i.limit)).map((r) => ({
      contact_id: r.contact.id,
      name: r.contact.name,
      channel: r.state.channel,
      stage: r.state.stage,
      next_followup_at: r.state.nextFollowupAt,
      next_step: r.state.nextStep,
      overdue: r.state.nextFollowupAt! < startOfLocalDay(ref, i.tz),
    }));
    const tasks = i.include_tasks ? await this.repo.openTasksDueBy(new Date(end.getTime() - 1), i.limit) : [];
    return { today: localDateString(ref, i.tz), tz: i.tz, channel_followups: channel, tasks };
  }

  async stale_no_response(raw: Input<"stale_no_response">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.stale_no_response.parse(raw);
    const before = new Date(Date.now() - i.days * DAY);
    const rows = await this.repo.staleStates(before, ["contacted", "connection_pending", "connected"], 1000);
    return rows
      .filter((r) => (!i.channel || r.state.channel === i.channel) && r.contact.stage !== "do_not_contact")
      .slice(0, i.limit)
      .map((r) => ({ contact_id: r.contact.id, name: r.contact.name, channel: r.state.channel, stage: r.state.stage, last_touch_at: r.state.lastTouchAt, days_since: Math.floor((Date.now() - r.state.lastTouchAt!.getTime()) / DAY) }));
  }

  async linkedin_needs_first_message(raw: Input<"linkedin_needs_first_message">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.linkedin_needs_first_message.parse(raw);
    const [rows, touched, sentDrafts] = await Promise.all([
      this.repo.statesByChannelStage("linkedin", ["connection_pending", "connected"]),
      this.repo.outboundTouchContactIds("linkedin"),
      this.repo.sentDraftContactIds("linkedin"),
    ]);
    return rows
      .filter((r) => !touched.has(r.contact.id) && !sentDrafts.has(r.contact.id) && r.contact.stage !== "do_not_contact")
      .slice(0, i.limit)
      .map((r) => ({ contact_id: r.contact.id, name: r.contact.name, linkedin: r.contact.linkedin, stage: r.state.stage, next_step: r.state.nextStep }));
  }

  async x_pacing_today(raw: Input<"x_pacing_today">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.x_pacing_today.parse(raw);
    const now = toDate(i.now) ?? new Date();
    const start = startOfLocalDay(now, i.tz);
    const [drafted, sent, last] = await Promise.all([this.repo.draftsCreatedSince("x", start), this.repo.touchesSince("x", start), this.repo.lastSentTouch("x")]);
    const upToNow = sent.filter((t) => t.sentAt! <= now);
    const sentToday = upToNow.length;
    const lastAt = upToNow.reduce<Date | null>((m, t) => (!m || t.sentAt! > m ? t.sentAt! : m), null) ?? (last?.sentAt && last.sentAt <= now ? last.sentAt : null);
    const gapMs = i.min_gap_minutes * 60_000;
    const gap_ok = !lastAt || now.getTime() - lastAt.getTime() >= gapMs;
    const cap_ok = sentToday < i.max_per_day;
    const nextByGap = lastAt ? new Date(lastAt.getTime() + gapMs) : now;
    const next_allowed_at = cap_ok ? (gap_ok ? now : nextByGap) : new Date(Math.max(endOfLocalDay(now, i.tz).getTime(), nextByGap.getTime()));
    return {
      date: localDateString(now, i.tz),
      tz: i.tz,
      drafted_today: drafted.length,
      sent_today: sentToday,
      remaining_today: Math.max(0, i.max_per_day - sentToday),
      last_sent_at: lastAt,
      minutes_since_last_send: lastAt ? Math.floor((now.getTime() - lastAt.getTime()) / 60_000) : null,
      gap_ok,
      cap_ok,
      ok_to_send: gap_ok && cap_ok,
      next_allowed_at,
    };
  }

  async outreach_report(raw: Input<"outreach_report">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.outreach_report.parse(raw);
    const [contacts, states, campaigns] = await Promise.all([this.repo.allContacts(), this.repo.allChannelStates(), this.repo.listCampaigns()]);
    const leads = new Map(contacts.filter((c) => c.contactType === "lead").map((c) => [c.id, c]));

    const by_channel = Object.fromEntries(
      OUTREACH_CHANNELS.map((ch) => {
        const st = states.filter((s) => s.channel === ch && leads.has(s.contactId));
        const contacted = st.filter((s) => reached(s.stage, !!s.lastTouchAt)).length;
        const responded = st.filter((s) => rank(s.stage) >= rank("responded") && s.stage !== "do_not_contact").length;
        const row: Record<string, unknown> = {
          contacted,
          responded,
          response_rate_pct: rate(responded, contacted),
          pilots: st.filter((s) => s.stage === "pilot" || s.stage === "paying").length,
          paying: st.filter((s) => s.stage === "paying").length,
        };
        if (ch === "linkedin") {
          const invited = st.filter((s) => (rank(s.stage) >= rank("connection_pending") && s.stage !== "do_not_contact") || ((s.stage === "lost" || s.stage === "do_not_contact") && !!s.lastTouchAt)).length;
          const accepted = st.filter((s) => rank(s.stage) >= rank("connected") && s.stage !== "do_not_contact").length;
          Object.assign(row, { invites: invited, accepted, acceptance_rate_pct: rate(accepted, invited) });
        }
        return [ch, row];
      }),
    );
    const summarize = (cs: typeof contacts) => {
      const contacted = cs.filter((c) => reached(c.stage, !!c.lastTouchAt)).length;
      const responded = cs.filter((c) => rank(c.stage) >= rank("responded") && c.stage !== "do_not_contact").length;
      return {
        leads: cs.length,
        contacted,
        responded,
        response_rate_pct: rate(responded, contacted),
        call_booked: cs.filter((c) => rank(c.stage) >= rank("call_booked") && c.stage !== "do_not_contact").length,
        pilots: cs.filter((c) => c.stage === "pilot" || c.stage === "paying").length,
        paying: cs.filter((c) => c.stage === "paying").length,
      };
    };
    const all = [...leads.values()];
    const by_campaign = [
      ...campaigns.map((c) => ({ campaign_id: c.id, name: c.name, ...summarize(all.filter((x) => x.campaignId === c.id)) })),
      { campaign_id: null, name: "(no campaign)", ...summarize(all.filter((x) => !x.campaignId)) },
    ];
    const totals = summarize(all);
    const today = localDateString(new Date(), i.tz);
    const days_left = Math.ceil((Date.parse(`${i.goal_deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
    return {
      totals,
      by_channel,
      by_campaign,
      stages: Object.fromEntries(STAGES.map((st) => [st, all.filter((c) => c.stage === st).length])),
      goal: {
        target: `${i.goal_paying} paying or ${i.goal_pilots} pilots by ${i.goal_deadline}`,
        paying: totals.paying,
        pilots: totals.pilots,
        met: totals.paying >= i.goal_paying || totals.pilots >= i.goal_pilots,
        paying_progress_pct: rate(totals.paying, i.goal_paying),
        pilots_progress_pct: rate(totals.pilots, i.goal_pilots),
        days_left,
      },
      notes: "Counts are of leads (competitors excluded). Pilots include paying. Contacts later marked lost count as contacted only if a touch was recorded.",
    };
  }

  // ---------- CSV import / export
  async import_leads_csv(raw: Input<"import_leads_csv">) {
    const i = schemas.import_leads_csv.parse(raw);
    const run = () => this.importLeads(i);
    if (i.dry_run) {
      requireScope(this.ctx, "crm:read");
      return run();
    }
    return this.idempotent("import_leads_csv", i, run);
  }

  private async importLeads(i: z.output<(typeof schemas)["import_leads_csv"]>) {
    const write = !i.dry_run;
    if (write) requireScope(this.ctx, "crm:write");
    const reason = i.reason ?? "csv import";
    const { header, records } = parseCsvObjects(i.csv);
    const missing = IMPORT_COLUMNS.filter((c) => !header.includes(c));
    if (!header.includes("handle") && !header.includes("profile_url") && !header.includes("name")) throw new CrmError("invalid", "CSV needs at least one of handle, profile_url, name columns");
    if (i.campaign_id && !(await this.repo.campaignById(i.campaign_id))) throw new CrmError("not_found", `campaign ${i.campaign_id} not found`);

    // In-memory indexes so dry-run and real runs dedupe identically, including within the file.
    const [contacts, companies, blocks, states] = await Promise.all([this.repo.allContacts(), this.repo.allCompanies(), this.repo.blocklistAll(), this.repo.allChannelStates()]);
    type C = (typeof contacts)[number];
    const idx = new Map<string, C>();
    const index = (c: C) => {
      for (const [k, v] of [["email", c.email], ["li", c.linkedin], ["x", c.xHandle], ["rd", c.redditUser], ["gh", c.github]] as const) if (v) idx.set(`${k}:${v}`, c);
    };
    contacts.forEach(index);
    const companyById = new Map(companies.map((c) => [c.id, c]));
    const companyByName = new Map(companies.map((c) => [normalizeName(c.name), c]));
    const stateMap = new Map(states.map((s) => [stateKey(s.contactId, s.channel), s]));

    const seenThisRun = new Set<string>();
    let scoresRescaled = 0;
    const report = { dry_run: !write, total_rows: records.length, created: 0, updated: 0, unchanged: 0, skipped: 0, missing_columns: missing, unknown_statuses: {} as Record<string, number>, notices: [] as string[], rows: [] as ImportRowReport[] };

    for (const [n, r] of records.entries()) {
      const rowNo = i.row_offset + n + 2; // 1-based, header is row 1
      const warnings: string[] = [];
      const p = parseImportRow(r, warnings);
      if (p.scoreOriginal !== null) scoresRescaled++;
      if (!p.mapped.known) report.unknown_statuses[r.status ?? ""] = (report.unknown_statuses[r.status ?? ""] ?? 0) + 1;
      const label = p.name ?? p.ids.xHandle ?? p.ids.linkedin ?? p.ids.email ?? `row ${rowNo}`;
      const skip = (why: string) => (report.skipped++, report.rows.push({ row: rowNo, action: "skipped", label, reason: why, warnings }));
      if (!Object.values(p.ids).some(Boolean) && !p.name) {
        skip("no identity or name");
        continue;
      }

      // Dedupe: any identity, then exact normalized name + company.
      const keys = [["email", p.ids.email], ["li", p.ids.linkedin], ["x", p.ids.xHandle], ["rd", p.ids.redditUser], ["gh", p.ids.github]].filter(([, v]) => v).map(([k, v]) => `${k}:${v}`);
      const hits = [...new Set(keys.map((k) => idx.get(k)).filter((c): c is C => !!c))];
      if (hits.length > 1) {
        skip(`identities match ${hits.length} different contacts (${hits.map((h) => h.id).join(", ")})`);
        continue;
      }
      let existing = hits[0];
      if (!existing && p.name) {
        const coName = normalizeName(p.company);
        const conflicts = (c: C) => (["email", "linkedin", "xHandle", "redditUser", "github"] as const).some((k) => !!p.ids[k] && !!c[k] && c[k] !== p.ids[k]) || (!!p.ids.redditUser && !c.redditUser && !!c.xHandle && !p.ids.xHandle);
        existing = contacts.find((c) => normalizeName(c.name) === normalizeName(p.name) && normalizeName(c.companyId ? companyById.get(c.companyId)?.name : "") === coName && !conflicts(c));
        if (existing) warnings.push("matched existing contact by name+company");
      }

      const contactType = p.mapped.competitor ? "competitor" : (existing?.contactType ?? "lead");
      if (contactType === "lead") {
        const hitsB = matchBlocklist(blocks, {
          personNames: [p.name].filter((x): x is string => !!x),
          companyNames: [p.company].filter((x): x is string => !!x),
          handles: [p.ids.xHandle, p.ids.github, p.ids.redditUser, p.ids.linkedin?.split("/").pop()].filter((x): x is string => !!x),
          domains: [p.companyDomain, normalizeDomain(p.ids.email)].filter((x): x is string => !!x),
        });
        if (hitsB.length) {
          skip(`competitor blocklist: ${hitsB.map((h) => h.matched_on).join(", ")}`);
          continue;
        }
      }

      // Company link
      let companyId = existing?.companyId ?? null;
      let companyAction: string | undefined;
      if (!companyId && (p.companyDomain || p.company)) {
        const found = (p.companyDomain && companies.find((c) => c.domain === p.companyDomain)) || (p.company && companyByName.get(normalizeName(p.company)));
        if (found) companyId = found.id;
        else {
          companyAction = `create company ${p.company ?? p.companyDomain}`;
          if (write) {
            const co = p.companyDomain
              ? (await this.ensureCompany(p.companyDomain, { name: p.company ?? undefined, reason })).company
              : await this.ensureCompanyByName(p.company!, reason);
            companies.push(co);
            companyById.set(co.id, co);
            companyByName.set(normalizeName(co.name), co);
            companyId = co.id;
          } else companyId = `(new:${p.company ?? p.companyDomain})`;
        }
      }

      const desired = {
        name: p.name,
        role: p.role,
        bioSummary: p.bio,
        followers: p.followers,
        estTeamSize: p.estTeamSize,
        estTeamSizeText: p.estTeamSizeText,
        score: p.score,
        scoreOriginal: p.scoreOriginal,
        source: p.source,
        sourceDetail: p.sourceDetail,
        firstSeenAt: p.firstSeen,
        signalPostUrl: p.signalUrl,
        signalDate: p.signalDate,
        signalSummary: p.signalSummary,
      };
      const changes: Record<string, unknown> = {};
      // A contact already handled by an earlier row in this file only gets blanks filled (first row wins), so re-runs are stable.
      const fillOnly = !!existing && seenThisRun.has(existing.id);
      for (const [k, v] of Object.entries(desired)) {
        if (v === null || v === undefined) continue;
        const cur = existing?.[k as keyof C];
        if (fillOnly && cur !== null && cur !== undefined) continue;
        if (cur instanceof Date && v instanceof Date ? cur.getTime() !== v.getTime() : cur !== v) changes[k] = v;
      }
      // Identities/notes/company/campaign only fill blanks.
      for (const [k, v] of [["email", p.ids.email], ["linkedin", p.ids.linkedin], ["xHandle", p.ids.xHandle], ["redditUser", p.ids.redditUser], ["github", p.ids.github]] as const) {
        if (!v) continue;
        if (!existing?.[k]) {
          if (idx.get(`${({ email: "email", linkedin: "li", xHandle: "x", redditUser: "rd", github: "gh" } as const)[k]}:${v}`)) warnings.push(`${k} ${v} already belongs to another contact; not set`);
          else changes[k] = v;
        } else if (existing[k] !== v) warnings.push(`${k} differs (crm=${existing[k]}, csv=${v}); kept crm value`);
      }
      if (p.notes && !existing?.notesText) changes.notesText = p.notes;
      if (companyId && !existing?.companyId) changes.companyId = companyId;
      if (i.campaign_id && !existing?.campaignId) changes.campaignId = i.campaign_id;
      if (contactType !== (existing?.contactType ?? "lead")) changes.contactType = contactType;
      const overall = existing ? advance(existing.stage, p.mapped.stage) : p.mapped.stage;
      if (overall !== (existing?.stage ?? "new")) changes.stage = overall;
      const ch = p.channel;
      const curState = existing && ch ? stateMap.get(stateKey(existing.id, ch)) : undefined;
      const chStage = ch ? (curState ? advance(curState.stage, p.mapped.stage) : p.mapped.stage) : undefined;
      const stateChange = ch && chStage && (!curState || curState.stage !== chStage) && !(chStage === "new" && !curState);
      if (stateChange) changes[`channel.${ch}`] = chStage;

      const action: ImportRowReport["action"] = !existing ? "created" : Object.keys(changes).length ? "updated" : "unchanged";
      report[action]++;
      let contactId = existing?.id;
      if (write && action !== "unchanged") {
        const { stage: _s, ...rest } = changes as Record<string, unknown>;
        const fields = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith("channel."))) as Partial<C>;
        const stageFields = changes.stage ? { stage: overall, stageChangedAt: new Date() } : {};
        let saved: C;
        if (existing) saved = await this.repo.updateContact(existing.id, { ...fields, ...stageFields });
        else saved = await this.repo.insertContact({ ...fields, ...stageFields, firstSeenAt: (fields.firstSeenAt as Date | undefined) ?? new Date() } as Omit<C, "id" | "orgId">);
        contactId = saved.id;
        await this.repo.appendActivity({ action: existing ? "contact.updated" : "contact.created", entityType: "contact", entityId: saved.id, reason, payload: { ...changes, csv_row: rowNo } });
        if (stateChange) {
          const st = await this.repo.upsertChannelState(saved.id, ch!, { stage: chStage! });
          stateMap.set(stateKey(saved.id, ch!), st);
        }
        if (existing) contacts.splice(contacts.indexOf(existing), 1, saved);
        else contacts.push(saved);
        index(saved);
      } else if (!write && !existing) {
        // Simulate so later rows in the same file dedupe against this one.
        const ghost = { ...changes, id: `(row ${rowNo})`, name: p.name, companyId, contactType, stage: overall, email: changes.email ?? null, linkedin: changes.linkedin ?? null, xHandle: changes.xHandle ?? null, redditUser: changes.redditUser ?? null, github: changes.github ?? null } as unknown as C;
        contacts.push(ghost);
        index(ghost);
      }
      if (contactId) seenThisRun.add(contactId);
      else if (!write && !existing) seenThisRun.add(`(row ${rowNo})`);
      report.rows.push({ row: rowNo, action, label, contact_id: contactId, changes: action === "unchanged" ? undefined : changes, company: companyAction, warnings });
    }
    if (scoresRescaled) report.notices.push(`${scoresRescaled} score(s) above 5 treated as a 1-10 scale and rescaled to 1-5 (round(score/2)); originals kept in score_original`);
    return report;
  }

  async export_csv(raw: Input<"export_csv">) {
    requireScope(this.ctx, "crm:read");
    const i = schemas.export_csv.parse(raw);
    const [contacts, companies, states] = await Promise.all([this.repo.allContacts(), this.repo.allCompanies(), this.repo.allChannelStates()]);
    const cos = new Map(companies.map((c) => [c.id, c]));
    const rows = contacts
      .filter((c) => (!i.contact_type || c.contactType === i.contact_type) && (!i.stage || c.stage === i.stage) && (!i.campaign_id || c.campaignId === i.campaign_id))
      .map((c) => {
        const co = c.companyId ? cos.get(c.companyId) : undefined;
        const st = (ch: string) => states.find((s) => s.contactId === c.id && s.channel === ch);
        const handle = c.source === "reddit" ? c.redditUser : c.source === "linkedin" ? c.linkedin : c.xHandle ? `@${c.xHandle}` : (c.redditUser ?? c.github ?? "");
        const profile = c.source === "linkedin" || (!c.xHandle && c.linkedin) ? (c.linkedin ? `https://${c.linkedin}` : "") : c.xHandle ? `https://x.com/${c.xHandle}` : c.redditUser ? `https://reddit.com/user/${c.redditUser}` : "";
        return [
          handle, c.name, profile, c.bioSummary, c.followers, co?.name, c.role, c.estTeamSize, c.signalPostUrl, c.signalDate, c.signalSummary, c.score, c.source,
          c.contactType === "competitor" ? "competitor" : c.stage, c.firstSeenAt?.toISOString().slice(0, 10), c.notesText,
          c.id, c.email, c.xHandle, c.linkedin, c.redditUser, c.github, co?.domain, c.contactType, c.campaignId,
          ...OUTREACH_CHANNELS.flatMap((ch) => [st(ch)?.stage, st(ch)?.nextFollowupAt?.toISOString()]),
        ];
      });
    const header = [...IMPORT_COLUMNS, "id", "email", "x_handle", "linkedin_url", "reddit_user", "github", "company_domain", "contact_type", "campaign_id", ...OUTREACH_CHANNELS.flatMap((ch) => [`${ch}_stage`, `${ch}_next_followup_at`])];
    return { rows: rows.length, csv: toCsv(header, rows) };
  }
}

export const IMPORT_COLUMNS = ["handle", "name", "profile_url", "bio_summary", "followers", "company", "role", "est_team_size", "signal_post_url", "signal_post_date", "signal_summary", "score", "source", "status", "first_seen", "notes"];

interface ImportRowReport {
  row: number;
  action: "created" | "updated" | "unchanged" | "skipped";
  label: string;
  contact_id?: string;
  reason?: string;
  changes?: Record<string, unknown>;
  company?: string;
  warnings: string[];
}

const f = (a?: (string | null | undefined)[]) => (a ?? []).filter((x): x is string => !!x);
const reached = (s: Stage, touched: boolean) => rank(s) >= rank("contacted") || (s === "lost" && touched) || (s === "do_not_contact" && touched);
const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const stateKey = (cid: string, ch: string) => `${cid}:${ch}`;

/** Noon in `tz` on a YYYY-MM-DD date, a safe reference instant for that local day. */
function localNoon(day: string, tz: string) {
  const guess = new Date(`${day}T12:00:00Z`);
  const local = localDateString(guess, tz);
  return local === day ? guess : new Date(guess.getTime() + (local < day ? 1 : -1) * 12 * 3_600_000);
}

/** Free-form source -> canonical source. Unknown values are returned lowercased (caller infers). */
export function mapSource(raw?: string): string | undefined {
  const k = raw?.trim().toLowerCase();
  if (!k) return undefined;
  if (k.startsWith("reddit") || k.startsWith("prowlo") || k.includes("reddit")) return "reddit";
  if (k.startsWith("email") || k.startsWith("e-mail") || k === "mail") return "email";
  if (k.startsWith("linkedin")) return "linkedin";
  if (k === "x" || k.startsWith("x_") || k.startsWith("x-") || k.startsWith("twitter")) return "x";
  if (k.startsWith("handoff_") || k.startsWith("web")) return "web";
  return k;
}

/** "12" -> 12, "5-10" -> 8 (midpoint), "~50" -> 50; anything else kept as text only. Never warns. */
export function parseTeamSize(raw?: string): { estTeamSize: number | null; estTeamSizeText: string | null } {
  if (!raw) return { estTeamSize: null, estTeamSizeText: null };
  const t = raw.replace(/,/g, "").trim();
  const range = t.match(/^~?(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:people|ppl|employees)?$/i);
  if (range) return { estTeamSize: Math.round((Number(range[1]) + Number(range[2])) / 2), estTeamSizeText: raw };
  const n = t.match(/^~?(\d+)\+?\s*(?:people|ppl|employees)?$/i);
  if (n) return { estTeamSize: Number(n[1]), estTeamSizeText: null };
  return { estTeamSize: null, estTeamSizeText: raw };
}

const num = (v: string | undefined, warnings: string[], field: string) => {
  if (!v) return null;
  const m = v.replace(/,/g, "").trim().match(/^~?(\d+(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return warnings.push(`${field} not a number: ${v}`), null;
  const mult = m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1;
  return Math.round(parseFloat(m[1]!) * mult);
};

/** Pure parsing of one CSV row (exported for tests). */
export function parseImportRow(r: Record<string, string>, warnings: string[] = []) {
  const v = (k: string) => (r[k] ?? "").trim() || undefined;
  const ids = { email: null as string | null, linkedin: null as string | null, xHandle: null as string | null, redditUser: null as string | null, github: null as string | null };
  const srcRaw = v("source");
  let src = mapSource(srcRaw);
  const profile = v("profile_url");
  const host = profile?.replace(/^https?:\/\//i, "").replace(/^www\./i, "").toLowerCase() ?? "";
  if (/^(x|twitter)\.com\//.test(host)) ids.xHandle = normalizeXHandle(profile);
  else if (/linkedin\.com\//.test(host)) ids.linkedin = normalizeLinkedin(profile);
  else if (/reddit\.com\//.test(host)) ids.redditUser = normalizeRedditUser(profile);
  else if (/github\.com\//.test(host)) ids.github = normalizeGithub(profile);
  const handle = v("handle");
  if (handle) {
    if (isRedditRef(handle)) ids.redditUser ??= normalizeRedditUser(handle.replace(/^@/, ""));
    else if (/^https?:|\.com\//i.test(handle)) {
      const e = extractIdentities(handle);
      ids.xHandle ??= e.x[0] ?? null;
      ids.linkedin ??= e.linkedin[0] ?? null;
      ids.redditUser ??= e.reddit[0] ?? null;
      ids.github ??= e.github[0] ?? null;
    } else if (src === "reddit" || /^\/?u\//i.test(handle)) ids.redditUser ??= normalizeRedditUser(handle);
    else if (src === "linkedin") ids.linkedin ??= normalizeLinkedin(handle);
    else if (handle.includes("@") && !handle.startsWith("@")) ids.email ??= normalizeEmail(handle);
    else ids.xHandle ??= normalizeXHandle(handle);
    if (!Object.values(ids).some(Boolean)) warnings.push(`could not parse handle ${handle}`);
  }
  const notes = v("notes");
  const ex = extractIdentities([notes, v("bio_summary")].filter(Boolean).join("\n"));
  const take = (k: keyof typeof ids, list: string[], label: string) => {
    if (!list.length) return;
    if (!ids[k]) ids[k] = list[0]!;
    const extra = list.filter((x) => x !== ids[k]);
    if (extra.length) warnings.push(`extra ${label} in notes ignored: ${extra.join(", ")}`);
  };
  take("email", ex.emails, "emails");
  take("linkedin", ex.linkedin, "linkedin");
  take("github", ex.github, "github");
  take("redditUser", ex.reddit, "reddit");
  take("xHandle", ex.x, "x");
  if (!src || !(SOURCES as readonly string[]).includes(src)) {
    const inferred = ids.xHandle ? "x" : ids.linkedin ? "linkedin" : ids.redditUser ? "reddit" : ids.email ? "email" : "web";
    if (src) warnings.push(`unknown source ${src}; using ${inferred}`);
    src = inferred;
  }
  const source = src as (typeof SOURCES)[number];
  const channel: OutreachChannel | undefined = source === "x" || source === "linkedin" || source === "reddit" ? source : ids.email ? "email" : undefined;
  const mapped = mapStatus(v("status"));
  if (!mapped.known) warnings.push(`unknown status ${v("status")}; using new`);
  let score = num(v("score"), warnings, "score");
  let scoreOriginal: string | null = null;
  if (score !== null && score > 5 && score <= 10) {
    scoreOriginal = v("score")!;
    score = Math.max(1, Math.round(score / 2));
  }
  if (score !== null && (score < 1 || score > 5)) {
    warnings.push(`score ${score} out of 1-5; ignored`);
    score = null;
  }
  const firstSeenRaw = v("first_seen");
  const firstSeen = firstSeenRaw && !Number.isNaN(Date.parse(firstSeenRaw)) ? new Date(firstSeenRaw) : null;
  if (firstSeenRaw && !firstSeen) warnings.push(`first_seen not a date: ${firstSeenRaw}`);
  const companyRaw = v("company");
  const companyDomain = companyDomainFromEmail(ids.email) ?? (companyRaw && /^[^\s]+\.[a-z]{2,}$/i.test(companyRaw) ? normalizeDomain(companyRaw) : null);
  return {
    ids,
    name: v("name") ?? null,
    role: v("role") ?? null,
    bio: v("bio_summary") ?? null,
    followers: num(v("followers"), warnings, "followers"),
    ...parseTeamSize(v("est_team_size")),
    scoreOriginal,
    sourceDetail: srcRaw && srcRaw.toLowerCase() !== source ? srcRaw : null,
    score,
    source,
    channel,
    firstSeen,
    company: companyRaw ?? null,
    companyDomain,
    signalUrl: v("signal_post_url") ?? null,
    signalDate: v("signal_post_date") ?? null,
    signalSummary: v("signal_summary") ?? null,
    notes: notes ?? null,
    mapped,
  };
}

export const TOOL_DESCRIPTIONS: Record<keyof typeof schemas, string> = {
  search_contacts: "Search contacts in this org by text (name, email, role, handles, company), stage, company or tag.",
  get_contact: "Get one contact with company, tags, per-channel states, drafts, recent touches, open tasks and notes.",
  upsert_contact:
    "Create or update a contact. Deduped across email, x_handle, linkedin_url, reddit_user and github (all normalized; conflict if they match different contacts). Leads matching the competitor blocklist are rejected (error 'blocked').",
  upsert_company: "Create or update a company, deduped by normalized domain. Fields: team_size, stack, type, published_email.",
  log_touch: "Record a touch you made or received (the CRM never sends). Updates that channel's state (sent->contacted, inbound->responded) and the overall stage. Optionally sets next_followup_at or a follow-up task.",
  update_stage: "Set a contact's overall stage exactly (new, qualified, drafted, contacted, connection_pending, connected, responded, call_booked, pilot, paying, lost, do_not_contact).",
  list_due_followups: "List open tasks due before a time (default now), with their contacts.",
  create_task: "Create a task / next action, optionally tied to a contact, with a due date.",
  complete_task: "Mark a task completed.",
  add_note: "Attach a timestamped note to a contact or company.",
  get_activity: "Read the append-only activity log (who did what, why), newest first.",
  pipeline_summary: "Counts of contacts per overall stage and number of due tasks.",
  find_existing: "Have we seen this person? Looks up by any identity (email, X, LinkedIn, Reddit, GitHub, or `identity` = any of them) or company domain, plus fuzzy name(+company) candidates with the match reason. Also reports competitor matches. Call before creating a lead.",
  is_competitor: "Check a name/company/handle/domain/email (or an existing contact) against the competitor blocklist.",
  add_competitor: "Add a competitor to the blocklist (company name, handle/profile URL, or domain; kind inferred if omitted).",
  remove_competitor: "Remove a blocklist entry by id.",
  purge_competitors: "Bulk-delete blocklist entries by ids and/or a case-insensitive value_regex (optionally filtered by kind). dry_run defaults to true and lists matches; set dry_run=false to delete. Admin only.",
  list_competitors: "List the competitor blocklist.",
  set_channel_state: "Set a contact's state on one channel (x, linkedin, reddit, email): stage (exact), last_touch_at, next_followup_at (the reminder; null clears), next_step. Re-rolls the overall stage forward.",
  create_draft: "Save a message draft (state drafted) for a contact+channel, optionally with an intent_url and campaign. Rejected for competitors and do_not_contact. The CRM never sends.",
  transition_draft: "Move a draft: drafted->approved|discarded|drafted (edit text), approved->sent|discarded|drafted. Mark sent only after YOU sent it; that logs the touch, sets the channel to contacted and optional follow-up. All transitions go to the activity log.",
  list_drafts: "List drafts by state/channel/contact/campaign (e.g. state=approved for the send queue).",
  upsert_campaign: "Create or update a campaign (name unique; offer_text, status). Link contacts via upsert_contact.campaign_id and drafts via create_draft.campaign_id.",
  list_campaigns: "List campaigns.",
  list_contacts: "List contacts filtered by overall stage, channel and channel_stage, source, campaign, contact_type.",
  due_followups: "Channel follow-ups (next_followup_at) due by end of today in tz (default Asia/Saigon), flagged overdue, plus open tasks due.",
  stale_no_response: "Contacts contacted / connection_pending / connected on a channel with no touch for at least `days` days.",
  linkedin_needs_first_message: "LinkedIn contacts at connection_pending or connected with no outbound LinkedIn message logged yet.",
  x_pacing_today: "X pacing for today in tz: drafts created, sends, last send time, and whether the 60-min gap and <=8/day limits allow a send now (next_allowed_at).",
  outreach_report: "Per channel and per campaign: contacted, responded, response rate, LinkedIn acceptance rate, pilots, paying; plus goal tracker (3 paying or 10 pilots by 2026-12-15).",
  import_leads_csv: "Import a leads CSV (handle,name,profile_url,...,status,first_seen,notes). Maps status->stage, extracts emails/LinkedIn/GitHub/Reddit/X from notes, dedupes, skips competitors, idempotent on re-run. dry_run defaults to TRUE: returns the report without writing.",
  export_csv: "Export contacts as CSV (import columns first, then ids, identities and per-channel stage/follow-up).",
};
/** Tools that need admin (or owner) on top of crm:write. */
export const ADMIN_CRM_TOOLS = new Set<string>(["add_competitor", "remove_competitor", "purge_competitors", "upsert_campaign"]);
export const TOOL_NAMES = Object.keys(schemas) as (keyof typeof schemas)[];
export const WRITE_TOOLS = new Set<keyof typeof schemas>([
  "upsert_contact", "upsert_company", "log_touch", "update_stage", "create_task", "complete_task", "add_note",
  "add_competitor", "remove_competitor", "purge_competitors", "set_channel_state", "create_draft", "transition_draft", "upsert_campaign", "import_leads_csv",
]);
