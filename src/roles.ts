import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";

/** Org roles, lowest to highest. Viewer is read-only. */
export const ROLES = ["viewer", "member", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const roleRank = (r: Role) => ROLES.indexOf(r);
export const atLeast = (r: Role, min: Role) => roleRank(r) >= roleRank(min);
export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);

/** Better Auth stores roles as a string, possibly comma-separated; take the highest known one. Unknown => viewer. */
export function parseRole(raw: unknown): Role {
  const parts = String(raw ?? "").split(",").map((s) => s.trim()).filter(isRole);
  return parts.reduce<Role>((best, r) => (roleRank(r) > roleRank(best) ? r : best), "viewer");
}

/** CRM scopes a role may hold. Effective scopes = token/key scopes ∩ these. */
export function scopesForRole(r: Role): string[] {
  return r === "viewer" ? ["crm:read"] : ["crm:read", "crm:write"];
}

// ---- Better Auth access control, so its own /api/auth/organization/* and api-key routes follow the same roles.
const statements = {
  ...defaultStatements,
  apiKey: ["create", "read", "update", "delete"],
  crm: ["read", "write"],
} as const;
export const ac = createAccessControl(statements);
export const baRoles = {
  owner: ac.newRole({ organization: ["update", "delete"], member: ["create", "update", "delete"], invitation: ["create", "cancel"], team: ["create", "update", "delete"], ac: ["create", "read", "update", "delete"], apiKey: ["create", "read", "update", "delete"], crm: ["read", "write"] }),
  admin: ac.newRole({ organization: ["update"], member: ["create", "update", "delete"], invitation: ["create", "cancel"], team: ["create", "update", "delete"], ac: ["create", "read", "update", "delete"], apiKey: ["create", "read", "update", "delete"], crm: ["read", "write"] }),
  member: ac.newRole({ crm: ["read", "write"] }),
  viewer: ac.newRole({ crm: ["read"] }),
};
