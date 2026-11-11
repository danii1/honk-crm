export interface Me {
  orgId: string;
  actor: { type: string; id: string; name?: string };
  scopes: string[];
  role: "owner" | "admin" | "member" | "viewer";
  userId?: string;
}

export interface Identity {
  kind: string;
  channel: string;
  label: string;
  value: string;
  scope?: string;
  private?: boolean;
  url?: string | null;
}

export interface Company {
  id: string;
  name: string;
  domain?: string | null;
  website?: string | null;
  website_url?: string | null;
  linkedin?: string | null;
  teamSize?: number | null;
  type?: string | null;
  stack?: string[] | null;
  publishedEmail?: string | null;
  contacts?: number;
  leads?: number;
  relationships?: number;
}

export type Lifecycle = "lead" | "contact" | "archived";

export interface Contact {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  linkedin?: string | null;
  xHandle?: string | null;
  redditUser?: string | null;
  github?: string | null;
  threadsHandle?: string | null;
  companyId?: string | null;
  campaignId?: string | null;
  company?: Company | null;
  contactType: string;
  source?: string | null;
  sourceDetail?: string | null;
  profileUrl?: string | null;
  website?: string | null;
  bioSummary?: string | null;
  followers?: number | null;
  estTeamSize?: number | null;
  score?: number | null;
  firstSeenAt?: string | null;
  notesText?: string | null;
  signalPostUrl?: string | null;
  signalDate?: string | null;
  signalSummary?: string | null;
  stage: string;
  lifecycle: Lifecycle;
  stageChangedAt?: string | null;
  lastTouchAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  identities?: Identity[];
}

export interface ChannelState {
  id: string;
  contactId: string;
  channel: string;
  stage: string;
  lastTouchAt?: string | null;
  nextFollowupAt?: string | null;
  nextStep?: string | null;
}

export interface Draft {
  id: string;
  contactId: string;
  channel: string;
  text: string;
  intentUrl?: string | null;
  state: "drafted" | "approved" | "sent" | "discarded";
  sentAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Touch {
  id: string;
  contactId: string;
  channel: string;
  direction: "outbound" | "inbound";
  status: string;
  subject?: string | null;
  body?: string | null;
  sentAt?: string | null;
  createdAt?: string | null;
}

export interface Note {
  id: string;
  body: string;
  author: string;
  createdAt: string;
}

export interface EventRow {
  id: string;
  contactId: string;
  name?: string | null;
  lifecycle?: Lifecycle | null;
  channel: string;
  type: string;
  summary?: string | null;
  occurredAt: string;
}

export interface Activity {
  id: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ContactDetail extends Contact {
  tags: string[];
  channel_states: ChannelState[];
  drafts: Draft[];
  touches: Touch[];
  events: EventRow[];
  open_tasks: { id: string; title: string; dueAt?: string | null }[];
  notes: Note[];
}

export interface ContactListResponse {
  contacts: Contact[];
  /** Number of contacts matching the current filters (not limited by the page size). */
  total: number;
  counts: { lead: number; contact: number; archived: number; total: number; stages: Record<string, number> };
}

export interface PipelineSummary {
  stages: Record<string, number>;
  lifecycles: { lead: number; contact: number; archived: number; total: number };
  total: number;
  due_followups: number;
}

export interface Overview {
  date: string;
  tz: string;
  followups_due: { contact_id: string; name?: string | null; lifecycle?: Lifecycle | null; channel: string; stage: string; next_followup_at?: string | null; next_step?: string | null; overdue?: boolean }[];
  tasks_due: { task: { id: string; title: string; dueAt?: string | null }; contact?: { id: string; name?: string | null } | null }[];
  linkedin_awaiting_first_message: { contact_id: string; name?: string | null; lifecycle?: Lifecycle | null; linkedin?: string | null; stage: string; next_step?: string | null }[];
  new_replies: EventRow[];
  events_last_24h: EventRow[];
  drafts_pending: { id: string; contact_id: string; name?: string | null; lifecycle?: Lifecycle | null; channel: string; state: string; text: string; intent_url?: string | null; created_at?: string | null }[];
  x_pacing: { date: string; drafted_today: number; sent_today: number; remaining_today: number; last_sent_at?: string | null; minutes_since_last_send?: number | null; gap_ok: boolean; cap_ok: boolean; ok_to_send: boolean; next_allowed_at?: string | null };
  stale: { contact_id: string; name?: string | null; lifecycle?: Lifecycle | null; channel: string; stage: string; last_touch_at?: string | null; days_since: number; threshold_days: number }[];
  goal: { targets: { stage: string; current: number; target: number; progress_pct: number | null }[]; deadline: string | null; days_left: number | null; met: boolean } | null;
  totals: { leads: number; contacted: number; responded: number; response_rate_pct: number | null; call_booked: number; pilots: number; paying: number };
  stages: Record<string, number>;
}

export interface ChannelDef {
  id: string;
  label: string;
  kinds: string[];
  prefixes: string[];
  followup_days: number;
  stale_days: number;
  private: boolean;
  custom: boolean;
  url_pattern?: string;
  scoped: boolean;
}

export interface Competitor {
  id: string;
  kind: string;
  value: string;
  label?: string | null;
  displayName?: string | null;
  match: "exact" | "fuzzy";
  createdAt?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  if (res.status === 401) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.assign(`/sign-in?next=${next}`);
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string; error?: string }).message ?? (body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export function api<T>(tool: string, body: Record<string, unknown> = {}) {
  return request<T>(`/v1/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export const getMe = () => request<Me>("/v1/me");
export const getOverview = (tz: string) => request<Overview>(`/v1/overview?tz=${encodeURIComponent(tz)}`);
export const getGoals = () => api<{ targets: { stage: string; count: number }[]; deadline?: string }>("get_goals");
export const setGoals = (goals: { targets: { stage: string; count: number }[]; deadline?: string }) => api<typeof goals>("set_goals", goals);
export const getPipeline = () => api<PipelineSummary>("pipeline_summary");
export const listContactsView = (params: Record<string, unknown> = {}) => api<ContactListResponse>("list_contacts_view", params);
export const getContact = (id: string, includePrivate = false) => api<ContactDetail>("get_contact", { id, ...(includePrivate && { include_private: true }) });
export const getActivity = (entityId: string) => api<Activity[]>("get_activity", { entity_type: "contact", entity_id: entityId, limit: 100 });
export const listCompanies = (query?: string, offset = 0) => api<{ companies: Company[]; total: number }>("list_companies", { query, limit: 500, offset });
export const listCompetitors = () => api<Competitor[]>("list_competitors", {});
export const listCampaigns = () => api<{ id: string; name: string; status: string; offerText?: string | null }[]>("list_campaigns", {});
export const listChannels = () => api<{ channels: ChannelDef[]; extra_sources: string[] }>("list_channels", {});
export const updateStage = (contactId: string, stage: string) => api<Contact>("update_stage", { contact_id: contactId, stage });
export const transitionDraft = (draftId: string, to: string) => api<{ draft: Draft }>("transition_draft", { draft_id: draftId, to });
