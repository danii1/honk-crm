import { z } from "zod";
import { CHANNELS, DIRECTIONS, STAGES, TOUCH_STATUSES } from "./db/schema";
import { CrmError, requireScope, type OrgContext } from "./context";
import { companyDomainFromEmail, normalizeDomain, normalizeEmail, normalizeUrl, sha256 } from "./normalize";
import { Repository, type DB } from "./repository";

// ---------- input schemas (shared by MCP tools and REST routes)
const idem = z.string().min(8).max(200).optional().describe("Idempotency key; retries with the same key return the original result");
const reason = z.string().max(2000).optional().describe("Why the agent is doing this; stored in the activity log");
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
    title: z.string().optional(),
    linkedin: z.string().optional(),
    x: z.string().optional(),
    company_id: z.string().optional(),
    company_domain: z.string().optional().describe("Defaults to the email's domain unless it is a free-mail provider"),
    company_name: z.string().optional(),
    sequence_id: z.string().optional(),
    tags: z.array(z.string()).optional(),
    idempotency_key: idem,
    reason,
  }),
  upsert_company: z.object({
    domain: z.string(),
    name: z.string().optional(),
    website: z.string().optional(),
    linkedin: z.string().optional(),
    idempotency_key: idem,
    reason,
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
    idempotency_key: idem,
    reason,
  }),
  update_stage: z.object({ contact_id: z.string(), stage: z.enum(STAGES), idempotency_key: idem, reason }),
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
    reason,
  }),
  complete_task: z.object({ id: z.string(), idempotency_key: idem, reason }),
  add_note: z.object({
    entity_type: z.enum(["contact", "company"]).default("contact"),
    entity_id: z.string(),
    body: z.string().min(1),
    idempotency_key: idem,
    reason,
  }),
  get_activity: z.object({
    entity_type: z.string().optional(),
    entity_id: z.string().optional(),
    since: date.optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  pipeline_summary: z.object({}),
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
    const [company, touches, tasks, notes, tags] = await Promise.all([
      contact.companyId ? this.repo.companyById(contact.companyId) : undefined,
      this.repo.touchesForContact(id),
      this.repo.openTasksForContact(id),
      this.repo.notesFor("contact", id),
      this.repo.tagsForContact(id),
    ]);
    return { ...contact, company: company ?? null, tags, touches, open_tasks: tasks, notes };
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

  private async ensureCompany(domain: string, i: { name?: string; website?: string; linkedin?: string; reason?: string }) {
    const existing = await this.repo.companyByDomain(domain);
    const fields = {
      ...(i.name && { name: i.name }),
      ...(i.website && { website: i.website }),
      ...(i.linkedin && { linkedin: normalizeUrl(i.linkedin) }),
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

  async upsert_contact(raw: Input<"upsert_contact">) {
    const i = schemas.upsert_contact.parse(raw);
    return this.idempotent("upsert_contact", i, async () => {
      const email = normalizeEmail(i.email);
      const linkedin = normalizeUrl(i.linkedin);
      if (!email && !linkedin && !i.name) throw new CrmError("invalid", "need at least email, linkedin or name");

      // Company: explicit id > explicit domain > work-email domain.
      let companyId = i.company_id;
      if (companyId && !(await this.repo.companyById(companyId))) throw new CrmError("not_found", `company ${companyId} not found`);
      if (!companyId) {
        const domain = normalizeDomain(i.company_domain) ?? companyDomainFromEmail(email);
        if (domain) companyId = (await this.ensureCompany(domain, { name: i.company_name, reason: i.reason })).company.id;
      }
      if (i.sequence_id && !(await this.repo.sequenceById(i.sequence_id))) throw new CrmError("not_found", `sequence ${i.sequence_id} not found`);

      // Dedupe: normalized email first, then normalized LinkedIn URL.
      const existing = (email && (await this.repo.contactByEmail(email))) || (linkedin && (await this.repo.contactByLinkedin(linkedin))) || undefined;
      const fields = {
        ...(email && { email }),
        ...(linkedin && { linkedin }),
        ...(i.name && { name: i.name }),
        ...(i.title && { title: i.title }),
        ...(i.x && { x: i.x }),
        ...(companyId && { companyId }),
        ...(i.sequence_id && { sequenceId: i.sequence_id }),
      };
      let contact;
      let created = false;
      if (existing) {
        contact = await this.repo.updateContact(existing.id, fields);
        await this.repo.appendActivity({ action: "contact.updated", entityType: "contact", entityId: contact.id, reason: i.reason, payload: fields });
      } else {
        contact = await this.repo.insertContact(fields);
        created = true;
        await this.repo.appendActivity({ action: "contact.created", entityType: "contact", entityId: contact.id, reason: i.reason, payload: fields });
      }
      for (const name of i.tags ?? []) {
        const tag = await this.repo.ensureTag(name.trim().toLowerCase());
        await this.repo.tagContact(contact.id, tag.id);
      }
      return { contact, created, deduped: !created };
    });
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
      const touch = await this.repo.insertTouch({
        contactId: contact.id,
        sequenceId: i.sequence_id ?? contact.sequenceId,
        channel: i.channel,
        direction: i.direction,
        status: i.status,
        subject: i.subject,
        body: i.body,
        externalId: i.external_id,
        sentAt: i.status === "draft" ? null : (toDate(i.sent_at) ?? now),
        repliedAt: i.status === "replied" || i.direction === "inbound" ? now : null,
      });
      // Advance the pipeline automatically, never backwards.
      let stage = contact.stage;
      if ((i.direction === "inbound" || i.status === "replied") && (stage === "new" || stage === "contacted")) stage = "replied";
      else if (i.direction === "outbound" && i.status === "sent" && stage === "new") stage = "contacted";
      await this.repo.updateContact(contact.id, {
        lastTouchAt: now,
        ...(stage !== contact.stage && { stage, stageChangedAt: now }),
      });
      await this.repo.appendActivity({
        action: "touch.logged",
        entityType: "contact",
        entityId: contact.id,
        reason: i.reason,
        payload: { touch_id: touch.id, channel: i.channel, direction: i.direction, status: i.status, subject: i.subject, stage_from: contact.stage, stage_to: stage },
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
}

export const TOOL_DESCRIPTIONS: Record<keyof typeof schemas, string> = {
  search_contacts: "Search contacts in this org by text, stage, company or tag.",
  get_contact: "Get one contact with company, tags, recent touches, open tasks and notes.",
  upsert_contact: "Create or update a contact. Deduped by normalized email, then LinkedIn URL. Auto-links a company from the work-email domain.",
  upsert_company: "Create or update a company, deduped by normalized domain.",
  log_touch: "Record an outreach touch (email/linkedin/x/other). Advances stage new->contacted, ->replied on inbound. Optionally schedules a follow-up task.",
  update_stage: "Move a contact to a pipeline stage (new, contacted, replied, meeting, won, lost).",
  list_due_followups: "List open tasks due before a time (default now), with their contacts.",
  create_task: "Create a task / next action, optionally tied to a contact, with a due date.",
  complete_task: "Mark a task completed.",
  add_note: "Attach a note to a contact or company.",
  get_activity: "Read the append-only activity log (who did what, why), newest first.",
  pipeline_summary: "Counts of contacts per pipeline stage and number of due follow-ups.",
};
export const TOOL_NAMES = Object.keys(schemas) as (keyof typeof schemas)[];
export const WRITE_TOOLS = new Set<keyof typeof schemas>(["upsert_contact", "upsert_company", "log_touch", "update_stage", "create_task", "complete_task", "add_note"]);
