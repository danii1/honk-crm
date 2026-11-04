import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { createAuth } from "../src/auth";
import type { OrgContext } from "../src/context";
import { setInviteSender, type InviteMessage } from "../src/invites";
import type { Role } from "../src/roles";
import { scopesForRole } from "../src/roles";
import { callTool } from "../src/tools";
import { db } from "./helpers";

const auth = createAuth(env);
const deps = { auth, d1: env.DB, baseUrl: "http://localhost" };

async function signUp(tag: string) {
  const email = `${tag}-${crypto.randomUUID()}@test.dev`;
  const { user } = await auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name: tag } });
  return { id: user.id, email };
}
async function newOrg(tag: string) {
  const owner = await signUp(`${tag}-owner`);
  const org = await auth.api.createOrganization({ body: { name: tag, slug: `${tag}-${crypto.randomUUID()}`, userId: owner.id } });
  return { orgId: org!.id, slug: org!.slug, owner };
}
const userCtx = (orgId: string, userId: string, role: Role): OrgContext => ({ orgId, actor: { type: "user", id: userId }, userId, role, scopes: scopesForRole(role) });
const call = (ctx: OrgContext, tool: string, args: unknown = {}) => callTool(tool, args, db, ctx, deps) as Promise<Record<string, any>>;
const rest = (key: string, tool: string, body: unknown) => SELF.fetch(`http://localhost/v1/${tool}`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string; message: string }) => e.code ?? e.message);

/** Owner invites `role`, a fresh user accepts; returns that user's ctx. */
async function join(o: Awaited<ReturnType<typeof newOrg>>, role: Role) {
  const u = await signUp(role);
  const inv = await call(userCtx(o.orgId, o.owner.id, "owner"), "invite_member", { email: u.email, role });
  await call(userCtx(o.orgId, u.id, "viewer"), "accept_invite", { token: inv.token });
  return { ...u, ctx: userCtx(o.orgId, u.id, role) };
}

describe("teams: invitations", () => {
  it("invite -> list -> accept via token; pluggable sender gets the accept URL; no email sent", async () => {
    const sent: InviteMessage[] = [];
    setInviteSender((m) => void sent.push(m));
    try {
      const o = await newOrg("inv");
      const owner = userCtx(o.orgId, o.owner.id, "owner");
      const bob = await signUp("bob");
      const inv = await call(owner, "invite_member", { email: bob.email.toUpperCase(), role: "member" });
      expect(inv).toMatchObject({ email_sent: false, accept_url: `http://localhost/accept-invite?token=${inv.token}` });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ email: bob.email, acceptUrl: inv.accept_url, role: "member" });
      expect((await call(owner, "list_invites")).invites.map((i: { id: string }) => i.id)).toEqual([inv.token]);

      const eve = await signUp("eve");
      expect(await code(call(userCtx(o.orgId, eve.id, "viewer"), "accept_invite", { token: inv.token }))).toBe("forbidden");
      expect(await call(userCtx(o.orgId, bob.id, "viewer"), "accept_invite", { token: inv.token })).toMatchObject({ org_id: o.orgId, role: "member" });
      expect(await code(call(userCtx(o.orgId, bob.id, "viewer"), "accept_invite", { token: inv.token }))).toBe("conflict");
      expect((await call(owner, "list_invites")).invites).toHaveLength(0);
      const members = (await call(owner, "list_members")).members;
      expect(members.map((m: { role: string }) => m.role).toSorted()).toEqual(["member", "owner"]);
      expect(await code(call(owner, "invite_member", { email: bob.email }))).toBe("conflict");
    } finally {
      setInviteSender(null);
    }
  });

  it("revoke_invite; admins cannot invite owners; viewers/members cannot invite", async () => {
    const o = await newOrg("rev");
    const owner = userCtx(o.orgId, o.owner.id, "owner");
    const inv = await call(owner, "invite_member", { email: "x@corp.io" });
    expect(await call(owner, "revoke_invite", { invite_id: inv.token })).toMatchObject({ status: "canceled" });
    const x = await signUp("x");
    expect(await code(call(userCtx(o.orgId, x.id, "viewer"), "accept_invite", { token: inv.token }))).toBe("conflict");
    const admin = await join(o, "admin");
    expect(await code(call(admin.ctx, "invite_member", { email: "y@corp.io", role: "owner" }))).toBe("forbidden");
    expect(await code(call(admin.ctx, "invite_member", { email: "y@corp.io", role: "admin" }))).toBe("ok");
    const member = await join(o, "member");
    expect(await code(call(member.ctx, "invite_member", { email: "z@corp.io" }))).toBe("forbidden");
  });

  it("HTTP: POST /invites/accept with a session cookie, then switch_org/list_my_orgs over REST", async () => {
    const o = await newOrg("http-inv");
    const other = await newOrg("http-other");
    const carol = await signUp("carol");
    // carol also owns her own org -> 2 memberships
    const own = await auth.api.createOrganization({ body: { name: "carol-co", slug: `carol-${crypto.randomUUID()}`, userId: carol.id } });
    const inv = await call(userCtx(o.orgId, o.owner.id, "owner"), "invite_member", { email: carol.email, role: "viewer" });
    const signIn = await SELF.fetch("http://localhost/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: carol.email, password: "correct-horse-battery" }) });
    const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;
    expect((await SELF.fetch("http://localhost/invites/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: inv.token }) })).status).toBe(401);
    const acc = await SELF.fetch("http://localhost/invites/accept", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ token: inv.token }) });
    expect(await acc.json()).toMatchObject({ org_id: o.orgId, role: "viewer" });
    // accept switched the session's active org -> viewer, read-only
    const me = await (await SELF.fetch("http://localhost/v1/me", { headers: { cookie } })).json<OrgContext>();
    expect(me).toMatchObject({ orgId: o.orgId, role: "viewer", scopes: ["crm:read"] });
    const post = (tool: string, body: unknown) => SELF.fetch(`http://localhost/v1/${tool}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("upsert_contact", { email: "a@b.io" })).status).toBe(403);
    expect((await post("switch_org", { org_id: other.orgId })).status).toBe(403);
    expect(await (await post("switch_org", { org_id: own!.id })).json()).toMatchObject({ persisted: true, role: "owner" });
    expect((await post("upsert_contact", { email: "a@b.io" })).status).toBe(200);
    const orgs = (await (await post("list_my_orgs", {})).json<{ orgs: { org_id: string; active: boolean }[] }>()).orgs;
    expect(orgs).toHaveLength(2);
    expect(orgs.find((x) => x.active)?.org_id).toBe(own!.id);
  });
});

describe("teams: roles", () => {
  it("viewer can read but not write; member writes CRM but not blocklist/campaigns/keys/members", async () => {
    const o = await newOrg("roles");
    const viewer = await join(o, "viewer");
    const member = await join(o, "member");
    expect(await code(call(viewer.ctx, "upsert_contact", { email: "v@corp.io" }))).toBe("forbidden");
    expect(await code(call(viewer.ctx, "search_contacts", {}))).toBe("ok");
    expect(await code(call(viewer.ctx, "get_org_usage"))).toBe("ok");
    expect(await code(call(member.ctx, "upsert_contact", { email: "m@corp.io" }))).toBe("ok");
    expect(await code(call(member.ctx, "add_competitor", { handle: "@rival", channel: "x" }))).toBe("forbidden");
    expect(await code(call(member.ctx, "upsert_campaign", { name: "Q4" }))).toBe("forbidden");
    expect(await code(call(member.ctx, "create_api_key", { name: "bot" }))).toBe("forbidden");
    expect(await code(call(member.ctx, "list_api_keys"))).toBe("forbidden");
    expect(await code(call(member.ctx, "update_member_role", { user_id: viewer.id, role: "member" }))).toBe("forbidden");
    const admin = await join(o, "admin");
    expect(await code(call(admin.ctx, "update_member_role", { user_id: viewer.id, role: "member" }))).toBe("ok");
    expect(await code(call(admin.ctx, "set_seat_limit", { seat_limit: 10 }))).toBe("forbidden");
    expect(await code(call(admin.ctx, "delete_org", { confirm_slug: o.slug }))).toBe("forbidden");
  });

  it("API keys carry a role: viewer key is read-only over REST and MCP; keys are not seats", async () => {
    const o = await newOrg("keys");
    const owner = userCtx(o.orgId, o.owner.id, "owner");
    const admin = await join(o, "admin");
    expect(await code(call(admin.ctx, "create_api_key", { name: "too-high", role: "owner" }))).toBe("forbidden");
    const vk = await call(admin.ctx, "create_api_key", { name: "reader", role: "viewer" });
    const mk = await call(owner, "create_api_key", { name: "worker" });
    expect(mk.key.role).toBe("member");
    expect(await (await SELF.fetch("http://localhost/v1/me", { headers: { "x-api-key": vk.secret } })).json()).toMatchObject({ role: "viewer", scopes: ["crm:read"], actor: { type: "agent" } });
    expect((await rest(vk.secret, "upsert_contact", { email: "k@corp.io" })).status).toBe(403);
    expect((await rest(vk.secret, "search_contacts", {})).status).toBe(200);
    expect((await rest(mk.secret, "upsert_contact", { email: "k@corp.io" })).status).toBe(200);
    expect((await rest(mk.secret, "add_competitor", { handle: "@r", channel: "x" })).status).toBe(403);
    expect((await rest(mk.secret, "create_api_key", { name: "x" })).status).toBe(403);
    const mcpRes = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: { host: "localhost", authorization: `Bearer ${vk.secret}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "upsert_contact", arguments: { email: "q@corp.io" } } }),
    });
    expect(await mcpRes.text()).toMatch(/forbidden/);

    const usage = await call(owner, "get_org_usage");
    expect(usage).toMatchObject({ seats_used: 2, seat_limit: null, api_key_count: 2, contact_count: 1 });
    const keys = (await call(admin.ctx, "list_api_keys")).api_keys;
    expect(keys.map((k: { role: string }) => k.role).toSorted()).toEqual(["member", "viewer"]);
    expect(JSON.stringify(keys)).not.toContain(vk.secret);
    await call(admin.ctx, "revoke_api_key", { key_id: vk.key.id });
    expect((await rest(vk.secret, "search_contacts", {})).status).toBe(401);
  });
});

describe("teams: seats and owners", () => {
  it("seat_limit is enforced on accept (and on Better Auth's addMember); keys don't use seats", async () => {
    const o = await newOrg("seats");
    const owner = userCtx(o.orgId, o.owner.id, "owner");
    expect(await call(owner, "set_seat_limit", { seat_limit: 2 })).toMatchObject({ seats_used: 1 });
    await call(owner, "create_api_key", { name: "bot1" });
    await join(o, "member");
    const late = await signUp("late");
    const inv = await call(owner, "invite_member", { email: late.email });
    expect(await code(call(userCtx(o.orgId, late.id, "viewer"), "accept_invite", { token: inv.token }))).toBe("forbidden");
    await expect(auth.api.addMember({ body: { organizationId: o.orgId, userId: late.id, role: "member" } })).rejects.toThrow(/seat limit/);
    expect(await call(owner, "get_org_usage")).toMatchObject({ seats_used: 2, seat_limit: 2, seats_available: 0, api_key_count: 1 });
    await call(owner, "set_seat_limit", { seat_limit: null });
    expect(await code(call(userCtx(o.orgId, late.id, "viewer"), "accept_invite", { token: inv.token }))).toBe("ok");
  });

  it("last owner can't be removed or demoted; admins can't touch owners; transfer_ownership", async () => {
    const o = await newOrg("owners");
    const owner = userCtx(o.orgId, o.owner.id, "owner");
    const admin = await join(o, "admin");
    expect(await code(call(owner, "remove_member", { user_id: o.owner.id }))).toBe("conflict");
    expect(await code(call(owner, "update_member_role", { user_id: o.owner.id, role: "admin" }))).toBe("conflict");
    expect(await code(call(admin.ctx, "remove_member", { user_id: o.owner.id }))).toBe("forbidden");
    expect(await code(call(admin.ctx, "update_member_role", { user_id: admin.id, role: "owner" }))).toBe("forbidden");
    expect(await call(owner, "transfer_ownership", { user_id: admin.id })).toMatchObject({ your_role: "admin" });
    const roles = Object.fromEntries((await call(owner, "list_members")).members.map((m: { user_id: string; role: string }) => [m.user_id, m.role]));
    expect(roles).toEqual({ [o.owner.id]: "admin", [admin.id]: "owner" });
    const newOwner = userCtx(o.orgId, admin.id, "owner");
    expect(await code(call(newOwner, "remove_member", { user_id: o.owner.id }))).toBe("ok");
    expect(await code(call(newOwner, "remove_member", { user_id: admin.id }))).toBe("conflict");
  });

  it("delete_org (owner, slug-confirmed) removes the org and its CRM data, including the audit log", async () => {
    const o = await newOrg("del");
    const owner = userCtx(o.orgId, o.owner.id, "owner");
    await call(owner, "upsert_contact", { email: "gone@corp.io" });
    expect(await code(call(owner, "delete_org", { confirm_slug: "nope" }))).toBe("invalid");
    expect(await call(owner, "delete_org", { confirm_slug: o.slug })).toMatchObject({ deleted: true });
    const left = await env.DB.prepare("select (select count(*) from contacts where org_id = ?1) + (select count(*) from activity_log where org_id = ?1) + (select count(*) from member where organization_id = ?1) as n").bind(o.orgId).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe("teams: cross-org isolation", () => {
  it("invites and keys of org A are invisible and untouchable from org B", async () => {
    const a = await newOrg("iso-a");
    const b = await newOrg("iso-b");
    const ownerA = userCtx(a.orgId, a.owner.id, "owner");
    const ownerB = userCtx(b.orgId, b.owner.id, "owner");
    const inv = await call(ownerA, "invite_member", { email: "shared@corp.io" });
    const key = await call(ownerA, "create_api_key", { name: "a-bot" });
    expect((await call(ownerB, "list_invites")).invites).toHaveLength(0);
    expect((await call(ownerB, "list_api_keys")).api_keys).toHaveLength(0);
    expect(await code(call(ownerB, "revoke_invite", { invite_id: inv.token }))).toBe("not_found");
    expect(await code(call(ownerB, "revoke_api_key", { key_id: key.key.id }))).toBe("not_found");
    expect(await code(call(ownerB, "remove_member", { user_id: a.owner.id }))).toBe("not_found");
    // A's key ignores x-org-id and stays in A
    const me = await (await SELF.fetch("http://localhost/v1/me", { headers: { "x-api-key": key.secret, "x-org-id": b.orgId } })).json<OrgContext>();
    expect(me.orgId).toBe(a.orgId);
    expect((await call(ownerA, "list_api_keys")).api_keys).toHaveLength(1);
  });
});

describe("sign-up guard", () => {
  it("allowlist, pending invite, otherwise invite-only", async () => {
    const { signupAllowed } = await import("../src/auth");
    expect(await signupAllowed(env.DB, "x@test.dev", "@test.dev")).toBe(true);
    expect(await signupAllowed(env.DB, "Boss@Corp.io", "boss@corp.io, @other.io")).toBe(true);
    expect(await signupAllowed(env.DB, "anyone@corp.io", "*")).toBe(true);
    await signUp("someone"); // ensure users exist
    expect(await signupAllowed(env.DB, "stranger@corp.io", "")).toBe(false);
    const o = await newOrg("guard");
    await call(userCtx(o.orgId, o.owner.id, "owner"), "invite_member", { email: "invited@corp.io" });
    expect(await signupAllowed(env.DB, "invited@corp.io", "")).toBe(true);
    await expect(auth.api.signUpEmail({ body: { email: "stranger@corp.io", password: "correct-horse-battery", name: "s" } })).rejects.toThrow();
  });
});
