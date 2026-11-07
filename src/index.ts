import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { createAuth, type Auth } from "./auth";
import { CrmError, type OrgContext } from "./context";
import type { Env } from "./env";
import { handleMcp } from "./mcp";
import { AuthError, resolveOrgContext, resolveUser } from "./middleware";
import { acceptInvitePage, consentPage, signInPage } from "./pages";
import { createDb, Repository, type DB } from "./repository";
import { acceptInvite, switchOrg } from "./team";
import { callTool, TOOL_INDEX } from "./tools";

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
    const status = { not_found: 404, conflict: 409, forbidden: 403, invalid: 400, blocked: 422 }[err.code] as 404 | 409 | 403 | 400 | 422;
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

// ---- minimal pages for the OAuth login/consent hop
app.get("/", (c) => c.redirect("/dashboard"));
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
const teamDeps = (c: { env: Env; get: (k: "auth") => Auth }) => ({ auth: c.get("auth"), d1: c.env.DB, baseUrl: c.env.BETTER_AUTH_URL });
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext, c.get("db"), c.get("org"), teamDeps(c)));

// ---- Invitations: accept link + accept endpoint (needs a signed-in user, not an org yet).
app.get("/accept-invite", (c) => c.html(acceptInvitePage(c.req.query("token") ?? "")));
app.post("/invites/accept", async (c) => {
  const u = await resolveUser(c.req.raw, c.get("auth"), mcpResource(c.env));
  if (!u) return c.json({ error: "sign in first" }, 401);
  const body = await c.req.json().catch(() => ({}));
  const res = await acceptInvite(c.get("db"), c.env.DB, u.userId, body);
  if (u.sessionId) await switchOrg(c.get("db"), u.userId, u.sessionId, { org_id: res.org_id });
  return c.json(res);
});

// REST mirror of the MCP tools: POST /v1/<tool> with the same JSON input.
app.use("/v1/*", authed);
app.get("/v1/me", (c) => c.json(c.get("org")));
app.get("/v1/overview", async (c) => c.json(await callTool("daily_overview", { ...(c.req.query("tz") && { tz: c.req.query("tz") }) }, c.get("db"), c.get("org"), teamDeps(c))));
app.post("/v1/:tool", async (c) => {
  const tool = c.req.param("tool");
  if (!TOOL_INDEX.has(tool)) return c.json({ error: "unknown tool" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const idemHeader = c.req.header("idempotency-key");
  if (idemHeader && body && typeof body === "object" && !("idempotency_key" in body)) (body as Record<string, unknown>).idempotency_key = idemHeader;
  return c.json(await callTool(tool, body, c.get("db"), c.get("org"), teamDeps(c)));
});

// ---- React SPA (shadcn/ui) served after the same Better Auth session check
const SPA_FALLBACK = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Outreach CRM</title></head><body><div id="root"></div><p style="font:14px system-ui;padding:24px">The CRM client is not built. Run <code>bun run build</code> and reload.</p></body></html>`;

const dashAuth = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  try {
    c.set("org", await resolveOrgContext(c.req.raw, c.get("auth"), c.get("db"), mcpResource(c.env)));
  } catch (e) {
    if (e instanceof AuthError && e.status === 401) return c.redirect(`/sign-in?next=${encodeURIComponent(c.req.path)}`);
    if (e instanceof AuthError) return c.html(`<p>${e.message}</p>`, e.status);
    throw e;
  }
  await next();
});

/** Serve the built index.html through the static-assets binding, keeping auth in front of every page. */
export async function serveApp(c: { env: Env; req: { url: string; raw: Request } }) {
  try {
    // Fetch the SPA entrypoint directly: ASSETS redirects /index.html to /, which breaks test doubles and adds a hop.
    const res = await c.env.ASSETS?.fetch(new URL("/", c.req.url));
    if (res?.ok) {
      const headers = new Headers(res.headers);
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("cache-control", "no-store");
      return new Response(res.body, { status: 200, headers });
    }
  } catch {
    // fall through to the diagnostic shell (dev/test without a client build)
  }
  return new Response(SPA_FALLBACK, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

app.use("/dashboard", dashAuth);
app.use("/dashboard/*", dashAuth);

// Keep server-side 404s for detail pages; the SPA handles the rest of the routing.
for (const base of ["contacts", "leads"] as const) {
  app.get(`/dashboard/${base}/:id`, async (c) => {
    const contact = await new Repository(c.get("db"), c.get("org")).contactById(c.req.param("id"));
    if (!contact) return c.html("<p>Contact not found. <a href='/dashboard/contacts'>Back</a></p>", 404);
    return serveApp(c);
  });
}
app.get("/dashboard", serveApp);
app.get("/dashboard/*", serveApp);

export default app;
