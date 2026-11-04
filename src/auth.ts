import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, organization } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { mcp } from "@better-auth/mcp";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";

export const API_KEY_PREFIX = "ocrm_";

export interface AuthEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
}

export function authOptions(baseURL: string) {
  return {
    baseURL,
    emailAndPassword: { enabled: true },
    plugins: [
      organization(),
      // Org-owned keys for headless agents. referenceId = organization id.
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
    ...authOptions(env.BETTER_AUTH_URL),
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: "sqlite", schema }),
  });
}

export type Auth = ReturnType<typeof createAuth>;
