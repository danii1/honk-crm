import { and, eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { API_KEY_PREFIX, type Auth } from "./auth";
import { member } from "./db/schema";
import { SCOPES, type OrgContext } from "./context";
import { isRole, parseRole, scopesForRole, type Role } from "./roles";
import type { DB } from "./repository";

export class AuthError extends Error {
  constructor(
    public status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

const CRM_SCOPES = new Set<string>(SCOPES);

/** API-key permissions look like { crm: ["read", "write"] }. */
function scopesFromPermissions(perms: unknown): string[] {
  const p = typeof perms === "string" ? (JSON.parse(perms) as Record<string, string[]>) : (perms as Record<string, string[]> | null);
  const crm = p?.crm ?? [];
  return crm.map((a) => `crm:${a}`).filter((s) => CRM_SCOPES.has(s));
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
}

export function keyRole(metadata: unknown): Role {
  const m = typeof metadata === "string" ? (JSON.parse(metadata) as Record<string, unknown>) : (metadata as Record<string, unknown> | null);
  return isRole(m?.role) ? m.role : "member";
}
const intersect = (a: string[], b: string[]) => a.filter((s) => b.includes(s));

export interface ResolvedUser {
  userId: string;
  name?: string;
  sessionId?: string;
  activeOrgId?: string | null;
  tokenScopes: string[];
}

/** Identifies the calling human (OAuth bearer JWT or Better Auth session cookie), without needing an org. */
export async function resolveUser(req: Request, auth: Auth, resource: string): Promise<ResolvedUser | null> {
  const token = req.headers.get("x-api-key") ?? bearer(req);
  if (token?.startsWith(API_KEY_PREFIX)) return null;
  if (token) {
    const claims = await verifyAccessToken(token, auth, resource);
    if (!claims.sub) throw new AuthError(401, "token has no subject");
    return { userId: claims.sub, name: typeof claims.name === "string" ? claims.name : undefined, tokenScopes: String(claims.scope ?? "").split(/\s+/).filter((s) => CRM_SCOPES.has(s)) };
  }
  const s = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  if (!s) return null;
  return { userId: s.user.id, name: s.user.name, sessionId: s.session.id, activeOrgId: (s.session as { activeOrganizationId?: string | null }).activeOrganizationId, tokenScopes: [...SCOPES] };
}

/**
 * The single place that turns a request into an OrgContext.
 *  - `x-api-key: ocrm_...` / `Bearer ocrm_...` -> org-owned API key (actor = agent, role = key metadata.role, default member)
 *  - `Bearer <jwt>` (OAuth) or Better Auth session cookie -> user (role = membership role);
 *    org = `x-org-id` header, else the session's active org, else the user's only membership.
 * Effective scopes = credential scopes ∩ role scopes (viewer => read only).
 */
export async function resolveOrgContext(req: Request, auth: Auth, db: DB, resource: string): Promise<OrgContext> {
  const token = req.headers.get("x-api-key") ?? bearer(req);
  if (token?.startsWith(API_KEY_PREFIX)) {
    const res = await auth.api.verifyApiKey({ body: { key: token } });
    if (!res.valid || !res.key) throw new AuthError(401, "invalid api key");
    const role = keyRole(res.key.metadata);
    return {
      orgId: res.key.referenceId,
      actor: { type: "agent", id: `apikey:${res.key.id}`, name: res.key.name ?? undefined },
      role,
      scopes: intersect(scopesFromPermissions(res.key.permissions), scopesForRole(role)),
    };
  }
  const u = await resolveUser(req, auth, resource);
  if (!u) throw new AuthError(401, "missing credentials");
  const memberships = await db.select().from(member).where(eq(member.userId, u.userId));
  const wanted = req.headers.get("x-org-id") ?? u.activeOrgId ?? undefined;
  const m = wanted ? memberships.find((x) => x.organizationId === wanted) : memberships.length === 1 ? memberships[0] : undefined;
  if (!m) throw new AuthError(403, wanted ? "not a member of that organization" : memberships.length ? "user belongs to several orgs; send x-org-id or switch_org" : "not a member of any organization");
  const role = parseRole(m.role);
  return { orgId: m.organizationId, actor: { type: "user", id: u.userId, name: u.name }, userId: u.userId, sessionId: u.sessionId, role, scopes: intersect(u.tokenScopes, scopesForRole(role)) };
}

/** Verifies a Better Auth-issued JWT access token locally against the JWKS (no self-fetch). */
async function verifyAccessToken(token: string, auth: Auth, resource: string): Promise<JWTPayload> {
  const jwks = (await auth.api.getJwks()) as { keys: Parameters<typeof createLocalJWKSet>[0]["keys"] };
  const ctx = await auth.$context;
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: ctx.baseURL ? [ctx.baseURL, new URL(ctx.baseURL).origin] : undefined,
      audience: resource,
    });
    return payload;
  } catch (e) {
    throw new AuthError(401, `invalid access token: ${(e as Error).message}`);
  }
}

export async function isMember(db: DB, userId: string, orgId: string) {
  const rows = await db.select().from(member).where(and(eq(member.userId, userId), eq(member.organizationId, orgId)));
  return rows.length > 0;
}
