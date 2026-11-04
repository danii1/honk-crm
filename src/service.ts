import { z } from "zod";
import { BLOCK_KINDS, CHANNELS, CONTACT_TYPES, DIRECTIONS, DRAFT_STATES, EVENT_TYPES, OUTREACH_CHANNELS, STAGES, TOUCH_STATUSES, type EventType, type OutreachChannel, type Stage } from "./db/schema";
import { CrmError, requireRole, requireScope, type OrgContext } from "./context";
import {
  companyDomainFromEmail, endOfLocalDay, localDateString, normalizeDomain, normalizeEmail, normalizeGithub, normalizeLinkedin,
  isRedditRef, isThreadsRef, normalizeThreadsHandle, normalizeName, normalizeRedditUser, normalizeUrl, normalizeXHandle, sha256, similarNames, startOfLocalDay,
} from "./normalize";
import { advance, defaultMatchMode, DRAFT_TRANSITIONS, matchBlocklist, normalizeBlockValue, normalizeHandle, rank, rollup, type Probe } from "./rules";
import { extractIdentities, mapStatus, parseCsvObjects, toCsv } from "./csv";
import { Repository, type DB } from "./repository";
import { atLeast } from "./roles";
import { BUILTIN_CHANNELS, BUILTIN_REGISTRY, CHANNEL_ID_RE, ChannelRegistry, externalUrl, LEGACY_EXPORT_CHANNELS, KIND_INDEX, websiteUrl, type Identity } from "./channels";
import { LIFECYCLES, lifecycleCounts, lifecycleOf } from "./lifecycle";

// ---------- input schemas (shared by MCP tools and REST routes)
const idem = z.string().min(8).max(200).optional().describe("Idempotency key; retries with the same key return the original result");
const reasonField = z.string().max(2000).optional().describe("Why the agent is doing this; stored in the activity log");
const chan = z.string().trim().toLowerCase().regex(CHANNEL_ID_RE, "channel id").describe(`Channel id: ${BUILTIN_CHANNELS.map((c) => c.id).join(", ")} or an org custom channel (see list_channels)`);
const sourceArg = z.string().trim().toLowerCase().regex(CHANNEL_ID_RE, "source id").describe("Source: any channel id, web, prowlo or other");
const identitiesArg = z
  .array(z.object({ kind: z.string().min(1), value: z.string().min(1), scope: z.string().optional().describe("discord server / slack workspace") }))
  .max(50)
  .optional()
  .describe("Generic identities [{kind, value, scope?}]; kind = x_handle|linkedin_url|email|reddit_user|github|threads_handle|hn_user|discord_user|slack_user|bsky_handle|tiktok|instagram|youtube|facebook|telegram|whatsapp|<custom channel id> (a channel id or import prefix like hn, bsky, wa also works)");
// Plain ISO strings (not z.date) so the schema converts to JSON Schema for MCP.
const date = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "expected an ISO 8601 date/time").describe("ISO 8601 date/time");
/** Stored links must be http(s) or mailto; bare hosts are normalized to https at the write site. */
const externalUrlArg = z
  .string()
  .trim()
  .refine((v) => v === "" || externalUrl(v) !== null, "expected an http(s) or mailto URL");
const markSentBase = {
  draft_id: z.string().optional(),
  intent_url: z.string().optional().describe("Exact intent URL stored on the draft"),
  post_id: z.string().optional().describe("Id or URL of the post the draft replied to / targets (e.g. tweet id or x.com/.../status/ID)"),
  external_id: z.string().optional().describe("Id of the sent message (tweet id or URL, gmail message id)"),
  external_url: z.string().optional().describe("URL of the sent message"),
  thread_id: z.string().optional().describe("Thread id; defaults to post_id"),
  sent_at: date.optional(),
  next_followup_at: date.optional().describe("Override the per-channel default follow-up"),
  idempotency_key: idem,
  reason: reasonField,
};
const markSent = z.object(markSentBase).refine((v) => v.draft_id || v.intent_url || v.post_id || v.external_id || v.external_url, "give draft_id, intent_url, post_id, external_id or external_url");
const channelDays = z.record(chan, z.number().min(0).max(365)).optional();
const toDate = (v: string | undefined) => (v === undefined ? undefined : new Date(v));

const CLEARABLE = ["x_handle", "linkedin_url", "reddit_user", "github", "threads_handle", "email", "profile_url", "website", "company_id"] as const;
const CLEAR_FIELD = { x_handle: "xHandle", linkedin_url: "linkedin", reddit_user: "redditUser", github: "github", threads_handle: "threadsHandle", email: "email", profile_url: "profileUrl", website: "website", company_id: "companyId" } as const;

export const schemas = {
  search_contacts: z.object({
    query: z.string().optional().describe("Matches name, email, title, linkedin, company name/domain"),
    stage: z.enum(STAGES).optional(),
    company_id: z.string().optional(),
    tag: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(25),
  }),
  get_contact: z.object({ id: z.string(), include_private: z.boolean().default(false).describe("Admin only: reveal private identities (whatsapp phone)") }),
  upsert_contact: z.object({
    email: z.string().optional(),
    name: z.string().optional(),
    role: z.string().optional(),
    title: z.string().optional().describe("Alias of role"),
    linkedin_url: z.string().optional(),
    linkedin: z.string().optional().describe("Alias of linkedin_url"),
    contact_id: z.string().optional().describe("Update this exact contact (identities may then be changed/cleared)"),
    x_handle: z.string().optional().describe("@handle or x.com URL"),
    x: z.string().optional().describe("Alias of x_handle"),
    reddit_user: z.string().optional().describe("u/name or reddit.com/user URL"),
    github: z.string().optional().describe("login or github.com URL"),
    threads_handle: z.string().optional().describe("@handle or threads.net / threads.com URL"),
    identities: identitiesArg,
    campaign_id: z.string().optional(),
    contact_type: z.enum(CONTACT_TYPES).optional().describe("lead (default) or competitor. Leads matching the competitor blocklist are rejected."),
    source: sourceArg.optional(),
    source_detail: z.string().optional().describe("Raw source value"),
    profile_url: z.string().optional().describe("Raw profile URL as given; stored and exported verbatim"),
    website: z.string().optional().describe("Personal or company website (non-social URL)"),
    clear: z.array(z.enum(CLEARABLE)).optional().describe("Fields to set to NULL (requires contact_id or a matching identity)"),
    bio_summary: z.string().optional(),
    followers: z.number().int().min(0).optional(),
    est_team_size: z.number().int().min(0).optional(),
    score: z.number().int().min(1).max(5).optional(),
    first_seen: date.optional(),
    notes: z.string().optional().describe("Free-text notes field on the contact (see add_note for timestamped notes)"),
    signal_post_url: externalUrlArg.optional(),
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
    channel: chan,
    direction: z.enum(DIRECTIONS).default("outbound"),
    status: z.enum(TOUCH_STATUSES).default("sent"),
    subject: z.string().optional(),
    body: z.string().optional(),
    external_id: z.string().optional().describe("Message id in the sending system; deduped per org+channel"),
    external_url: z.string().optional(),
    thread_id: z.string().optional().describe("Thread id (tweet conversation/status id, gmail threadId, reddit post id)"),
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
    threads_handle: z.string().optional(),
    identities: identitiesArg,
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
    match: z.enum(["exact", "fuzzy"]).optional().describe("Name entries only. exact = a person or company name equal to the full name (legal suffixes like Inc/Ltd/Labs/AI ignored on both sides); fuzzy = exact plus the full name as whole words inside a company name (never just part of it). Default: exact for single words of <=7 chars, else fuzzy"),
    idempotency_key: idem,
    reason: reasonField,
  }),
  update_competitor: z.object({
    id: z.string(),
    value: z.string().min(1).optional().describe("New full name/handle/domain (re-normalized; display name stored as given)"),
    match: z.enum(["exact", "fuzzy"]).optional().describe("exact | fuzzy (see add_competitor)"),
    label: z.string().optional(),
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
    channel: chan,
    stage: z.enum(STAGES).optional().describe("Set exactly (may move backwards). Omit to keep."),
    last_touch_at: date.optional(),
    next_followup_at: date.nullable().optional().describe("null clears the reminder"),
    next_step: z.string().nullable().optional(),
    idempotency_key: idem,
    reason: reasonField,
  }),
  create_draft: z.object({
    contact_id: z.string(),
    channel: chan,
    text: z.string().min(1),
    intent_url: externalUrlArg.optional().describe("e.g. an x.com/intent URL the human clicks to send"),
    thread_id: z.string().optional().describe("Thread the draft replies into (tweet/conversation id, gmail threadId, reddit post id)"),
    campaign_id: z.string().optional().describe("Defaults to the contact's campaign"),
    idempotency_key: idem,
    reason: reasonField,
  }),
  transition_draft: z.object({
    draft_id: z.string(),
    to: z.enum(DRAFT_STATES).describe("drafted->approved|discarded|drafted(edit), approved->sent|discarded|drafted. sent/discarded are final."),
    text: z.string().min(1).optional().describe("New text; only when moving to drafted"),
    intent_url: externalUrlArg.optional(),
    external_id: z.string().optional().describe("When to=sent: id/URL of the sent message"),
    sent_at: date.optional().describe("When to=sent; defaults to now"),
    next_followup_at: date.optional().describe("When to=sent: reminder on the channel"),
    follow_up_in_days: z.number().min(0).max(365).optional().describe("When to=sent: reminder N days after sending"),
    idempotency_key: idem,
    reason: reasonField,
  }),
  list_drafts: z.object({
    state: z.enum(DRAFT_STATES).optional(),
    channel: chan.optional(),
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
    lifecycle: z.enum(LIFECYCLES).optional().describe("lead = still prospecting, contact = relationship (responded+), archived = lost/do_not_contact. Ignored when stage is set."),
    channel: chan.optional(),
    channel_stage: z.enum(STAGES).optional().describe("Stage on `channel` (or any channel)"),
    source: sourceArg.optional(),
    campaign_id: z.string().optional(),
    contact_type: z.enum(CONTACT_TYPES).optional(),
    query: z.string().optional().describe("Search name, email, role, handles, identities or company"),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  list_contacts_view: z.object({
    lifecycle: z.enum(LIFECYCLES).optional().describe("lead | contact | archived; omit for all"),
    stage: z.enum(STAGES).optional(),
    channel: chan.optional(),
    channel_stage: z.enum(STAGES).optional(),
    source: sourceArg.optional(),
    campaign_id: z.string().optional(),
    contact_type: z.enum(CONTACT_TYPES).optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(1000).default(500),
    offset: z.number().int().min(0).default(0).describe("Rows to skip; use with limit for pagination"),
  }),
  list_companies: z.object({
    query: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(200),
    offset: z.number().int().min(0).default(0).describe("Rows to skip; use with limit for pagination"),
  }),
  due_followups: z.object({
    today: z.string().optional().describe("YYYY-MM-DD or ISO time in `tz`; defaults to now"),
    tz: z.string().default("Asia/Saigon"),
    include_tasks: z.boolean().default(true),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  stale_no_response: z.object({
    days: z.number().min(0).max(365).optional().describe("Override; default per channel from org followup rules (x 6, linkedin 10, email 8, reddit 8)"),
    channel: chan.optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  linkedin_needs_first_message: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
  linkedin_connected_no_first_message: z.object({
    days: z.number().min(0).max(365).default(0).describe("Connected for at least this many days"),
    limit: z.number().int().min(1).max(500).default(100),
  }),
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
  mark_draft_sent: markSent,
  sync_sent: z.object({
    items: z.array(markSent).min(1).max(200),
    idempotency_key: idem,
    reason: reasonField,
  }),
  record_event: z.object({
    type: z.enum(EVENT_TYPES),
    channel: chan,
    external_id: z.string().min(1).describe("Tweet id, gmail message id, linkedin profile...; deduped per org+channel+type"),
    thread_id: z.string().optional(),
    contact_id: z.string().optional(),
    x_handle: z.string().optional(),
    linkedin_url: z.string().optional(),
    email: z.string().optional(),
    reddit_user: z.string().optional(),
    github: z.string().optional(),
    threads_handle: z.string().optional(),
    identities: identitiesArg,
    occurred_at: date.optional(),
    summary: z.string().max(4000).optional(),
    idempotency_key: idem,
    reason: reasonField,
  }),
  find_by_thread: z.object({ channel: chan, thread_id: z.string().min(1) }),
  get_followup_rules: z.object({}),
  set_followup_rules: z.object({
    followup_days: channelDays.describe("Days after contact to schedule the follow-up"),
    stale_days: channelDays.describe("Days without response before stale_no_response flags it"),
    reason: reasonField,
  }),
  bulk_update_stage: z.object({
    items: z.array(z.object({ contact_id: z.string(), channel: chan.optional(), stage: z.enum(STAGES), idempotency_key: idem })).min(1).max(500),
    idempotency_key: idem,
    reason: reasonField,
  }),
  daily_overview: z.object({ tz: z.string().default("Asia/Saigon"), limit: z.number().int().min(1).max(500).default(50) }),
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
    derived_profile_url: z.boolean().default(false).describe("Export profile_url rebuilt from identities instead of the raw imported value"),
    include_private: z.boolean().default(false).describe("Admin only: reveal private identities (whatsapp) in the identities column"),
  }),
  list_channels: z.object({}),
  add_custom_channel: z.object({
    id: z.string().trim().toLowerCase().regex(CHANNEL_ID_RE, "lowercase id, 2-32 chars [a-z0-9_]"),
    label: z.string().min(1).max(60),
    url_pattern: z.string().max(200).optional().describe("Profile URL with {handle}, e.g. https://mastodon.social/@{handle}"),
    prefix: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{0,15}$/).optional().describe("Import/identity prefix, e.g. masto (masto:alice)"),
    followup_days: z.number().int().min(0).max(365).optional(),
    stale_days: z.number().int().min(0).max(365).optional(),
    idempotency_key: idem,
    reason: reasonField,
  }),
  find_by_identity: z.object({
    value: z.string().min(1).describe("Handle, URL, phone, or prefix form like hn:pg, discord:server/user, wa:+84..."),
    kind: z.string().optional().describe("Identity kind or channel id; omitted = parse value as prefix form or URL"),
    scope: z.string().optional(),
  }),
};
export type Input<K extends keyof typeof schemas> = z.input<(typeof schemas)[K]>;

const DAY = 86_400_000;
const TZ = "Asia/Saigon";
export const DEFAULT_FOLLOWUP_DAYS: Record<OutreachChannel, number> = Object.fromEntries(BUILTIN_CHANNELS.map((c) => [c.id, c.followupDays]));
export const DEFAULT_STALE_DAYS: Record<OutreachChannel, number> = Object.fromEntries(BUILTIN_CHANNELS.map((c) => [c.id, c.staleDays]));
const TERMINAL: Stage[] = ["paying", "lost", "do_not_contact"];
/** Pull a post/status id out of a tweet URL (or return the value itself). */
export function postId(ref?: string): string | undefined {
  if (!ref) return undefined;
  const m = /\/status(?:es)?\/(\d+)/.exec(ref) ?? /[?&](?:in_reply_to|tweet_id)=(\d+)/.exec(ref);
  return m ? m[1] : ref.trim();
}
const EVENT_STAGE: Record<EventType, { stage: Stage; nextStep?: string | null; followup?: "clear" | "today" }> = {
  reply_received: { stage: "responded", nextStep: "reply", followup: "clear" },
  email_reply: { stage: "responded", nextStep: "reply", followup: "clear" },
  connection_accepted: { stage: "connected", nextStep: "send first message", followup: "today" },
  meeting_booked: { stage: "call_booked", followup: "clear" },
  connection_requested: { stage: "connection_pending", nextStep: "check acceptance" },
};

const pickDraft = (ds: Awaited<ReturnType<Repository["draftsByIntentUrl"]>>, by: string) => {
  const open = ds.filter((d) => d.state === "drafted" || d.state === "approved");
  if (open.length > 1) throw new CrmError("conflict", `${open.length} open drafts match by ${by}; pass draft_id (${open.map((d) => d.id).join(", ")})`);
  const d = open[0] ?? ds.find((x) => x.state === "sent");
  return d ? { draft: d, matched_by: by } : undefined;
};

export class CrmService {
  readonly repo: Repository;
  constructor(db: DB, readonly ctx: OrgContext) {
    this.repo = new Repository(db, ctx);
  }

  private regP?: Promise<ChannelRegistry>;
  /** Built-in channels + this org's custom channels (cached per request). */
  registry() {
    return (this.regP ??= this.repo.customChannels().then((c) => new ChannelRegistry(c)));
  }
  /** Zod-parses tool input, then validates channel/source ids against the registry (no DB enums). */
  private async parse<K extends keyof typeof schemas>(k: K, raw: unknown): Promise<z.output<(typeof schemas)[K]>> {
    const i = schemas[k].parse(raw) as z.output<(typeof schemas)[K]>;
    const o = i as Record<string, unknown>;
    const chans = [o.channel, ...(Array.isArray(o.items) ? o.items.map((x) => (x as { channel?: unknown }).channel) : [])].filter((c): c is string => typeof c === "string");
    const srcs = [o.source].filter((c): c is string => typeof c === "string");
    if (chans.length || srcs.length) {
      const reg = await this.registry();
      for (const c of chans) if (!(k === "log_touch" ? reg.isTouchChannel(c) : reg.isChannel(c))) throw new CrmError("invalid", `unknown channel ${c}; see list_channels`);
      for (const c of srcs) if (!reg.isSource(c)) throw new CrmError("invalid", `unknown source ${c}; use a channel id, web, prowlo or other`);
    }
    return i;
  }
  /** Splits generic identities into legacy fields (mutating ids) and extra identities. */
  private async splitIdentities(list: { kind: string; value: string; scope?: string }[] | undefined, ids: Record<string, string | null>) {
    const reg = await this.registry();
    const extra: Identity[] = [];
    for (const x of list ?? []) {
      const n = reg.normalize(x.kind, x.value, x.scope);
      if (!n) throw new CrmError("invalid", `could not parse ${x.kind} from ${JSON.stringify(x.value)}`);
      const col = KIND_INDEX.get(n.kind)?.legacyColumn;
      if (col) {
        if (ids[col] && ids[col] !== n.value) throw new CrmError("invalid", `${n.kind} given twice with different values`);
        ids[col] = n.value;
      } else extra.push(n);
    }
    return extra;
  }
  /** Identities of a contact for output; private kinds (whatsapp) masked unless admin + include_private. */
  async identitiesView(contactId: string, includePrivate = false) {
    const reg = await this.registry();
    const reveal = includePrivate && atLeast(this.ctx.role, "admin");
    return (await this.repo.identitiesFor(contactId)).map((r) => this.identityRow(reg, r, reveal));
  }

  private identityRow(reg: ChannelRegistry, r: { kind: string; valueNormalized: string; scope: string }, reveal: boolean) {
    const kind = reg.kind(r.kind);
    const privateKind = reg.isPrivateKind(r.kind);
    const visible = !privateKind || reveal;
    return {
      kind: r.kind,
      channel: kind?.channel ?? r.kind,
      label: kind?.label ?? r.kind,
      value: reg.display({ kind: r.kind, value: r.valueNormalized }, reveal),
      scope: r.scope || undefined,
      private: privateKind || undefined,
      url: visible ? reg.profileUrl(r.kind, r.valueNormalized, r.scope) : null,
    };
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
    const i = await this.parse("search_contacts", raw);
    return this.repo.searchContacts({ query: i.query, stage: i.stage, companyId: i.company_id, tag: i.tag, limit: i.limit });
  }

  async get_contact(raw: Input<"get_contact">) {
    requireScope(this.ctx, "crm:read");
    const { id } = await this.parse("get_contact", raw);
    const contact = await this.repo.contactById(id);
    if (!contact) throw new CrmError("not_found", `contact ${id} not found`);
    const [company, touches, tasks, notes, tags, channel_states, drafts, events] = await Promise.all([
      contact.companyId ? this.repo.companyById(contact.companyId) : undefined,
      this.repo.touchesForContact(id),
      this.repo.openTasksForContact(id),
      this.repo.notesFor("contact", id),
      this.repo.tagsForContact(id),
      this.repo.channelStatesFor(id),
      this.repo.listDrafts({ contactId: id, limit: 50 }),
      this.repo.eventsForContact(id),
    ]);
    const include = (raw as { include_private?: boolean }).include_private === true;
    if (include) requireRole(this.ctx, "admin");
    return {
      ...contact,
      lifecycle: lifecycleOf(contact.stage),
      company: company ? { ...company, website_url: websiteUrl(company.website ?? company.domain) } : null,
      identities: await this.identitiesView(id, include),
      tags,
      channel_states,
      drafts,
      touches,
      events,
      open_tasks: tasks,
      notes,
    };
  }

  async list_due_followups(raw: Input<"list_due_followups">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("list_due_followups", raw);
    return this.repo.openTasksDueBy(toDate(i.before) ?? new Date(), i.limit);
  }

  async get_activity(raw: Input<"get_activity">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("get_activity", raw);
    return this.repo.activity({ entityType: i.entity_type, entityId: i.entity_id, since: toDate(i.since), limit: i.limit });
  }

  async pipeline_summary(_raw: Input<"pipeline_summary"> = {}) {
    requireScope(this.ctx, "crm:read");
    const counts = await this.repo.stageCounts();
    const by = Object.fromEntries(STAGES.map((st) => [st, 0])) as Record<(typeof STAGES)[number], number>;
    for (const c of counts) by[c.stage] = Number(c.count);
    const due = await this.repo.openTasksDueBy(new Date(), 500);
    return { stages: by, lifecycles: lifecycleCounts(by), total: Object.values(by).reduce((a, b) => a + b, 0), due_followups: due.length };
  }

  // ---------- writes
  async upsert_company(raw: Input<"upsert_company">) {
    const i = await this.parse("upsert_company", raw);
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

  private identitiesOf(i: { email?: string; linkedin_url?: string; linkedin?: string; x_handle?: string; x?: string; reddit_user?: string; github?: string; threads_handle?: string }) {
    return {
      email: normalizeEmail(i.email),
      linkedin: normalizeLinkedin(i.linkedin_url ?? i.linkedin),
      xHandle: normalizeXHandle(i.x_handle ?? i.x),
      redditUser: normalizeRedditUser(i.reddit_user),
      github: normalizeGithub(i.github),
      threadsHandle: normalizeThreadsHandle(i.threads_handle),
    };
  }

  async upsert_contact(raw: Input<"upsert_contact">) {
    const i = await this.parse("upsert_contact", raw);
    return this.idempotent("upsert_contact", i, async () => {
      const ids = this.identitiesOf(i);
      for (const [k, v] of [["linkedin_url", i.linkedin_url ?? i.linkedin], ["x_handle", i.x_handle ?? i.x], ["reddit_user", i.reddit_user], ["github", i.github], ["threads_handle", i.threads_handle]] as const) {
        const key = ({ linkedin_url: "linkedin", x_handle: "xHandle", reddit_user: "redditUser", github: "github", threads_handle: "threadsHandle" } as const)[k];
        if (v && !ids[key]) throw new CrmError("invalid", `could not parse ${k} from ${JSON.stringify(v)}`);
      }
      const extra = await this.splitIdentities(i.identities, ids);
      if (!Object.values(ids).some(Boolean) && !extra.length && !i.name && !i.contact_id) throw new CrmError("invalid", "need at least one identity (email, x_handle, linkedin_url, reddit_user, github, threads_handle, identities[]) or a name");

      // Dedupe across every identity (contact_identities). Two different contacts matching = conflict the caller must resolve.
      const found = await this.repo.contactsByIdentity(ids, extra);
      const pinned = i.contact_id ? await this.repo.contactById(i.contact_id) : undefined;
      if (i.contact_id && !pinned) throw new CrmError("not_found", `contact ${i.contact_id} not found`);
      const matches = pinned ? found.filter((m) => m.id !== pinned.id) : found;
      if (pinned && matches.length) throw new CrmError("conflict", `identities already belong to other contacts: ${matches.map((m) => m.id).join(", ")}`);
      if (!pinned && matches.length > 1) throw new CrmError("conflict", `identities match ${matches.length} different contacts: ${matches.map((m) => m.id).join(", ")}`);
      const existing = pinned ?? matches[0];
      if (i.clear?.length && !existing) throw new CrmError("invalid", "clear needs an existing contact (contact_id or matching identity)");

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
          handles: [ids.xHandle, ids.github, ids.redditUser, ids.threadsHandle, ids.linkedin?.split("/").pop(), ...extra.filter((x) => !KIND_INDEX.get(x.kind)?.private).map((x) => x.value.replace(/^@/, ""))],
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
        ...(ids.threadsHandle && { threadsHandle: ids.threadsHandle }),
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
        ...(i.signal_post_url && { signalPostUrl: externalUrl(i.signal_post_url)! }),
        ...(i.signal_date && { signalDate: i.signal_date }),
        ...(i.signal_summary && { signalSummary: i.signal_summary }),
        ...(i.source_detail && { sourceDetail: i.source_detail }),
        ...(i.profile_url && { profileUrl: i.profile_url.trim() }),
        ...(i.website && { website: i.website.trim() }),
        ...Object.fromEntries((i.clear ?? []).map((k) => [CLEAR_FIELD[k], null])),
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
      if (extra.length) await this.repo.addIdentities(contact.id, extra);
      return { contact, created, deduped: !created, identities: await this.identitiesView(contact.id) };
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
    if (to === "contacted" && from !== "contacted" && v.nextFollowupAt === undefined) {
      const days = (await this.followupRules()).followup_days[channel];
      v = { ...v, nextFollowupAt: new Date(startOfLocalDay(v.lastTouchAt ?? new Date(), TZ).getTime() + (days ?? 3) * DAY + 9 * 3_600_000) };
    }
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
    const i = await this.parse("log_touch", raw);
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
            ...(i.next_followup_at ? { nextFollowupAt: new Date(i.next_followup_at) } : inbound ? { nextFollowupAt: null } : {}),
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
    t: { channel: (typeof CHANNELS)[number]; direction: "outbound" | "inbound"; status: (typeof TOUCH_STATUSES)[number]; subject?: string; body?: string; external_id?: string; external_url?: string; thread_id?: string; sentAt: Date; sequenceId?: string | null },
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
      externalUrl: t.external_url,
      threadId: t.thread_id,
      sentAt: t.status === "draft" ? null : t.sentAt,
      repliedAt: t.status === "replied" || t.direction === "inbound" ? t.sentAt : null,
    });
  }

  async update_stage(raw: Input<"update_stage">) {
    const i = await this.parse("update_stage", raw);
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
    const i = await this.parse("create_task", raw);
    return this.idempotent("create_task", i, () =>
      this.createTask({ title: i.title, contactId: i.contact_id, dueAt: toDate(i.due_at), assignee: i.assignee, reason: i.reason }),
    );
  }

  async complete_task(raw: Input<"complete_task">) {
    const i = await this.parse("complete_task", raw);
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
    const i = await this.parse("add_note", raw);
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
    const i = await this.parse("find_existing", raw);
    const any = i.identity;
    const ids = {
      email: normalizeEmail(i.email ?? (any?.includes("@") && !any.startsWith("@") ? any : undefined)),
      linkedin: normalizeLinkedin(i.linkedin_url ?? (any && /linkedin\.com/i.test(any) ? any : undefined)),
      xHandle: normalizeXHandle(i.x_handle ?? (any && !/linkedin|github|reddit|threads/i.test(any) ? any : undefined)),
      redditUser: normalizeRedditUser(i.reddit_user ?? (any && (/reddit\.com|^\/?u\//i.test(any) || !/[./@]/.test(any)) ? any : undefined)),
      github: normalizeGithub(i.github ?? (any && (/github\.com/i.test(any) || !/[./@]/.test(any)) ? any : undefined)),
      threadsHandle: normalizeThreadsHandle(i.threads_handle ?? (any && (isThreadsRef(any) || !/[/@]/.test(any)) ? any : undefined)),
    };
    const extra = await this.splitIdentities(i.identities, ids);
    const guessed = any ? (await this.registry()).parse(any) : null;
    if (guessed && !KIND_INDEX.get(guessed.kind)?.legacyColumn) extra.push(guessed);
    const domain = normalizeDomain(i.domain) ?? companyDomainFromEmail(ids.email);
    const exact = (await this.repo.contactsByIdentity(ids, extra)).map((c) => ({
      contact: c,
      matched_kinds: c.matchedKinds,
      match: (["email", "linkedin", "xHandle", "redditUser", "github", "threadsHandle"] as const).filter((k) => ids[k] && c[k] === ids[k]).map((k) => ({ xHandle: "x_handle", redditUser: "reddit_user", linkedin: "linkedin_url", threadsHandle: "threads_handle" } as Record<string, string>)[k] ?? k),
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
      await this.blockProbe({ names: [i.name], companies: [i.company], handles: [ids.xHandle, ids.github, ids.redditUser, ids.threadsHandle, ids.linkedin?.split("/").pop(), ...extra.filter((x) => !KIND_INDEX.get(x.kind)?.private).map((x) => x.value.replace(/^@/, ""))], domains: [domain] }),
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
    const i = await this.parse("is_competitor", raw);
    const probe = await this.blockProbe({ names: [i.name], companies: [i.company], handles: i.handle ? [(await this.registry()).parse(i.handle)?.value.replace(/^@/, "") ?? normalizeHandle(i.handle)] : [], domains: [i.domain, normalizeDomain(i.email)] });
    if (i.contact_id) {
      const c = await this.repo.contactById(i.contact_id);
      if (!c) throw new CrmError("not_found", `contact ${i.contact_id} not found`);
      const co = c.companyId ? await this.repo.companyById(c.companyId) : undefined;
      probe.personNames.push(...[c.name].filter((x): x is string => !!x));
      probe.companyNames.push(...[co?.name].filter((x): x is string => !!x));
      probe.handles.push(...[c.xHandle, c.github, c.redditUser, c.threadsHandle, c.linkedin?.split("/").pop()].filter((x): x is string => !!x));
      probe.handles.push(...(await this.repo.identitiesFor(c.id)).filter((r) => !KIND_INDEX.get(r.kind)?.legacyColumn && !KIND_INDEX.get(r.kind)?.private).map((r) => r.valueNormalized.replace(/^@/, "")));
      probe.domains.push(...[co?.domain, normalizeDomain(c.email)].filter((x): x is string => !!x));
      if (c.contactType === "competitor") return { is_competitor: true, matches: [{ entry: null, matched_on: "contact_type:competitor" }] };
    }
    const matches = await this.competitorHits(probe);
    return { is_competitor: matches.length > 0, matches };
  }

  async add_competitor(raw: Input<"add_competitor">) {
    const i = await this.parse("add_competitor", raw);
    requireRole(this.ctx, "admin");
    return this.idempotent("add_competitor", i, async () => {
      const n = normalizeBlockValue(i.kind, i.value);
      if (!n) throw new CrmError("invalid", `could not normalize ${JSON.stringify(i.value)}`);
      const entry = await this.repo.insertBlock(n.kind, n.value, i.label ?? i.value, i.match ?? defaultMatchMode(n.kind, n.value, i.value), i.value.trim());
      await this.repo.appendActivity({ action: "blocklist.added", entityType: "blocklist", entityId: entry.id, reason: i.reason, payload: { ...n, input: i.value, match: entry.match } });
      return entry;
    });
  }

  async update_competitor(raw: Input<"update_competitor">) {
    const i = await this.parse("update_competitor", raw);
    requireRole(this.ctx, "admin");
    return this.idempotent("update_competitor", i, async () => {
      const cur = await this.repo.blockById(i.id);
      if (!cur) throw new CrmError("not_found", `blocklist entry ${i.id} not found`);
      const patch: Parameters<typeof this.repo.updateBlock>[1] = {};
      if (i.value !== undefined) {
        const n = normalizeBlockValue(cur.kind, i.value);
        if (!n) throw new CrmError("invalid", `could not normalize ${JSON.stringify(i.value)}`);
        const dup = (await this.repo.blocklistAll()).find((e) => e.kind === n.kind && e.value === n.value && e.id !== cur.id);
        if (dup) throw new CrmError("conflict", `entry ${dup.id} already has value ${n.value}`);
        patch.value = n.value;
        patch.displayName = i.value.trim();
      }
      if (i.match) patch.match = i.match;
      if (i.label !== undefined) patch.label = i.label;
      const entry = await this.repo.updateBlock(cur.id, patch);
      await this.repo.appendActivity({
        action: "blocklist.updated", entityType: "blocklist", entityId: cur.id, reason: i.reason,
        payload: { before: { value: cur.value, display_name: cur.displayName, match: cur.match, label: cur.label }, after: patch },
      });
      return entry;
    });
  }

  async remove_competitor(raw: Input<"remove_competitor">) {
    const i = await this.parse("remove_competitor", raw);
    requireRole(this.ctx, "admin");
    return this.idempotent("remove_competitor", i, async () => {
      const gone = await this.repo.deleteBlock(i.id);
      if (!gone) throw new CrmError("not_found", `blocklist entry ${i.id} not found`);
      await this.repo.appendActivity({ action: "blocklist.removed", entityType: "blocklist", entityId: i.id, reason: i.reason, payload: { kind: gone.kind, value: gone.value } });
      return { removed: gone };
    });
  }

  async purge_competitors(raw: Input<"purge_competitors">) {
    const i = await this.parse("purge_competitors", raw);
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
    const i = await this.parse("set_channel_state", raw);
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
    const parsed = await this.parse("create_draft", raw);
    // Normalize before hashing/inserting so retries with the bare or normalized URL are one request.
    const i = { ...parsed, ...(parsed.intent_url ? { intent_url: externalUrl(parsed.intent_url)! } : {}) };
    return this.idempotent("create_draft", i, async () => {
      const contact = await this.repo.contactById(i.contact_id);
      if (!contact) throw new CrmError("not_found", `contact ${i.contact_id} not found`);
      if (contact.contactType === "competitor") throw new CrmError("blocked", "contact is a competitor");
      if (contact.stage === "do_not_contact") throw new CrmError("blocked", "contact is do_not_contact");
      const state = await this.repo.channelState(contact.id, i.channel);
      if (state?.stage === "do_not_contact") throw new CrmError("blocked", `contact is do_not_contact on ${i.channel}`);
      const campaignId = i.campaign_id ?? contact.campaignId;
      if (i.campaign_id && !(await this.repo.campaignById(i.campaign_id))) throw new CrmError("not_found", `campaign ${i.campaign_id} not found`);
      const draft = await this.repo.insertDraft({ contactId: contact.id, channel: i.channel, text: i.text, intentUrl: i.intent_url || undefined, threadId: i.thread_id, campaignId, state: "drafted", stateChangedAt: new Date() });
      await this.repo.appendActivity({ action: "draft.created", entityType: "draft", entityId: draft.id, reason: i.reason, payload: { contact_id: contact.id, channel: i.channel, campaign_id: campaignId } });
      await this.bumpChannel(contact.id, i.channel, { stage: "drafted" }, i.reason);
      return draft;
    });
  }

  async transition_draft(raw: Input<"transition_draft">) {
    const parsed = await this.parse("transition_draft", raw);
    const i = { ...parsed, ...(parsed.intent_url ? { intent_url: externalUrl(parsed.intent_url)! } : {}) };
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
        const followup = i.next_followup_at ? new Date(i.next_followup_at) : i.follow_up_in_days !== undefined ? new Date(sentAt!.getTime() + i.follow_up_in_days * DAY) : undefined;
        ({ touch, pacing } = await this.afterSent(updated, { sentAt: sentAt!, externalId: i.external_id, followup, reason: i.reason }));
      } else if (i.to === "discarded") {
        // A discarded draft no longer holds the channel at "drafted".
        const st = await this.repo.channelState(draft.contactId, draft.channel);
        const open = (await this.repo.listDrafts({ contactId: draft.contactId, channel: draft.channel, limit: 200 })).some((d) => d.state === "drafted" || d.state === "approved");
        if (st?.stage === "drafted" && !open) await this.bumpChannel(draft.contactId, draft.channel, { stage: "qualified", exact: true }, i.reason);
      }
      return { draft: updated, touch, x_pacing_before_send: pacing };
    });
  }

  /** Shared "a draft was sent" side effects: touch, channel stage/followup, contact last touch, activity. */
  private async afterSent(draft: { id: string; contactId: string; channel: OutreachChannel; text: string; threadId?: string | null }, o: { sentAt: Date; externalId?: string; externalUrl?: string; followup?: Date; reason?: string }) {
    const contact = (await this.repo.contactById(draft.contactId))!;
    const pacing = draft.channel === "x" ? await this.x_pacing_today({ now: o.sentAt.toISOString() }) : null;
    const dup = o.externalId ? await this.repo.touchByExternalId(draft.channel, o.externalId) : undefined;
    const touch =
      dup ??
      (await this.recordTouch(draft.contactId, { channel: draft.channel, direction: "outbound", status: "sent", body: draft.text, external_id: o.externalId, external_url: o.externalUrl, thread_id: draft.threadId ?? undefined, sentAt: o.sentAt, sequenceId: contact.sequenceId }));
    await this.bumpChannel(draft.contactId, draft.channel, { stage: "contacted", lastTouchAt: o.sentAt, ...(o.followup && { nextFollowupAt: o.followup }) }, o.reason);
    await this.repo.updateContact(draft.contactId, { lastTouchAt: o.sentAt });
    await this.repo.appendActivity({ action: "touch.logged", entityType: "contact", entityId: draft.contactId, reason: o.reason, payload: { touch_id: touch.id, channel: draft.channel, draft_id: draft.id, external_id: o.externalId } });
    return { touch, pacing };
  }

  private async findDraftForSent(i: z.output<typeof markSent>) {
    if (i.draft_id) {
      const d = await this.repo.draftById(i.draft_id);
      if (!d) throw new CrmError("not_found", `draft ${i.draft_id} not found`);
      return { draft: d, matched_by: "draft_id" };
    }
    if (i.intent_url) {
      // Match stored drafts written before normalization and those written after it.
      for (const url of new Set([i.intent_url, externalUrl(i.intent_url) ?? i.intent_url])) {
        const r = pickDraft(await this.repo.draftsByIntentUrl(url), "intent_url");
        if (r) return r;
      }
    }
    // Already-sent check first so retries are idempotent.
    for (const ref of [postId(i.external_id), postId(i.external_url)].filter((x): x is string => !!x)) {
      const sent = (await this.repo.draftsByExternalRef(ref)).find((d) => d.state === "sent" && d.externalId === ref);
      if (sent) return { draft: sent, matched_by: "external_id" };
    }
    for (const [ref, by] of [[postId(i.post_id), "post_id"], [postId(i.external_id), "external_id"], [postId(i.external_url), "external_url"]] as const) {
      if (!ref) continue;
      const r = pickDraft(await this.repo.draftsByExternalRef(ref), by);
      if (r) return r;
    }
    throw new CrmError("not_found", "no draft matches draft_id/intent_url/post_id/external_id");
  }

  private async markOne(i: z.output<typeof markSent>) {
    const { draft, matched_by } = await this.findDraftForSent(i);
    if (draft.state === "sent") return { status: "already_sent" as const, matched_by, draft, touch: null, x_pacing_before_send: null };
    if (draft.state === "discarded") throw new CrmError("conflict", `draft ${draft.id} was discarded`);
    const now = new Date();
    const sentAt = toDate(i.sent_at) ?? now;
    const externalId = postId(i.external_id) ?? (i.external_url ? postId(i.external_url) : undefined);
    const threadId = i.thread_id ?? draft.threadId ?? postId(i.post_id) ?? undefined;
    const updated = await this.repo.updateDraft(draft.id, { state: "sent", stateChangedAt: now, sentAt, externalId, externalUrl: i.external_url ?? (i.external_id?.startsWith("http") ? i.external_id : undefined), threadId });
    await this.repo.appendActivity({ action: "draft.state_changed", entityType: "draft", entityId: draft.id, reason: i.reason, payload: { from: draft.state, to: "sent", contact_id: draft.contactId, channel: draft.channel, matched_by, external_id: externalId } });
    const { touch, pacing } = await this.afterSent(updated, { sentAt, externalId, externalUrl: updated.externalUrl ?? undefined, followup: toDate(i.next_followup_at), reason: i.reason });
    const state = await this.repo.channelState(draft.contactId, draft.channel);
    return { status: "sent" as const, matched_by, draft: updated, touch, channel_state: state, x_pacing_before_send: pacing };
  }

  async mark_draft_sent(raw: Input<"mark_draft_sent">) {
    const i = await this.parse("mark_draft_sent", raw);
    return this.idempotent("mark_draft_sent", i, () => this.markOne(i));
  }

  async sync_sent(raw: Input<"sync_sent">) {
    const i = await this.parse("sync_sent", raw);
    return this.idempotent("sync_sent", i, async () => {
      const results = [];
      for (const [index, item] of i.items.entries()) {
        try {
          const one = { ...item, reason: item.reason ?? i.reason };
          const r = await this.idempotent("mark_draft_sent", one, () => this.markOne(one));
          results.push({ index, ok: true, status: r.status, draft_id: r.draft.id, contact_id: r.draft.contactId, matched_by: r.matched_by });
        } catch (e) {
          results.push({ index, ok: false, error: e instanceof CrmError ? e.code : "error", message: (e as Error).message });
        }
      }
      return { results, sent: results.filter((r) => r.status === "sent").length, already_sent: results.filter((r) => r.status === "already_sent").length, failed: results.filter((r) => !r.ok).length };
    });
  }

  private async resolveContact(i: { contact_id?: string; x_handle?: string; linkedin_url?: string; email?: string; reddit_user?: string; github?: string; threads_handle?: string; identities?: { kind: string; value: string; scope?: string }[]; channel: OutreachChannel; thread_id?: string }) {
    if (i.contact_id) {
      const c = await this.repo.contactById(i.contact_id);
      if (!c) throw new CrmError("not_found", `contact ${i.contact_id} not found`);
      return { contact: c, resolved_by: "contact_id" };
    }
    const ids = {
      xHandle: i.x_handle ? normalizeXHandle(i.x_handle) : undefined,
      linkedin: i.linkedin_url ? normalizeLinkedin(i.linkedin_url) : undefined,
      email: i.email ? normalizeEmail(i.email) : undefined,
      redditUser: i.reddit_user ? normalizeRedditUser(i.reddit_user) : undefined,
      github: i.github ? normalizeGithub(i.github) : undefined,
      threadsHandle: i.threads_handle ? normalizeThreadsHandle(i.threads_handle) : undefined,
    };
    const extra = await this.splitIdentities(i.identities, ids as Record<string, string | null>);
    if (Object.values(ids).some(Boolean) || extra.length) {
      const found = await this.repo.contactsByIdentity(ids, extra);
      if (found.length > 1) throw new CrmError("conflict", `identities match ${found.length} contacts; pass contact_id`);
      if (found[0]) return { contact: found[0], resolved_by: "identity" };
    }
    if (i.thread_id) {
      const hit = (await this.repo.contactIdsByThread(i.channel, i.thread_id))[0];
      if (hit) return { contact: (await this.repo.contactById(hit.id))!, resolved_by: `thread:${hit.src}` };
    }
    throw new CrmError("not_found", "no contact matches contact_id, identities or thread_id");
  }

  async record_event(raw: Input<"record_event">) {
    const i = await this.parse("record_event", raw);
    return this.idempotent("record_event", i, async () => {
      const dup = await this.repo.eventByKey(i.channel, i.type, i.external_id);
      if (dup) return { event: dup, deduped: true, contact_id: dup.contactId, stage_changed: false, resolved_by: "dedupe" as string, channel_state: undefined, overall_stage: undefined as string | undefined, skipped: undefined as string | undefined };
      const { contact, resolved_by } = await this.resolveContact(i);
      const at = toDate(i.occurred_at) ?? new Date();
      const event = await this.repo.insertEvent({ contactId: contact.id, channel: i.channel, type: i.type, externalId: i.external_id, threadId: i.thread_id, summary: i.summary, occurredAt: at });
      const before = await this.repo.channelState(contact.id, i.channel);
      const from = before?.stage ?? "new";
      const rule = EVENT_STAGE[i.type];
      const terminal = TERMINAL.includes(contact.stage) || TERMINAL.includes(from);
      let state = before ?? null;
      if (terminal) {
        state = await this.repo.upsertChannelState(contact.id, i.channel, { stage: from, lastTouchAt: at });
      } else {
        const moves = rank(rule.stage) > rank(from);
        state = await this.bumpChannel(
          contact.id,
          i.channel,
          {
            stage: rule.stage,
            lastTouchAt: at,
            ...(moves && rule.nextStep !== undefined && { nextStep: rule.nextStep }),
            ...(moves && rule.followup === "clear" && { nextFollowupAt: null }),
            ...(moves && rule.followup === "today" && { nextFollowupAt: at }),
          },
          i.reason,
        );
      }
      await this.repo.updateContact(contact.id, { lastTouchAt: at });
      const after = (await this.repo.contactById(contact.id))!;
      await this.repo.appendActivity({ action: "event.recorded", entityType: "contact", entityId: contact.id, reason: i.reason, payload: { event_id: event.id, type: i.type, channel: i.channel, external_id: i.external_id, thread_id: i.thread_id, stage_from: from, stage_to: state.stage, terminal_guard: terminal } });
      return { event, deduped: false, contact_id: contact.id, resolved_by, stage_changed: state.stage !== from, channel_state: state, overall_stage: after.stage, ...(terminal && { skipped: `contact is ${TERMINAL.includes(contact.stage) ? contact.stage : from}; stage not changed` }) };
    });
  }

  async find_by_thread(raw: Input<"find_by_thread">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("find_by_thread", raw);
    const hits = await this.repo.contactIdsByThread(i.channel, i.thread_id);
    if (!hits[0]) return { contact: null, matched_by: null, contact_ids: [] };
    const ids = [...new Set(hits.map((h) => h.id))];
    const contact = await this.repo.contactById(hits[0].id);
    const state = await this.repo.channelState(hits[0].id, i.channel);
    return { contact, channel_state: state ?? null, matched_by: hits[0].src, contact_ids: ids };
  }

  private async followupRules() {
    const r = (await this.repo.getSettings())?.followupRules ?? {};
    const reg = await this.registry();
    const followup_days: Record<string, number> = { ...Object.fromEntries(reg.channels.map((c) => [c.id, c.followupDays])), ...(r.followup_days as Record<string, number>) };
    const stale_days: Record<string, number> = { ...Object.fromEntries(reg.channels.map((c) => [c.id, c.staleDays])), ...(r.stale_days as Record<string, number>) };
    return { followup_days, stale_days };
  }

  async get_followup_rules(_raw: Input<"get_followup_rules"> = {}) {
    requireScope(this.ctx, "crm:read");
    return { ...(await this.followupRules()), tz: TZ, defaults: { followup_days: DEFAULT_FOLLOWUP_DAYS, stale_days: DEFAULT_STALE_DAYS } };
  }

  async set_followup_rules(raw: Input<"set_followup_rules">) {
    const i = await this.parse("set_followup_rules", raw);
    requireRole(this.ctx, "admin");
    requireScope(this.ctx, "crm:write");
    const reg = await this.registry();
    for (const c of [...Object.keys(i.followup_days ?? {}), ...Object.keys(i.stale_days ?? {})]) if (!reg.isChannel(c)) throw new CrmError("invalid", `unknown channel ${c}`);
    const cur = (await this.repo.getSettings())?.followupRules ?? {};
    const next = { followup_days: { ...cur.followup_days, ...i.followup_days }, stale_days: { ...cur.stale_days, ...i.stale_days } };
    await this.repo.setFollowupRules(next);
    await this.repo.appendActivity({ action: "settings.followup_rules", entityType: "org", entityId: this.ctx.orgId, reason: i.reason, payload: next });
    return this.get_followup_rules();
  }

  async bulk_update_stage(raw: Input<"bulk_update_stage">) {
    const i = await this.parse("bulk_update_stage", raw);
    return this.idempotent("bulk_update_stage", i, async () => {
      const results = [];
      for (const [index, it] of i.items.entries()) {
        try {
          if (it.channel) {
            const before = await this.repo.channelState(it.contact_id, it.channel);
            const r = await this.set_channel_state({ contact_id: it.contact_id, channel: it.channel, stage: it.stage, idempotency_key: it.idempotency_key, reason: i.reason });
            results.push({ index, ok: true, contact_id: it.contact_id, channel: it.channel, from: before?.stage ?? "new", stage: r.state.stage, overall_stage: r.overall_stage, changed: (before?.stage ?? "new") !== r.state.stage });
          } else {
            const before = await this.repo.contactById(it.contact_id);
            const r = await this.update_stage({ contact_id: it.contact_id, stage: it.stage, idempotency_key: it.idempotency_key, reason: i.reason });
            results.push({ index, ok: true, contact_id: it.contact_id, channel: null, from: before?.stage ?? null, stage: r.stage, overall_stage: r.stage, changed: before?.stage !== r.stage });
          }
        } catch (e) {
          results.push({ index, ok: false, contact_id: it.contact_id, error: e instanceof CrmError ? e.code : "error", message: (e as Error).message });
        }
      }
      return { results, updated: results.filter((r) => r.ok && r.changed).length, unchanged: results.filter((r) => r.ok && !r.changed).length, failed: results.filter((r) => !r.ok).length };
    });
  }

  async daily_overview(raw: Input<"daily_overview"> = {}) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("daily_overview", raw);
    const now = new Date();
    const [followups, linkedin, events, drafted, approved, pacing, stale, report, stageCounts] = await Promise.all([
      this.due_followups({ tz: i.tz, limit: i.limit }),
      this.linkedin_needs_first_message({ limit: i.limit }),
      this.repo.eventsSince(new Date(now.getTime() - DAY)),
      this.repo.listDrafts({ state: "drafted", limit: i.limit }),
      this.repo.listDrafts({ state: "approved", limit: i.limit }),
      this.x_pacing_today({ tz: i.tz }),
      this.stale_no_response({ limit: i.limit }),
      this.outreach_report({ tz: i.tz }),
      // Same population as pipeline_summary/list_contacts_view (all contacts, competitors included).
      this.repo.stageCounts(),
    ]);
    const stages = Object.fromEntries(STAGES.map((st) => [st, 0])) as Record<(typeof STAGES)[number], number>;
    for (const c of stageCounts) stages[c.stage] = Number(c.count);
    const contacts = await this.repo.allContacts();
    const names = new Map(contacts.map((c) => [c.id, c.name]));
    const contactById = new Map(contacts.map((c) => [c.id, c]));
    const contactLifecycle = (id: string) => {
      const c = contactById.get(id);
      return c ? lifecycleOf(c.stage) : null;
    };
    const replies = events.filter((e) => e.type === "reply_received" || e.type === "email_reply");
    return {
      date: localDateString(now, i.tz),
      tz: i.tz,
      followups_due: followups.channel_followups,
      tasks_due: followups.tasks,
      linkedin_awaiting_first_message: linkedin,
      new_replies: replies.map((e) => ({ ...e, name: names.get(e.contactId) ?? null, lifecycle: contactLifecycle(e.contactId) })),
      events_last_24h: events.map((e) => ({ ...e, name: names.get(e.contactId) ?? null, lifecycle: contactLifecycle(e.contactId) })),
      drafts_pending: [...approved, ...drafted].map((d) => ({ id: d.id, contact_id: d.contactId, name: names.get(d.contactId) ?? null, lifecycle: contactLifecycle(d.contactId), channel: d.channel, state: d.state, text: d.text, intent_url: d.intentUrl, created_at: d.createdAt })),
      x_pacing: pacing,
      stale,
      goal: report.goal,
      totals: report.totals,
      stages,
    };
  }

  async list_drafts(raw: Input<"list_drafts">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("list_drafts", raw);
    return this.repo.listDrafts({ state: i.state, channel: i.channel, contactId: i.contact_id, campaignId: i.campaign_id, limit: i.limit });
  }

  async upsert_campaign(raw: Input<"upsert_campaign">) {
    const i = await this.parse("upsert_campaign", raw);
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
    const i = await this.parse("list_contacts", raw);
    return this.repo.listContacts({ stage: i.stage, lifecycle: i.lifecycle, source: i.source, campaignId: i.campaign_id, contactType: i.contact_type, channel: i.channel, channelStage: i.channel_stage, query: i.query, limit: i.limit });
  }

  /** List rows plus company and linked identities (the dashboard list views). */
  async list_contacts_view(raw: Input<"list_contacts_view">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("list_contacts_view", raw);
    const filters = { stage: i.stage, lifecycle: i.lifecycle, source: i.source, campaignId: i.campaign_id, contactType: i.contact_type, channel: i.channel, channelStage: i.channel_stage, query: i.query };
    const [rows, total, stages, reg] = await Promise.all([
      this.repo.listContactsView({ ...filters, limit: i.limit, offset: i.offset }),
      this.repo.countContacts(filters),
      // Tabs show every lifecycle and every stage, so counts honour the other filters only.
      this.repo.stageCounts({ ...filters, lifecycle: undefined, stage: undefined, channelStage: undefined }),
      this.registry(),
    ]);
    const by = Object.fromEntries(STAGES.map((st) => [st, 0])) as Record<(typeof STAGES)[number], number>;
    for (const c of stages) by[c.stage] = Number(c.count);
    return {
      contacts: rows.map((c) => ({
        ...c,
        lifecycle: lifecycleOf(c.stage),
        company: c.company ? { ...c.company, website_url: websiteUrl(c.company.website ?? c.company.domain) } : null,
        identities: c.identities.map((r) => this.identityRow(reg, r, false)),
      })),
      total,
      counts: { ...lifecycleCounts(by), stages: by },
    };
  }

  async list_companies(raw: Input<"list_companies">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("list_companies", raw);
    const [companies, total] = await Promise.all([
      this.repo.listCompanies({ query: i.query, limit: i.limit, offset: i.offset }),
      this.repo.countCompanies({ query: i.query }),
    ]);
    const stats = await this.repo.contactStageCountsByCompany(companies.map((c) => c.id));
    const byCompany = new Map<string, { contacts: number; leads: number; relationships: number }>();
    for (const row of stats) {
      if (!row.companyId) continue;
      const counts = byCompany.get(row.companyId) ?? { contacts: 0, leads: 0, relationships: 0 };
      const n = Number(row.count);
      counts.contacts += n;
      const lifecycle = lifecycleOf(row.stage);
      if (lifecycle === "lead") counts.leads += n;
      else if (lifecycle === "contact") counts.relationships += n;
      byCompany.set(row.companyId, counts);
    }
    return {
      companies: companies.map((c) => {
        const counts = byCompany.get(c.id) ?? { contacts: 0, leads: 0, relationships: 0 };
        return {
          ...c,
          website_url: websiteUrl(c.website ?? c.domain),
          ...counts,
        };
      }),
      total,
    };
  }

  async due_followups(raw: Input<"due_followups">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("due_followups", raw);
    const ref = i.today ? (/^\d{4}-\d{2}-\d{2}$/.test(i.today) ? localNoon(i.today, i.tz) : new Date(i.today)) : new Date();
    if (Number.isNaN(ref.getTime())) throw new CrmError("invalid", `bad today ${i.today}`);
    const end = endOfLocalDay(ref, i.tz);
    const channel = (await this.repo.followupsDueBefore(end, i.limit)).map((r) => ({
      contact_id: r.contact.id,
      name: r.contact.name,
      lifecycle: lifecycleOf(r.contact.stage),
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
    const i = await this.parse("stale_no_response", raw);
    const rules = (await this.followupRules()).stale_days;
    const days = (ch: OutreachChannel) => i.days ?? rules[ch] ?? 7;
    const minDays = Math.min(...Object.keys(rules).map(days));
    const now = Date.now();
    const rows = await this.repo.staleStates(new Date(now - minDays * DAY), ["contacted", "connection_pending", "connected"], 2000);
    return rows
      .filter((r) => (!i.channel || r.state.channel === i.channel) && r.contact.stage !== "do_not_contact" && r.state.lastTouchAt!.getTime() < now - days(r.state.channel) * DAY)
      .slice(0, i.limit)
      .map((r) => ({ contact_id: r.contact.id, name: r.contact.name, lifecycle: lifecycleOf(r.contact.stage), channel: r.state.channel, stage: r.state.stage, last_touch_at: r.state.lastTouchAt, days_since: Math.floor((now - r.state.lastTouchAt!.getTime()) / DAY), threshold_days: days(r.state.channel) }));
  }

  async linkedin_needs_first_message(raw: Input<"linkedin_needs_first_message">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("linkedin_needs_first_message", raw);
    const [rows, touched, sentDrafts] = await Promise.all([
      this.repo.statesByChannelStage("linkedin", ["connection_pending", "connected"]),
      this.repo.outboundTouchContactIds("linkedin"),
      this.repo.sentDraftContactIds("linkedin"),
    ]);
    return rows
      .filter((r) => !touched.has(r.contact.id) && !sentDrafts.has(r.contact.id) && r.contact.stage !== "do_not_contact")
      .slice(0, i.limit)
      .map((r) => ({ contact_id: r.contact.id, name: r.contact.name, lifecycle: lifecycleOf(r.contact.stage), linkedin: r.contact.linkedin, stage: r.state.stage, next_step: r.state.nextStep }));
  }

  async linkedin_connected_no_first_message(raw: Input<"linkedin_connected_no_first_message">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("linkedin_connected_no_first_message", raw);
    const [rows, accepted, sends] = await Promise.all([this.repo.statesByChannelStage("linkedin", ["connected"]), this.repo.eventTimes("linkedin", "connection_accepted"), this.repo.outboundSends("linkedin")]);
    const now = Date.now();
    return rows
      .filter((r) => r.contact.stage !== "do_not_contact" && r.contact.contactType !== "competitor")
      .map((r) => {
        const at = accepted.get(r.contact.id) ?? r.state.lastTouchAt ?? r.state.updatedAt;
        return { r, at };
      })
      .filter(({ r, at }) => now - at.getTime() >= i.days * DAY && !(sends.get(r.contact.id) ?? []).some((t) => t >= at))
      .toSorted((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, i.limit)
      .map(({ r, at }) => ({ contact_id: r.contact.id, name: r.contact.name, linkedin: r.contact.linkedin, connected_at: at, days_connected: Math.floor((now - at.getTime()) / DAY), next_step: r.state.nextStep, next_followup_at: r.state.nextFollowupAt }));
  }

  async x_pacing_today(raw: Input<"x_pacing_today">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("x_pacing_today", raw);
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
    const i = await this.parse("outreach_report", raw);
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
    const i = await this.parse("import_leads_csv", raw);
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
    const [contacts, companies, blocks, states, allIds, reg] = await Promise.all([this.repo.allContacts(), this.repo.allCompanies(), this.repo.blocklistAll(), this.repo.allChannelStates(), this.repo.allIdentities(), this.registry()]);
    type C = (typeof contacts)[number];
    const idx = new Map<string, C>();
    const index = (c: C, extra: Identity[] = []) => {
      for (const [k, v] of [["email", c.email], ["li", c.linkedin], ["x", c.xHandle], ["rd", c.redditUser], ["gh", c.github], ["th", c.threadsHandle]] as const) if (v) idx.set(`${k}:${v}`, c);
      for (const x of extra) idx.set(extraKey(x), c);
    };
    contacts.forEach((c) => index(c));
    const byId = new Map(contacts.map((c) => [c.id, c]));
    for (const r of allIds) if (!KIND_INDEX.get(r.kind)?.legacyColumn && byId.has(r.contactId)) idx.set(extraKey({ kind: r.kind, scope: r.scope, value: r.valueNormalized }), byId.get(r.contactId)!);
    const companyById = new Map(companies.map((c) => [c.id, c]));
    const companyByName = new Map(companies.map((c) => [normalizeName(c.name), c]));
    const stateMap = new Map(states.map((s) => [stateKey(s.contactId, s.channel), s]));

    const seenThisRun = new Set<string>();
    let scoresRescaled = 0;
    const report = { dry_run: !write, total_rows: records.length, created: 0, updated: 0, unchanged: 0, skipped: 0, missing_columns: missing, unknown_statuses: {} as Record<string, number>, notices: [] as string[], rows: [] as ImportRowReport[] };

    for (const [n, r] of records.entries()) {
      const rowNo = i.row_offset + n + 2; // 1-based, header is row 1
      const warnings: string[] = [];
      const p = parseImportRow(r, warnings, reg);
      if (p.scoreOriginal !== null) scoresRescaled++;
      if (!p.mapped.known) report.unknown_statuses[r.status ?? ""] = (report.unknown_statuses[r.status ?? ""] ?? 0) + 1;
      const label = p.name ?? p.ids.xHandle ?? p.ids.linkedin ?? p.ids.email ?? `row ${rowNo}`;
      const skip = (why: string) => (report.skipped++, report.rows.push({ row: rowNo, action: "skipped", label, reason: why, warnings }));
      if (!Object.values(p.ids).some(Boolean) && !p.extra.length && !p.name) {
        skip("no identity or name");
        continue;
      }

      // Dedupe: any identity, then exact normalized name + company.
      const keys = [["email", p.ids.email], ["li", p.ids.linkedin], ["x", p.ids.xHandle], ["rd", p.ids.redditUser], ["gh", p.ids.github], ["th", p.ids.threadsHandle]].filter(([, v]) => v).map(([k, v]) => `${k}:${v}`);
      keys.push(...p.extra.map(extraKey));
      const hits = [...new Set(keys.map((k) => idx.get(k)).filter((c): c is C => !!c))];
      if (hits.length > 1) {
        skip(`identities match ${hits.length} different contacts (${hits.map((h) => h.id).join(", ")})`);
        continue;
      }
      let existing = hits[0];
      if (!existing && p.name) {
        const coName = normalizeName(p.company);
        const conflicts = (c: C) => (["email", "linkedin", "xHandle", "redditUser", "github", "threadsHandle"] as const).some((k) => !!p.ids[k] && !!c[k] && c[k] !== p.ids[k]) || (!!p.ids.redditUser && !c.redditUser && !!c.xHandle && !p.ids.xHandle);
        existing = contacts.find((c) => normalizeName(c.name) === normalizeName(p.name) && normalizeName(c.companyId ? companyById.get(c.companyId)?.name : "") === coName && !conflicts(c));
        if (existing) warnings.push("matched existing contact by name+company");
      }

      const contactType = p.mapped.competitor ? "competitor" : (existing?.contactType ?? "lead");
      if (contactType === "lead") {
        const hitsB = matchBlocklist(blocks, {
          personNames: [p.name].filter((x): x is string => !!x),
          companyNames: [p.company].filter((x): x is string => !!x),
          handles: [p.ids.xHandle, p.ids.github, p.ids.redditUser, p.ids.threadsHandle, p.ids.linkedin?.split("/").pop(), ...p.extra.filter((x) => !KIND_INDEX.get(x.kind)?.private).map((x) => x.value.replace(/^@/, ""))].filter((x): x is string => !!x),
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
        profileUrl: p.profileUrl,
        website: p.website,
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
      for (const [k, v] of [["email", p.ids.email], ["linkedin", p.ids.linkedin], ["xHandle", p.ids.xHandle], ["redditUser", p.ids.redditUser], ["github", p.ids.github], ["threadsHandle", p.ids.threadsHandle]] as const) {
        if (!v) continue;
        if (!existing?.[k]) {
          if (idx.get(`${({ email: "email", linkedin: "li", xHandle: "x", redditUser: "rd", github: "gh", threadsHandle: "th" } as const)[k]}:${v}`)) warnings.push(`${k} ${v} already belongs to another contact; not set`);
          else changes[k] = v;
        } else if (existing[k] !== v) warnings.push(`${k} differs (crm=${existing[k]}, csv=${v}); kept crm value`);
      }
      const newExtra = p.extra.filter((x) => idx.get(extraKey(x))?.id !== existing?.id || !existing);
      for (const x of newExtra) {
        const owner = idx.get(extraKey(x));
        if (owner && owner.id !== existing?.id) warnings.push(`${x.kind} ${reg.display(x, false)} already belongs to another contact; not set`);
        else changes[`identity.${x.kind}`] = reg.display(x, false);
      }
      const addExtras = newExtra.filter((x) => !idx.get(extraKey(x)));
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
        const fields = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith("channel.") && !k.startsWith("identity."))) as Partial<C>;
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
        if (addExtras.length) await this.repo.addIdentities(saved.id, addExtras);
        if (existing) contacts.splice(contacts.indexOf(existing), 1, saved);
        else contacts.push(saved);
        index(saved, p.extra);
      } else if (!write && !existing) {
        // Simulate so later rows in the same file dedupe against this one.
        const ghost = { ...changes, id: `(row ${rowNo})`, name: p.name, companyId, contactType, stage: overall, email: changes.email ?? null, linkedin: changes.linkedin ?? null, xHandle: changes.xHandle ?? null, redditUser: changes.redditUser ?? null, github: changes.github ?? null, threadsHandle: changes.threadsHandle ?? null } as unknown as C;
        contacts.push(ghost);
        index(ghost, p.extra);
      }
      if (contactId) seenThisRun.add(contactId);
      else if (!write && !existing) seenThisRun.add(`(row ${rowNo})`);
      report.rows.push({ row: rowNo, action, label, contact_id: contactId, changes: action === "unchanged" ? undefined : changes, company: companyAction, warnings });
    }
    if (scoresRescaled) report.notices.push(`${scoresRescaled} score(s) above 5 treated as a 1-10 scale and rescaled to 1-5 (round(score/2)); originals kept in score_original`);
    return report;
  }

  async list_channels(_raw: Input<"list_channels"> = {}) {
    requireScope(this.ctx, "crm:read");
    const reg = await this.registry();
    const rules = await this.followupRules();
    return {
      channels: reg.channels.map((c) => ({
        id: c.id, label: c.label, kinds: c.kinds, prefixes: c.prefixes, followup_days: rules.followup_days[c.id], stale_days: rules.stale_days[c.id], private: c.private, custom: !!c.custom, url_pattern: c.urlPattern,
        scoped: c.kinds.some((k) => reg.kind(k)?.scoped),
      })),
      extra_sources: ["web", "prowlo", "other"],
    };
  }

  async add_custom_channel(raw: Input<"add_custom_channel">) {
    const i = await this.parse("add_custom_channel", raw);
    requireRole(this.ctx, "admin");
    requireScope(this.ctx, "crm:write");
    return this.idempotent("add_custom_channel", i, async () => {
      const builtin = BUILTIN_CHANNELS.find((c) => c.id === i.id || (i.prefix && c.prefixes.includes(i.prefix)));
      if (builtin || KIND_INDEX.has(i.id) || ["web", "prowlo", "other"].includes(i.id)) throw new CrmError("conflict", `${i.id}${i.prefix ? `/${i.prefix}` : ""} collides with built-in channel ${builtin?.id ?? i.id}`);
      if (i.url_pattern && !i.url_pattern.includes("{handle}")) throw new CrmError("invalid", "url_pattern must contain {handle}");
      const others = (await this.repo.customChannels()).filter((c) => c.id !== i.id);
      if (i.prefix && others.some((c) => (c.prefix ?? c.id) === i.prefix)) throw new CrmError("conflict", `prefix ${i.prefix} already used by another custom channel`);
      const row = await this.repo.upsertCustomChannel({ id: i.id, label: i.label, urlPattern: i.url_pattern ?? null, prefix: i.prefix ?? null, followupDays: i.followup_days ?? null, staleDays: i.stale_days ?? null });
      this.regP = undefined;
      await this.repo.appendActivity({ action: "channel.custom_upserted", entityType: "org", entityId: this.ctx.orgId, reason: i.reason, payload: row });
      return { channel: (await this.list_channels()).channels.find((c) => c.id === i.id) };
    });
  }

  async find_by_identity(raw: Input<"find_by_identity">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("find_by_identity", raw);
    const reg = await this.registry();
    const n = i.kind ? reg.normalize(i.kind, i.value, i.scope) : reg.parse(i.value);
    if (!n) throw new CrmError("invalid", `could not parse identity from ${JSON.stringify(i.value)}${i.kind ? ` as ${i.kind}` : ""}`);
    const found = await this.repo.contactsByIdentity({}, [n]);
    return { identity: { kind: n.kind, scope: n.scope || undefined, value: reg.display(n, false) }, found: found.length > 0, contacts: found };
  }

  async export_csv(raw: Input<"export_csv">) {
    requireScope(this.ctx, "crm:read");
    const i = await this.parse("export_csv", raw);
    if (i.include_private) requireRole(this.ctx, "admin");
    const [contacts, companies, states, allIds, reg] = await Promise.all([this.repo.allContacts(), this.repo.allCompanies(), this.repo.allChannelStates(), this.repo.allIdentities(), this.registry()]);
    const idsBy = new Map<string, typeof allIds>();
    for (const r of allIds) idsBy.set(r.contactId, [...(idsBy.get(r.contactId) ?? []), r]);
    const idCell = (cid: string) =>
      (idsBy.get(cid) ?? []).map((r) => `${r.kind}${r.scope ? `@${r.scope}` : ""}:${reg.display({ kind: r.kind, value: r.valueNormalized }, i.include_private)}`).join("; ");
    const extraHandle = (cid: string) => {
      const r = (idsBy.get(cid) ?? []).find((x) => !KIND_INDEX.get(x.kind)?.legacyColumn);
      const ch = r && reg.channel(reg.kind(r.kind)?.channel ?? "");
      return r && ch ? `${ch.prefixes[0] ?? ch.id}:${r.scope ? `${r.scope}/` : ""}${reg.display({ kind: r.kind, value: r.valueNormalized }, i.include_private)}` : "";
    };
    const cos = new Map(companies.map((c) => [c.id, c]));
    const rows = contacts
      .filter((c) => (!i.contact_type || c.contactType === i.contact_type) && (!i.stage || c.stage === i.stage) && (!i.campaign_id || c.campaignId === i.campaign_id))
      .map((c) => {
        const co = c.companyId ? cos.get(c.companyId) : undefined;
        const st = (ch: string) => states.find((s) => s.contactId === c.id && s.channel === ch);
        const handle = c.source === "reddit" ? c.redditUser : c.source === "linkedin" ? c.linkedin : c.source === "threads" && c.threadsHandle ? `threads:@${c.threadsHandle}` : c.xHandle ? `@${c.xHandle}` : (c.redditUser ?? c.github ?? extraHandle(c.id));
        const derived =
          (c.source === "linkedin" || !c.xHandle) && c.linkedin
            ? (reg.profileUrl("linkedin_url", c.linkedin) ?? "")
            : (c.source === "threads" && c.threadsHandle && reg.profileUrl("threads_handle", c.threadsHandle)) ||
              (c.xHandle && reg.profileUrl("x_handle", c.xHandle)) ||
              (c.threadsHandle && reg.profileUrl("threads_handle", c.threadsHandle)) ||
              (c.redditUser && reg.profileUrl("reddit_user", c.redditUser)) ||
              "";
        const profile = i.derived_profile_url ? derived || c.profileUrl : (c.profileUrl ?? derived);
        return [
          handle, c.name, profile, c.bioSummary, c.followers, co?.name, c.role, c.estTeamSize, c.signalPostUrl, c.signalDate, c.signalSummary, c.score, c.source,
          c.contactType === "competitor" ? "competitor" : c.stage, c.firstSeenAt?.toISOString().slice(0, 10), c.notesText,
          c.id, c.email, c.xHandle, c.linkedin, c.redditUser, c.github, co?.domain, c.contactType, c.campaignId,
          ...LEGACY_EXPORT_CHANNELS.flatMap((ch) => [st(ch)?.stage, st(ch)?.nextFollowupAt?.toISOString()]),
          c.website, c.sourceDetail, c.contactType === "competitor" ? "competitor" : c.stage, c.threadsHandle, idCell(c.id),
        ];
      });
    const header = [...IMPORT_COLUMNS.map((h) => (h === "status" ? "stage" : h)), "id", "email", "x_handle", "linkedin_url", "reddit_user", "github", "company_domain", "contact_type", "campaign_id", ...LEGACY_EXPORT_CHANNELS.flatMap((ch) => [`${ch}_stage`, `${ch}_next_followup_at`]), "website", "source_detail", "status", "threads_handle", "identities"];
    return { rows: rows.length, csv: toCsv(header, rows) };
  }
}

const extraKey = (x: Identity) => `${x.kind}|${x.scope ?? ""}|${x.value}`;

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


/** Which identity a profile URL carries; "site" = any other website. */
export function profileKind(url?: string): "x" | "linkedin" | "reddit" | "github" | "threads" | "site" | null {
  if (!url?.trim()) return null;
  const host = url.trim().replace(/^https?:\/\//i, "").replace(/^(www|m|mobile|old|new)\./i, "").toLowerCase();
  if (/^(x|twitter)\.com(\/|$)/.test(host)) return "x";
  if (/^([a-z]{2}\.)?linkedin\.com(\/|$)/.test(host)) return "linkedin";
  if (/^reddit\.com(\/|$)/.test(host)) return "reddit";
  if (/^github\.com(\/|$)/.test(host)) return "github";
  if (/^threads\.(net|com)(\/|$)/.test(host)) return "threads";
  return /^[^\s/]+\.[a-z]{2,}/.test(host) ? "site" : null;
}

/** Free-form source -> canonical source. Unknown values are returned lowercased (caller infers). */
export function mapSource(raw?: string): string | undefined {
  const k = raw?.trim().toLowerCase();
  if (!k) return undefined;
  if (k.startsWith("reddit") || k.startsWith("prowlo") || k.includes("reddit")) return "reddit";
  if (k.startsWith("email") || k.startsWith("e-mail") || k === "mail") return "email";
  if (k.startsWith("linkedin")) return "linkedin";
  if (k.startsWith("threads")) return "threads";
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
export function parseImportRow(r: Record<string, string>, warnings: string[] = [], reg: ChannelRegistry = BUILTIN_REGISTRY) {
  const found: Identity[] = [];
  const addExtra = (x: Identity | null) => {
    if (x && !KIND_INDEX.get(x.kind)?.legacyColumn && !found.some((e) => e.kind === x.kind && e.scope === x.scope && e.value === x.value)) found.push(x);
    return !!x && !KIND_INDEX.get(x.kind)?.legacyColumn;
  };
  const v = (k: string) => (r[k] ?? "").trim() || undefined;
  const ids = { email: null as string | null, linkedin: null as string | null, xHandle: null as string | null, redditUser: null as string | null, github: null as string | null, threadsHandle: null as string | null };
  const srcRaw = v("source");
  let src = mapSource(srcRaw);
  const profile = v("profile_url");
  const kind = profileKind(profile);
  if (kind === "x") ids.xHandle = normalizeXHandle(profile);
  else if (kind === "linkedin") ids.linkedin = normalizeLinkedin(profile);
  else if (kind === "reddit") ids.redditUser = normalizeRedditUser(profile);
  else if (kind === "github") ids.github = normalizeGithub(profile);
  else if (kind === "threads") ids.threadsHandle = normalizeThreadsHandle(profile);
  const profileExtra = kind === "site" && addExtra(reg.parse(profile!));
  const website = kind === "site" && !profileExtra ? profile! : null;
  if (profileExtra && (!src || src === "web" || !reg.isSource(src))) src = reg.kind(found[0]!.kind)?.channel ?? src;
  // Ambiguous sources (web / handoff_* / missing) follow a social profile_url.
  if (kind && kind !== "site" && kind !== "github" && (!src || src === "web" || !reg.isSource(src))) src = kind;
  const handle = v("handle");
  const pre = handle?.match(/^(li|linkedin|x|twitter|gh|github|reddit|rd|threads|th)\s*:\s*(.+)$/i);
  const generic = !pre && handle && /^[a-z][a-z0-9_]*\s*:/i.test(handle) && !/^https?:/i.test(handle) ? reg.parse(handle) : null;
  if (generic && addExtra(generic)) {
    if (!src || src === "web" || !reg.isSource(src)) src = reg.kind(generic.kind)?.channel ?? src;
  } else if (pre) {
    const t = pre[1]!.toLowerCase();
    const val = pre[2]!.trim();
    if (t === "li" || t === "linkedin") ids.linkedin ??= normalizeLinkedin(val);
    else if (t === "x" || t === "twitter") ids.xHandle ??= normalizeXHandle(val);
    else if (t === "gh" || t === "github") ids.github ??= normalizeGithub(val);
    else if (t === "threads" || t === "th") ids.threadsHandle ??= normalizeThreadsHandle(val);
    else ids.redditUser ??= normalizeRedditUser(val);
    if (!Object.values(ids).some(Boolean)) warnings.push(`could not parse handle ${handle}`);
  } else if (handle && kind === "site" && !handle.startsWith("@") && !/^https?:|\.com\/|^\/?u\//i.test(handle) && !handle.includes("@")) {
    // A bare handle next to a personal/company website is a site slug, not an X handle.
  } else if (handle) {
    if (isRedditRef(handle)) ids.redditUser ??= normalizeRedditUser(handle.replace(/^@/, ""));
    else if (/^https?:|\.com\/|threads\.net\//i.test(handle) && addExtra(reg.parse(handle))) {
      if (!src || src === "web" || !reg.isSource(src)) src = reg.kind(found.at(-1)!.kind)?.channel ?? src;
    } else if (/^https?:|\.com\/|threads\.net\//i.test(handle)) {
      const e = extractIdentities(handle);
      ids.xHandle ??= e.x[0] ?? null;
      ids.linkedin ??= e.linkedin[0] ?? null;
      ids.redditUser ??= e.reddit[0] ?? null;
      ids.github ??= e.github[0] ?? null;
      ids.threadsHandle ??= e.threads[0] ?? null;
    } else if (src === "reddit" || /^\/?u\//i.test(handle)) ids.redditUser ??= normalizeRedditUser(handle);
    else if (src === "linkedin") ids.linkedin ??= normalizeLinkedin(handle);
    else if (src === "threads") ids.threadsHandle ??= normalizeThreadsHandle(handle);
    else if (handle.includes("@") && !handle.startsWith("@")) ids.email ??= normalizeEmail(handle);
    else ids.xHandle ??= normalizeXHandle(handle);
    if (!Object.values(ids).some(Boolean) && !found.length) warnings.push(`could not parse handle ${handle}`);
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
  take("threadsHandle", ex.threads, "threads");
  if (!src || !reg.isSource(src)) {
    const inferred = found[0] && !ids.xHandle && !ids.linkedin ? (reg.kind(found[0].kind)?.channel ?? "web") : ids.xHandle ? "x" : ids.linkedin ? "linkedin" : ids.redditUser ? "reddit" : ids.threadsHandle ? "threads" : ids.email ? "email" : "web";
    if (src) warnings.push(`unknown source ${src}; using ${inferred}`);
    src = inferred;
  }
  const source = src;
  const channel: OutreachChannel | undefined =
    source === "x" || source === "linkedin" || source === "reddit" || source === "threads" || (source !== "email" && found.some((x) => reg.kind(x.kind)?.channel === source)) ? source : ids.email ? "email" : undefined;
  const statusRaw = v("status") ?? v("stage");
  const mapped = mapStatus(statusRaw);
  if (!mapped.known) warnings.push(`unknown status ${statusRaw}; using new`);
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
  const signalRaw = v("signal_post_url");
  const signalUrl = externalUrl(signalRaw);
  if (signalRaw && !signalUrl) warnings.push(`signal_post_url is not an http(s) URL: ${signalRaw}`);
  const companyRaw = v("company");
  const companyDomain = companyDomainFromEmail(ids.email) ?? (companyRaw && /^[^\s]+\.[a-z]{2,}$/i.test(companyRaw) ? normalizeDomain(companyRaw) : null) ?? (website ? normalizeDomain(website) : null);
  return {
    ids,
    extra: found,
    name: v("name") ?? null,
    role: v("role") ?? null,
    bio: v("bio_summary") ?? null,
    followers: num(v("followers"), warnings, "followers"),
    ...parseTeamSize(v("est_team_size")),
    scoreOriginal,
    sourceDetail: srcRaw && srcRaw.toLowerCase() !== source ? srcRaw : null,
    profileUrl: profile ?? null,
    website,
    score,
    source,
    channel,
    firstSeen,
    company: companyRaw ?? null,
    companyDomain,
    signalUrl,
    signalDate: v("signal_post_date") ?? null,
    signalSummary: v("signal_summary") ?? null,
    notes: notes ?? null,
    mapped,
  };
}

export const TOOL_DESCRIPTIONS: Record<keyof typeof schemas, string> = {
  list_channels: "List outreach channels from the registry (built-in + org custom): id, label, identity kinds, import prefixes, follow-up/stale days, private flag.",
  add_custom_channel: "Admin: add or update an org custom channel at runtime (id, label, url_pattern with {handle}, prefix, followup_days, stale_days). Contacts get it as identities [{kind: <id>, value}] and imports accept <prefix>:handle or matching URLs; no migration needed.",
  find_by_identity: "Find contacts by any identity: value as prefix form (hn:pg, bsky:alice, discord:server/user, wa:+84...), profile URL, or kind+value(+scope). Private values are masked in the echo.",
  linkedin_connected_no_first_message: "Contacts whose LinkedIn channel is connected for >= days (since connection_accepted, else last touch) with no outbound LinkedIn message or sent draft since acceptance.",
  mark_draft_sent: "Mark a draft sent, found by draft_id, intent_url, post_id (tweet id/URL it replies to) or external_id/url of the sent message. Logs a touch, sets the channel to contacted (unless further), last_touch_at, and the per-channel default follow-up. Returns already_sent on repeats.",
  sync_sent: "Bulk mark_draft_sent: items[] of the same args; per-item results; idempotent (already_sent on repeats).",
  record_event: "Record reply_received | email_reply | connection_accepted | meeting_booked | connection_requested on a channel (external_id deduped per org+channel+type). Contact by contact_id, any identity, or thread_id. Advances the channel stage (never out of paying/lost/do_not_contact); reply->responded (clears follow-up, next_step 'reply'), accepted->connected (+'send first message', follow-up today), meeting->call_booked. identities[] accepted for contact resolution.",
  find_by_thread: "Find the contact owning a thread (tweet conversation/status id, gmail threadId, reddit post id) on a channel, via touches, drafts or events.",
  get_followup_rules: "Per-org follow-up and stale days per channel (defaults from the channel registry, e.g. x 3/6, linkedin 5/10, email 4/8, reddit 4/8; custom channels included).",
  set_followup_rules: "Admin: change per-channel followup_days and/or stale_days for the org.",
  bulk_update_stage: "Bulk stage set: items[] of {contact_id, channel?, stage}. With channel sets that channel's stage exactly; without, the overall stage. Per-item results.",
  daily_overview: "Today's (Asia/Saigon) work: follow-ups due, LinkedIn connected awaiting first message, new replies/events in 24h, pending drafts, X pacing, stale flags, goal progress, stage counts.",
  search_contacts: "Search contacts in this org by text (name, email, role, handles, company), stage, company or tag.",
  get_contact: "Get one contact with company, tags, per-channel states, drafts, recent touches, open tasks and notes. Includes identities[]; whatsapp numbers are masked unless an admin passes include_private.",
  upsert_contact:
    "Create or update a contact. Deduped across email, x_handle, linkedin_url, reddit_user and github (all normalized; conflict if they match different contacts). Leads matching the competitor blocklist are rejected (error 'blocked'). identities: [{kind, value, scope?}] adds any registry identity (hn_user, discord_user+server, slack_user+workspace, bsky_handle, tiktok, instagram, youtube, facebook, telegram, whatsapp, custom channel ids); legacy fields still work. Dedupe spans all identities.",
  upsert_company: "Create or update a company, deduped by normalized domain. Fields: team_size, stack, type, published_email.",
  log_touch: "Record a touch you made or received (the CRM never sends). Updates that channel's state (sent->contacted, inbound->responded) and the overall stage. Optionally sets next_followup_at or a follow-up task.",
  update_stage: "Set a contact's overall stage exactly (new, qualified, drafted, contacted, connection_pending, connected, responded, call_booked, pilot, paying, lost, do_not_contact).",
  list_due_followups: "List open tasks due before a time (default now), with their contacts.",
  create_task: "Create a task / next action, optionally tied to a contact, with a due date.",
  complete_task: "Mark a task completed.",
  add_note: "Attach a timestamped note to a contact or company.",
  get_activity: "Read the append-only activity log (who did what, why), newest first.",
  pipeline_summary: "Counts of contacts per overall stage and number of due tasks.",
  find_existing: "Have we seen this person? Looks up by any identity (email, X, LinkedIn, Reddit, GitHub, or `identity` = any of them) or company domain, plus fuzzy name(+company) candidates with the match reason. Also reports competitor matches. Call before creating a lead. Also accepts identities[] and any prefix form/URL of registry channels (hn:, bsky:, discord:, wa:, ...); exact matches list matched_kinds.",
  is_competitor: "Check a name/company/handle/domain/email (or an existing contact) against the competitor blocklist.",
  add_competitor: "Add a competitor to the blocklist (company name, handle/profile URL, or domain; kind inferred if omitted). The full name is kept as given (display_name) with a normalized key for matching. Name entries take match: exact|fuzzy: exact = a lead's name or company equals the full name (legal suffixes ignored); fuzzy = also the full name as whole words inside a company name.",
  update_competitor: "Edit a blocklist entry by id: restore its full name (value), switch match exact|fuzzy, or change the label. Admin only; logged in activity.",
  remove_competitor: "Remove a blocklist entry by id.",
  purge_competitors: "Bulk-delete blocklist entries by ids and/or a case-insensitive value_regex (optionally filtered by kind). dry_run defaults to true and lists matches; set dry_run=false to delete. Admin only.",
  list_competitors: "List the competitor blocklist.",
  set_channel_state: "Set a contact's state on one channel (x, linkedin, reddit, email): stage (exact), last_touch_at, next_followup_at (the reminder; null clears), next_step. Re-rolls the overall stage forward.",
  create_draft: "Save a message draft (state drafted) for a contact+channel, optionally with an intent_url and campaign. Rejected for competitors and do_not_contact. The CRM never sends.",
  transition_draft: "Move a draft: drafted->approved|discarded|drafted (edit text), approved->sent|discarded|drafted. Mark sent only after YOU sent it; that logs the touch, sets the channel to contacted and optional follow-up. All transitions go to the activity log.",
  list_drafts: "List drafts by state/channel/contact/campaign (e.g. state=approved for the send queue).",
  upsert_campaign: "Create or update a campaign (name unique; offer_text, status). Link contacts via upsert_contact.campaign_id and drafts via create_draft.campaign_id.",
  list_campaigns: "List campaigns.",
  list_contacts: "List contacts filtered by overall stage, lifecycle (lead/contact/archived), channel and channel_stage, source, campaign, contact_type and a text query.",
  list_contacts_view: "Dashboard list rows: contacts with lifecycle, company, linked identities (with outbound profile URLs), filter-scoped total, and lifecycle/stage counts that honour every filter except lifecycle and stage/channel_stage so both tabs and every stage filter can show their totals. Filters: lifecycle, stage, channel, channel_stage, source, campaign, contact_type, query. Paginate with limit/offset.",
  list_companies: "List companies with website URL and contact/lead/relationship counts; optional text query. Paginate with limit/offset.",
  due_followups: "Channel follow-ups (next_followup_at) due by end of today in tz (default Asia/Saigon), flagged overdue, plus open tasks due.",
  stale_no_response: "Contacts contacted / connection_pending / connected on a channel with no touch for at least `days` days.",
  linkedin_needs_first_message: "LinkedIn contacts at connection_pending or connected with no outbound LinkedIn message logged yet.",
  x_pacing_today: "X pacing for today in tz: drafts created, sends, last send time, and whether the 60-min gap and <=8/day limits allow a send now (next_allowed_at).",
  outreach_report: "Per channel and per campaign: contacted, responded, response rate, LinkedIn acceptance rate, pilots, paying; plus goal tracker (3 paying or 10 pilots by 2026-12-15).",
  import_leads_csv: "Import a leads CSV (handle,name,profile_url,...,status,first_seen,notes). Maps status->stage, extracts emails/LinkedIn/GitHub/Reddit/X from notes, dedupes, skips competitors, idempotent on re-run. dry_run defaults to TRUE: returns the report without writing.",
  export_csv: "Export contacts as CSV (import columns first, then ids, identities and per-channel stage/follow-up). An identities column lists every identity (kind@scope:value); private ones (whatsapp) masked unless an admin passes include_private.",
};
/** Tools that need admin (or owner) on top of crm:write. */
export const ADMIN_CRM_TOOLS = new Set<string>(["add_competitor", "update_competitor", "remove_competitor", "purge_competitors", "upsert_campaign", "set_followup_rules", "add_custom_channel"]);
export const TOOL_NAMES = Object.keys(schemas) as (keyof typeof schemas)[];
export const WRITE_TOOLS = new Set<keyof typeof schemas>([
  "add_custom_channel",
  "upsert_contact", "upsert_company", "log_touch", "update_stage", "create_task", "complete_task", "add_note",
  "add_competitor", "update_competitor", "remove_competitor", "purge_competitors", "set_channel_state", "create_draft", "transition_draft", "upsert_campaign", "import_leads_csv",
  "mark_draft_sent", "sync_sent", "record_event", "set_followup_rules", "bulk_update_stage",
]);
