import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { mcp } from "@better-auth/mcp";
import { and, count, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { acceptUrl, deliverInvite } from "./invites";
import { ac, baRoles } from "./roles";

export const API_KEY_PREFIX = "ocrm_";
export const INVITE_TTL_SECONDS = 7 * 24 * 3600;

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  ALLOWED_SIGNUP_EMAILS?: string;
}

/** Whether `email` may create an account. See Env.ALLOWED_SIGNUP_EMAILS. */
export async function signupAllowed(d1: D1Database, email: string, allowlist = ""): Promise<boolean> {
  const e = email.trim().toLowerCase();
  const rules = allowlist.split(",").map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (rules.includes("*")) return true;
  if (rules.some((r) => (r.startsWith("@") ? e.endsWith(r) : e === r))) return true;
  const db = drizzle(d1, { schema });
  const [users] = await db.select({ n: count() }).from(schema.user);
  if ((users?.n ?? 0) === 0) return true; // first owner
  const [inv] = await db.select({ n: count() }).from(schema.invitation).where(and(eq(schema.invitation.email, e), eq(schema.invitation.status, "pending"), gt(schema.invitation.expiresAt, new Date())));
  return (inv?.n ?? 0) > 0;
}

/** Seats = human members. Throws if adding one more would exceed the org's seat_limit (null = unlimited). */
export async function assertSeatAvailable(d1: D1Database, orgId: string) {
  const db = drizzle(d1, { schema });
  const [org] = await db.select({ seatLimit: schema.organization.seatLimit }).from(schema.organization).where(eq(schema.organization.id, orgId));
  if (org?.seatLimit === null || org?.seatLimit === undefined) return;
  const [row] = await db.select({ n: count() }).from(schema.member).where(eq(schema.member.organizationId, orgId));
  const n = row?.n ?? 0;
  if (n >= org.seatLimit) throw new SeatLimitError(n, org.seatLimit);
}
export class SeatLimitError extends Error {
  constructor(
    public used: number,
    public limit: number,
  ) {
    super(`seat limit reached (${used}/${limit})`);
  }
}

export function authOptions(baseURL: string, d1?: D1Database) {
  return {
    baseURL,
    emailAndPassword: { enabled: true },
    plugins: [
      organization({
        ac,
        roles: baRoles,
        creatorRole: "owner",
        invitationExpiresIn: INVITE_TTL_SECONDS,
        cancelPendingInvitationsOnReInvite: true,
        schema: { organization: { additionalFields: { seatLimit: { type: "number", required: false, input: false } } } },
        // Better Auth's own invite route goes through the same pluggable sender.
        sendInvitationEmail: async (data) => {
          await deliverInvite({
            invitationId: data.id,
            email: data.email,
            role: data.role,
            organization: { id: data.organization.id, name: data.organization.name },
            inviter: { id: data.inviter.user.id, name: data.inviter.user.name, email: data.inviter.user.email },
            acceptUrl: acceptUrl(baseURL, data.id),
            expiresAt: data.invitation.expiresAt,
          });
        },
        organizationHooks: {
          // Covers every path that adds a member (invite accept, addMember), including Better Auth's routes.
          beforeAddMember: async ({ organization: org }) => {
            if (!d1) return;
            try {
              await assertSeatAvailable(d1, org.id);
            } catch (e) {
              if (e instanceof SeatLimitError) throw new APIError("FORBIDDEN", { message: e.message });
              throw e;
            }
          },
        },
      }),
      // Org-owned keys for headless agents. referenceId = organization id; metadata.role = key role.
      apiKey({
        references: "organization",
        defaultPrefix: API_KEY_PREFIX,
        enableMetadata: true,
        rateLimit: { enabled: false },
        permissions: { defaultPermissions: { crm: ["read", "write"] } },
      }),
      jwt(),
      // OAuth 2.1 authorization server + protected resource for MCP clients.
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: `${baseURL}/mcp`,
        scopes: ["openid", "profile", "email", "offline_access", "crm:read", "crm:write"],
        // Cursor / older Claude Code still use DCR; CIMD can be added later.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(env: AuthEnv) {
  return betterAuth({
    ...authOptions(env.BETTER_AUTH_URL, env.DB),
    databaseHooks: {
      user: {
        create: {
          before: async (u) => {
            if (!(await signupAllowed(env.DB, u.email, env.ALLOWED_SIGNUP_EMAILS))) throw new APIError("FORBIDDEN", { message: "sign-up is invite-only" });
          },
        },
      },
    },
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: "sqlite", schema }),
  });
}

export type Auth = ReturnType<typeof createAuth>;
