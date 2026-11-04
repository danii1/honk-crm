import { and, count, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { assertSeatAvailable, SeatLimitError, type Auth } from "./auth";
import { CrmError, requireRole, requireScope, type OrgContext } from "./context";
import { apikey, contacts, invitation, member, organization, session, user } from "./db/schema";
import { acceptUrl, deliverInvite } from "./invites";
import { keyRole } from "./middleware";
import type { DB } from "./repository";
import { atLeast, parseRole, ROLES, type Role } from "./roles";

const role = z.enum(ROLES);
const grantable = z.enum(["viewer", "member", "admin", "owner"]);

export const teamSchemas = {
  get_org_usage: z.object({}),
  list_members: z.object({}),
  update_member_role: z.object({ member_id: z.string().optional(), user_id: z.string().optional(), role: grantable }),
  remove_member: z.object({ member_id: z.string().optional(), user_id: z.string().optional() }),
  transfer_ownership: z.object({ member_id: z.string().optional(), user_id: z.string().optional() }),
  invite_member: z.object({ email: z.string().email(), role: grantable.default("member") }),
  list_invites: z.object({ include_closed: z.boolean().default(false) }),
  revoke_invite: z.object({ invite_id: z.string() }),
  accept_invite: z.object({ token: z.string() }),
  list_my_orgs: z.object({}),
  switch_org: z.object({ org_id: z.string() }),
  create_api_key: z.object({ name: z.string().min(1).max(100), role: role.default("member"), expires_in_days: z.number().int().positive().max(3650).optional() }),
  list_api_keys: z.object({}),
  revoke_api_key: z.object({ key_id: z.string() }),
  set_seat_limit: z.object({ seat_limit: z.number().int().positive().nullable() }),
  delete_org: z.object({ confirm_slug: z.string() }),
};
export type TeamTool = keyof typeof teamSchemas;
export const TEAM_TOOL_NAMES = Object.keys(teamSchemas) as TeamTool[];

/** Minimum role per tool (checked centrally in dispatch and again inside each method). User-only tools need no org role. */
export const TEAM_TOOL_ROLE: Record<TeamTool, Role> = {
  get_org_usage: "viewer",
  list_members: "viewer",
  list_my_orgs: "viewer",
  switch_org: "viewer",
  accept_invite: "viewer",
  update_member_role: "admin",
  remove_member: "admin",
  invite_member: "admin",
  list_invites: "admin",
  revoke_invite: "admin",
  create_api_key: "admin",
  list_api_keys: "admin",
  revoke_api_key: "admin",
  transfer_ownership: "owner",
  set_seat_limit: "owner",
  delete_org: "owner",
};
export const TEAM_WRITE_TOOLS = new Set<TeamTool>(["update_member_role", "remove_member", "transfer_ownership", "invite_member", "revoke_invite", "accept_invite", "switch_org", "create_api_key", "revoke_api_key", "set_seat_limit", "delete_org"]);

export const TEAM_TOOL_DESCRIPTIONS: Record<TeamTool, string> = {
  get_org_usage: "Seats used vs seat_limit (members only; API keys are not seats), API key count and contact count.",
  list_members: "List human members of the org with their roles. API keys are listed separately (list_api_keys).",
  update_member_role: "Admin: change a member's role (owner|admin|member|viewer). Admins cannot touch owners or grant owner; the last owner cannot be demoted.",
  remove_member: "Admin: remove a member (by member_id or user_id). Admins cannot remove owners; the last owner cannot be removed.",
  transfer_ownership: "Owner: make another member owner; you become admin.",
  invite_member: "Admin: invite an email with a role. No email is sent by the CRM itself; returns accept_url (the pluggable sender only logs in dev).",
  list_invites: "Admin: list pending invitations (include_closed for accepted/canceled/expired too).",
  revoke_invite: "Admin: cancel a pending invitation.",
  accept_invite: "User only: accept an invitation by token (from accept_url). Your account email must match. Enforces seat_limit.",
  list_my_orgs: "User: the orgs you belong to, with your role and which one is active.",
  switch_org: "User: set your active org (persists on cookie sessions; OAuth/API callers send x-org-id instead).",
  create_api_key: "Admin: create an org-scoped API key for an agent with a role (default member; viewer = read-only). Returns the secret once.",
  list_api_keys: "Admin: list this org's API keys (never the secret).",
  revoke_api_key: "Admin: revoke (delete) an API key of this org.",
  set_seat_limit: "Owner: set the max number of members (null = unlimited). Enforced when invites are accepted.",
  delete_org: "Owner: permanently delete the org and all its CRM data. confirm_slug must equal the org slug.",
};

export interface TeamDeps {
  auth: Auth;
  d1: D1Database;
  baseUrl: string;
}

const parseMeta = (m: unknown): Record<string, unknown> => {
  if (!m) return {};
  if (typeof m === "string") {
    try {
      return JSON.parse(m) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return m as Record<string, unknown>;
};

export class TeamService {
  constructor(
    private db: DB,
    private ctx: OrgContext,
    private deps: TeamDeps,
  ) {}

  private get orgId() {
    return this.ctx.orgId;
  }
  private requireUser(): string {
    if (this.ctx.actor.type !== "user" || !this.ctx.userId) throw new CrmError("forbidden", "this action needs a signed-in user, not an API key");
    return this.ctx.userId;
  }
  private requireWrite(min: Role) {
    requireScope(this.ctx, "crm:write");
    requireRole(this.ctx, min);
  }
  private async members() {
    return this.db.select().from(member).where(eq(member.organizationId, this.orgId));
  }
  private async findMember(i: { member_id?: string; user_id?: string }) {
    if (!i.member_id && !i.user_id) throw new CrmError("invalid", "member_id or user_id is required");
    const where = i.member_id ? eq(member.id, i.member_id) : eq(member.userId, i.user_id!);
    const [m] = await this.db.select().from(member).where(and(eq(member.organizationId, this.orgId), where));
    if (!m) throw new CrmError("not_found", "member not found");
    return m;
  }
  private async ownerCount() {
    return (await this.members()).filter((m) => parseRole(m.role) === "owner").length;
  }
  /** Admins may act on non-owners and grant up to admin; only owners touch owners or grant owner. */
  private assertCanManage(targetRole: Role, newRole?: Role) {
    if (this.ctx.role !== "owner" && (targetRole === "owner" || newRole === "owner")) throw new CrmError("forbidden", "only an owner can change owners or grant owner");
    if (newRole && !atLeast(this.ctx.role, newRole)) throw new CrmError("forbidden", `cannot grant ${newRole} above your own role`);
  }
  private async seatsUsed() {
    const [r] = await this.db.select({ n: count() }).from(member).where(eq(member.organizationId, this.orgId));
    return r?.n ?? 0;
  }
  private async org() {
    const [o] = await this.db.select().from(organization).where(eq(organization.id, this.orgId));
    if (!o) throw new CrmError("not_found", "organization not found");
    return o;
  }

  // ---------- usage / members
  async get_org_usage(raw: unknown = {}) {
    teamSchemas.get_org_usage.parse(raw);
    requireScope(this.ctx, "crm:read");
    const o = await this.org();
    const [keys] = await this.db.select({ n: count() }).from(apikey).where(eq(apikey.referenceId, this.orgId));
    const [cs] = await this.db.select({ n: count() }).from(contacts).where(eq(contacts.orgId, this.orgId));
    const used = await this.seatsUsed();
    return { org_id: o.id, seats_used: used, seat_limit: o.seatLimit ?? null, seats_available: o.seatLimit == null ? null : Math.max(0, o.seatLimit - used), api_key_count: keys?.n ?? 0, contact_count: cs?.n ?? 0 };
  }

  async list_members(raw: unknown = {}) {
    teamSchemas.list_members.parse(raw);
    requireScope(this.ctx, "crm:read");
    const rows = await this.db
      .select({ id: member.id, userId: member.userId, role: member.role, createdAt: member.createdAt, email: user.email, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, this.orgId));
    return { members: rows.map((r) => ({ member_id: r.id, user_id: r.userId, email: r.email, name: r.name, role: parseRole(r.role), joined_at: r.createdAt })) };
  }

  async update_member_role(raw: unknown) {
    const i = teamSchemas.update_member_role.parse(raw);
    this.requireWrite("admin");
    const m = await this.findMember(i);
    const cur = parseRole(m.role);
    this.assertCanManage(cur, i.role);
    if (cur === "owner" && i.role !== "owner" && (await this.ownerCount()) <= 1) throw new CrmError("conflict", "cannot demote the last owner; transfer ownership first");
    await this.db.update(member).set({ role: i.role }).where(and(eq(member.id, m.id), eq(member.organizationId, this.orgId)));
    return { member_id: m.id, user_id: m.userId, role: i.role, previous_role: cur };
  }

  async remove_member(raw: unknown) {
    const i = teamSchemas.remove_member.parse(raw);
    this.requireWrite("admin");
    const m = await this.findMember(i);
    const cur = parseRole(m.role);
    this.assertCanManage(cur);
    if (cur === "owner" && (await this.ownerCount()) <= 1) throw new CrmError("conflict", "cannot remove the last owner");
    await this.db.delete(member).where(and(eq(member.id, m.id), eq(member.organizationId, this.orgId)));
    await this.db.update(session).set({ activeOrganizationId: null }).where(and(eq(session.userId, m.userId), eq(session.activeOrganizationId, this.orgId)));
    return { removed: true, member_id: m.id, user_id: m.userId };
  }

  async transfer_ownership(raw: unknown) {
    const i = teamSchemas.transfer_ownership.parse(raw);
    this.requireWrite("owner");
    const me = this.requireUser();
    const target = await this.findMember(i);
    if (target.userId === me) throw new CrmError("invalid", "you already own this org");
    await this.db.batch([
      this.db.update(member).set({ role: "owner" }).where(and(eq(member.id, target.id), eq(member.organizationId, this.orgId))),
      this.db.update(member).set({ role: "admin" }).where(and(eq(member.userId, me), eq(member.organizationId, this.orgId))),
    ]);
    return { new_owner: { member_id: target.id, user_id: target.userId }, your_role: "admin" };
  }

  // ---------- invitations
  async invite_member(raw: unknown) {
    const i = teamSchemas.invite_member.parse(raw);
    this.requireWrite("admin");
    this.assertCanManage("member", i.role);
    const email = i.email.toLowerCase();
    const o = await this.org();
    const existing = await this.db.select({ id: member.id }).from(member).innerJoin(user, eq(user.id, member.userId)).where(and(eq(member.organizationId, this.orgId), eq(user.email, email)));
    if (existing.length) throw new CrmError("conflict", "already a member");
    // Inviter must be a user row (FK). Agents invite on behalf of an owner.
    const inviterId = this.ctx.userId ?? (await this.anyOwnerUserId());
    // Re-inviting replaces the previous pending invite.
    await this.db.update(invitation).set({ status: "canceled" }).where(and(eq(invitation.organizationId, this.orgId), eq(invitation.email, email), eq(invitation.status, "pending")));
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await this.db.insert(invitation).values({ id, organizationId: this.orgId, email, role: i.role, status: "pending", expiresAt, createdAt: new Date(), inviterId });
    const url = acceptUrl(this.deps.baseUrl, id);
    const [inv] = await this.db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, inviterId));
    await deliverInvite({ invitationId: id, email, role: i.role, organization: { id: o.id, name: o.name }, inviter: { id: inviterId, name: inv?.name, email: inv?.email }, acceptUrl: url, expiresAt });
    return { invite: { id, email, role: i.role, status: "pending", expires_at: expiresAt }, token: id, accept_url: url, email_sent: false };
  }

  private async anyOwnerUserId() {
    const owner = (await this.members()).find((m) => parseRole(m.role) === "owner");
    if (!owner) throw new CrmError("conflict", "org has no owner");
    return owner.userId;
  }

  async list_invites(raw: unknown = {}) {
    const i = teamSchemas.list_invites.parse(raw);
    requireScope(this.ctx, "crm:read");
    requireRole(this.ctx, "admin");
    const rows = await this.db
      .select()
      .from(invitation)
      .where(i.include_closed ? eq(invitation.organizationId, this.orgId) : and(eq(invitation.organizationId, this.orgId), eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())));
    return { invites: rows.map((r) => ({ id: r.id, email: r.email, role: r.role, status: r.status === "pending" && r.expiresAt < new Date() ? "expired" : r.status, expires_at: r.expiresAt, inviter_id: r.inviterId, accept_url: r.status === "pending" ? acceptUrl(this.deps.baseUrl, r.id) : undefined })) };
  }

  async revoke_invite(raw: unknown) {
    const i = teamSchemas.revoke_invite.parse(raw);
    this.requireWrite("admin");
    const [r] = await this.db.select().from(invitation).where(and(eq(invitation.id, i.invite_id), eq(invitation.organizationId, this.orgId)));
    if (!r) throw new CrmError("not_found", "invite not found");
    if (r.status !== "pending") throw new CrmError("conflict", `invite is ${r.status}`);
    await this.db.update(invitation).set({ status: "canceled" }).where(and(eq(invitation.id, r.id), eq(invitation.organizationId, this.orgId)));
    return { id: r.id, status: "canceled" };
  }

  // ---------- user-level (no org role needed)
  list_my_orgs = async (raw: unknown = {}) => listMyOrgs(this.db, this.requireUser(), raw, this.orgId);
  switch_org = async (raw: unknown) => switchOrg(this.db, this.requireUser(), this.ctx.sessionId, raw);
  accept_invite = async (raw: unknown) => acceptInvite(this.db, this.deps.d1, this.requireUser(), raw);

  // ---------- API keys (org-scoped, not seats)
  async create_api_key(raw: unknown) {
    const i = teamSchemas.create_api_key.parse(raw);
    this.requireWrite("admin");
    if (!atLeast(this.ctx.role, i.role)) throw new CrmError("forbidden", `cannot create a key with role ${i.role} above your own`);
    // Better Auth checks that the creating user may create org keys; agents create on behalf of an owner.
    const creatorUserId = this.ctx.userId ?? (await this.anyOwnerUserId());
    const created = await this.deps.auth.api.createApiKey({
      body: {
        name: i.name,
        organizationId: this.orgId,
        userId: creatorUserId,
        expiresIn: i.expires_in_days ? i.expires_in_days * 86400 : undefined,
        permissions: { crm: i.role === "viewer" ? ["read"] : ["read", "write"] },
        metadata: { role: i.role, created_by: this.ctx.actor.id },
      },
    });
    return { key: { id: created.id, name: created.name, role: i.role, start: created.start, expires_at: created.expiresAt }, secret: created.key, note: "store the secret now; it cannot be shown again" };
  }

  async list_api_keys(raw: unknown = {}) {
    teamSchemas.list_api_keys.parse(raw);
    requireScope(this.ctx, "crm:read");
    requireRole(this.ctx, "admin");
    const rows = await this.db.select().from(apikey).where(eq(apikey.referenceId, this.orgId));
    return { api_keys: rows.map((k) => ({ id: k.id, name: k.name, role: keyRole(k.metadata), start: k.start, enabled: k.enabled, created_by: parseMeta(k.metadata).created_by ?? null, created_at: k.createdAt, expires_at: k.expiresAt, last_used_at: k.lastRequest })) };
  }

  async revoke_api_key(raw: unknown) {
    const i = teamSchemas.revoke_api_key.parse(raw);
    this.requireWrite("admin");
    const [k] = await this.db.select({ id: apikey.id }).from(apikey).where(and(eq(apikey.id, i.key_id), eq(apikey.referenceId, this.orgId)));
    if (!k) throw new CrmError("not_found", "api key not found");
    await this.db.delete(apikey).where(and(eq(apikey.id, k.id), eq(apikey.referenceId, this.orgId)));
    return { revoked: true, id: k.id };
  }

  // ---------- org admin
  async set_seat_limit(raw: unknown) {
    const i = teamSchemas.set_seat_limit.parse(raw);
    this.requireWrite("owner");
    await this.db.update(organization).set({ seatLimit: i.seat_limit }).where(eq(organization.id, this.orgId));
    const used = await this.seatsUsed();
    return { seat_limit: i.seat_limit, seats_used: used, over_limit: i.seat_limit != null && used > i.seat_limit };
  }

  async delete_org(raw: unknown) {
    const i = teamSchemas.delete_org.parse(raw);
    this.requireWrite("owner");
    const o = await this.org();
    if (i.confirm_slug !== o.slug) throw new CrmError("invalid", "confirm_slug does not match the org slug");
    await this.db.batch([
      this.db.delete(apikey).where(eq(apikey.referenceId, o.id)),
      this.db.update(session).set({ activeOrganizationId: null }).where(eq(session.activeOrganizationId, o.id)),
      this.db.delete(organization).where(eq(organization.id, o.id)),
    ]);
    return { deleted: true, org_id: o.id };
  }
}

// ---------- user-scoped helpers (also used by routes that don't have an org yet)
export async function listMyOrgs(db: DB, userId: string, raw: unknown = {}, activeOrgId?: string) {
  teamSchemas.list_my_orgs.parse(raw);
  const rows = await db.select({ id: organization.id, name: organization.name, slug: organization.slug, role: member.role }).from(member).innerJoin(organization, eq(organization.id, member.organizationId)).where(eq(member.userId, userId));
  return { orgs: rows.map((r) => ({ org_id: r.id, name: r.name, slug: r.slug, role: parseRole(r.role), active: r.id === activeOrgId })) };
}

export async function switchOrg(db: DB, userId: string, sessionId: string | undefined, raw: unknown) {
  const i = teamSchemas.switch_org.parse(raw);
  const [m] = await db.select({ role: member.role }).from(member).where(and(eq(member.userId, userId), eq(member.organizationId, i.org_id)));
  if (!m) throw new CrmError("forbidden", "not a member of that organization");
  if (sessionId) await db.update(session).set({ activeOrganizationId: i.org_id }).where(and(eq(session.id, sessionId), eq(session.userId, userId)));
  return { active_org_id: i.org_id, role: parseRole(m.role), persisted: !!sessionId, hint: sessionId ? undefined : "send x-org-id on subsequent requests" };
}

export async function acceptInvite(db: DB, d1: D1Database, userId: string, raw: unknown) {
  const i = teamSchemas.accept_invite.parse(raw);
  const [inv] = await db.select().from(invitation).where(eq(invitation.id, i.token));
  if (!inv) throw new CrmError("not_found", "invite not found");
  if (inv.status !== "pending") throw new CrmError("conflict", `invite is ${inv.status}`);
  if (inv.expiresAt < new Date()) throw new CrmError("conflict", "invite has expired");
  const [u] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (!u || u.email.toLowerCase() !== inv.email.toLowerCase()) throw new CrmError("forbidden", "this invite was sent to a different email");
  const already = await db.select({ id: member.id }).from(member).where(and(eq(member.userId, userId), eq(member.organizationId, inv.organizationId)));
  if (!already.length) {
    try {
      await assertSeatAvailable(d1, inv.organizationId);
    } catch (e) {
      if (e instanceof SeatLimitError) throw new CrmError("forbidden", e.message);
      throw e;
    }
  }
  const r = parseRole(inv.role);
  const markAccepted = db.update(invitation).set({ status: "accepted" }).where(eq(invitation.id, inv.id));
  if (already.length) await markAccepted;
  else await db.batch([db.insert(member).values({ id: crypto.randomUUID(), organizationId: inv.organizationId, userId, role: r, createdAt: new Date() }), markAccepted]);
  return { org_id: inv.organizationId, role: r, already_member: already.length > 0 };
}

