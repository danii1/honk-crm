import { and, eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { API_KEY_PREFIX, type Auth } from "./auth";
import { member } from "./db/schema";
import { SCOPES, type OrgContext } from "./context";
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

/**
 * The single place that turns a request into an OrgContext.
 *  - `x-api-key: ocrm_...` or `Authorization: Bearer ocrm_...` -> org-owned Better Auth API key (actor = agent)
 *  - `Authorization: Bearer <jwt>` -> OAuth access token from the Better Auth MCP provider (actor = user);
 *    org = `x-org-id` header, else the user's only membership.
 */
export async function resolveOrgContext(req: Request, auth: Auth, db: DB, resource: string): Promise<OrgContext> {
  const token = req.headers.get("x-api-key") ?? bearer(req);
  if (!token) throw new AuthError(401, "missing credentials");

  if (token.startsWith(API_KEY_PREFIX)) {
    const res = await auth.api.verifyApiKey({ body: { key: token } });
    if (!res.valid || !res.key) throw new AuthError(401, "invalid api key");
    return {
      orgId: res.key.referenceId,
      actor: { type: "agent", id: `apikey:${res.key.id}`, name: res.key.name ?? undefined },
      scopes: scopesFromPermissions(res.key.permissions),
    };
  }

  const claims = await verifyAccessToken(token, auth, resource);
  const userId = claims.sub;
  if (!userId) throw new AuthError(401, "token has no subject");
  const tokenScopes = String(claims.scope ?? "").split(/\s+/).filter((s) => CRM_SCOPES.has(s));
  const memberships = await db.select().from(member).where(eq(member.userId, userId));
  const wanted = req.headers.get("x-org-id");
  const m = wanted ? memberships.find((x) => x.organizationId === wanted) : memberships.length === 1 ? memberships[0] : undefined;
  if (!m) throw new AuthError(403, wanted ? "not a member of that organization" : "user belongs to several orgs; send x-org-id");
  return { orgId: m.organizationId, actor: { type: "user", id: userId }, scopes: tokenScopes };
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
