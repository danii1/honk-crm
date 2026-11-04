import { atLeast, type Role } from "./roles";

export type ActorType = "user" | "agent";
export const SCOPES = ["crm:read", "crm:write"] as const;
export type Scope = (typeof SCOPES)[number];

/** Resolved by the auth middleware for every request. Nothing touches CRM data without one. */
export interface OrgContext {
  orgId: string;
  actor: { type: ActorType; id: string; name?: string };
  scopes: string[];
  /** Role in this org: the member's role for users, the key's role for API keys. */
  role: Role;
  /** Set when the caller is a user (session or OAuth token). */
  userId?: string;
  /** Better Auth session id, when authenticated by session cookie (lets switch_org persist). */
  sessionId?: string;
}

export class CrmError extends Error {
  constructor(
    public code: "not_found" | "conflict" | "forbidden" | "invalid" | "blocked",
    message: string,
  ) {
    super(message);
  }
}

export function requireScope(ctx: OrgContext, scope: Scope) {
  if (!ctx.scopes.includes(scope)) throw new CrmError("forbidden", `missing scope ${scope}`);
}

export function requireRole(ctx: OrgContext, min: Role) {
  if (!atLeast(ctx.role, min)) throw new CrmError("forbidden", `requires role ${min} (you are ${ctx.role})`);
}
