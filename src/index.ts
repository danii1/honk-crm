import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { createAuth, type Auth } from "./auth";
import { CrmError, type OrgContext } from "./context";
import type { Env } from "./env";
import { handleMcp } from "./mcp";
import { AuthError, resolveOrgContext } from "./middleware";
import { consentPage, homePage, signInPage } from "./pages";
import { createDb, type DB } from "./repository";
import { CrmService, TOOL_NAMES } from "./service";

type Vars = { auth: Auth; db: DB; org: OrgContext };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const mcpResource = (env: Env) => `${env.BETTER_AUTH_URL}/mcp`;

app.use("*", async (c, next) => {
  c.set("db", createDb(c.env.DB));
  c.set("auth", createAuth(c.env));
  await next();
});

app.onError((err, c) => {
  if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
  if (err instanceof CrmError) {
    const status = { not_found: 404, conflict: 409, forbidden: 403, invalid: 400 }[err.code] as 404 | 409 | 403 | 400;
    return c.json({ error: err.code, message: err.message }, status);
  }
  if (err?.name === "ZodError") return c.json({ error: "invalid", issues: (err as unknown as { issues: unknown }).issues }, 400);
  console.error(err);
  return c.json({ error: "internal" }, 500);
});

// ---- Better Auth (sessions, organizations, API keys, OAuth 2.1 provider for MCP)
app.on(["GET", "POST"], "/api/auth/*", (c) => c.get("auth").handler(c.req.raw));
app.get("/.well-known/oauth-authorization-server*", (c) => oauthProviderAuthServerMetadata(c.get("auth"))(c.req.raw));
app.get("/.well-known/openid-configuration*", (c) => oauthProviderOpenIdConfigMetadata(c.get("auth"))(c.req.raw));
app.get("/.well-known/oauth-protected-resource*", (c) =>
  c.json({
    resource: mcpResource(c.env),
    authorization_servers: [`${c.env.BETTER_AUTH_URL}/api/auth`],
    scopes_supported: ["crm:read", "crm:write"],
    bearer_methods_supported: ["header"],
  }),
);

// ---- minimal pages for the OAuth login/consent hop + a read-only home
app.get("/", (c) => c.html(homePage()));
app.get("/sign-in", (c) => c.html(signInPage()));
app.get("/consent", (c) => c.html(consentPage()));

// ---- authenticated surfaces: one middleware resolves {org_id, actor, scopes}
const authed = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  try {
    c.set("org", await resolveOrgContext(c.req.raw, c.get("auth"), c.get("db"), mcpResource(c.env)));
  } catch (e) {
    if (e instanceof AuthError && c.req.path === "/mcp") {
      const meta = `${c.env.BETTER_AUTH_URL}/.well-known/oauth-protected-resource`;
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: e.message }, id: null }, e.status, {
        "WWW-Authenticate": `Bearer resource_metadata="${meta}", scope="crm:read crm:write"`,
      });
    }
    throw e;
  }
  await next();
});

app.use("/mcp", authed);
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext, c.get("db"), c.get("org")));

// REST mirror of the MCP tools: POST /v1/<tool> with the same JSON input.
app.use("/v1/*", authed);
app.get("/v1/me", (c) => c.json(c.get("org")));
app.post("/v1/:tool", async (c) => {
  const tool = c.req.param("tool") as (typeof TOOL_NAMES)[number];
  if (!TOOL_NAMES.includes(tool)) return c.json({ error: "unknown tool" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const idemHeader = c.req.header("idempotency-key");
  if (idemHeader && body && typeof body === "object" && !("idempotency_key" in body)) (body as Record<string, unknown>).idempotency_key = idemHeader;
  const svc = new CrmService(c.get("db"), c.get("org"));
  return c.json(await (svc[tool] as (a: unknown) => Promise<unknown>).call(svc, body));
});

export default app;
