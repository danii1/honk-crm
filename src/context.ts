export type ActorType = "user" | "agent";
export const SCOPES = ["crm:read", "crm:write"] as const;
export type Scope = (typeof SCOPES)[number];

/** Resolved by the auth middleware for every request. Nothing touches CRM data without one. */
export interface OrgContext {
  orgId: string;
  actor: { type: ActorType; id: string; name?: string };
  scopes: string[];
}

export class CrmError extends Error {
  constructor(
    public code: "not_found" | "conflict" | "forbidden" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

export function requireScope(ctx: OrgContext, scope: Scope) {
  if (!ctx.scopes.includes(scope)) throw new CrmError("forbidden", `missing scope ${scope}`);
}
