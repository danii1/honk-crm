# outreach-crm

Agent-first, multi-tenant outreach CRM on Cloudflare Workers. The primary interface is an
**MCP server** (`/mcp`); a thin REST API (`/v1/<tool>`) exposes the same service layer.

## Stack
Workers + Hono · Cloudflare `agents` SDK (`createMcpHandler`) + `@modelcontextprotocol/server` v2 ·
D1 + Drizzle (SQL migrations in `migrations/`) · Better Auth (organization, API key, MCP/OAuth 2.1 + JWT plugins) ·
Vite + `@cloudflare/vite-plugin` · Vitest + `@cloudflare/vitest-plugin` (runs inside workerd) · Oxlint · TypeScript · bun.

## Architecture
```
request ─► Hono (src/index.ts)
            ├─ /api/auth/*            Better Auth (sessions, orgs, API keys, OAuth2.1 AS: /oauth2/*, /jwks)
            ├─ /.well-known/*         OAuth AS + protected-resource metadata
            ├─ /sign-in, /consent     tiny HTML pages for the OAuth hop
            └─ /mcp, /v1/*  ─► resolveOrgContext (src/middleware.ts)
                                 x-api-key / Bearer ocrm_…  → org API key  → {org_id, actor: agent, scopes}
                                 Bearer <JWT>               → OAuth token  → {org_id, actor: user,  scopes}
                               ─► CrmService (src/service.ts)   zod-validated tools, idempotency, activity log
                               ─► Repository (src/repository.ts) the ONLY data access; every query filtered by org_id
                               ─► D1
```
* **Tenancy:** every CRM table has `org_id` (FK → `organization`). `Repository` is constructed with an
  `OrgContext` and stamps/filters `org_id` on every statement; services never touch Drizzle directly.
* **Auth:** API keys are org-owned (`references: "organization"`, prefix `ocrm_`, default permission
  `crm:[read,write]`). OAuth access tokens are JWTs verified locally against the JWKS (issuer + audience =
  `${BETTER_AUTH_URL}/mcp`); org = `x-org-id` header or the user's only membership.
* **Activity log:** `activity_log` is append-only — the repository has no update/delete method and DB
  triggers (`migrations/0001_…`) abort UPDATE/DELETE. Every write records actor, action, entity, payload, `reason`.
* **Idempotency:** every write tool accepts `idempotency_key` (REST also accepts the `Idempotency-Key` header).
  Stored in `idempotency_keys (org_id, key)` with a hash of op+input; same key+input replays the stored
  response, same key + different input → `409 conflict`.
* **Dedupe:** contacts by normalized email, then normalized LinkedIn URL; companies by normalized domain
  (work-email domains auto-create/link a company; free-mail domains don't). Touches by `(channel, external_id)`.

### Tools (MCP and `POST /v1/<tool>`)
`search_contacts, get_contact, upsert_contact, upsert_company, log_touch, update_stage, list_due_followups,
create_task, complete_task, add_note, get_activity, pipeline_summary`. Also `GET /v1/me`.
Pipeline stages: `new → contacted → replied → meeting → won | lost` (log_touch advances new→contacted / →replied automatically).

## Local dev
```bash
bun install
cp .dev.vars.example .dev.vars          # set BETTER_AUTH_SECRET (≥32 random chars)
bun run db:migrate:local                # applies migrations to local D1 (.wrangler/state)
bun run dev                             # http://localhost:5173
```
Create a user + org + org API key (prints the key once):
```bash
bun scripts/bootstrap.ts --email me@example.com --password 'a-long-password' --org "Acme"
curl -s localhost:5173/v1/pipeline_summary -X POST -H "x-api-key: ocrm_…" -d '{}'
```

## Connecting an MCP client
* **Headless agent (API key):** Streamable HTTP at `http://localhost:5173/mcp` with header
  `Authorization: Bearer ocrm_…` (or `x-api-key`). e.g. Claude Code:
  `claude mcp add --transport http crm http://localhost:5173/mcp --header "Authorization: Bearer ocrm_…"`
* **Interactive (OAuth):** point the client at `http://localhost:5173/mcp` with no header. It gets a 401 with
  `WWW-Authenticate: Bearer resource_metadata=…`, discovers the AS, registers via DCR, sends you to `/sign-in`
  then `/consent`, and receives a JWT scoped to `crm:read crm:write`. Multi-org users must send `x-org-id`.

## Checks
```bash
bun run typecheck && bun run lint && bun run test
```
Tests run in workerd with migrations applied: tenant isolation, scopes, dedupe, idempotency (replay,
conflict, per-org), activity log (coverage, no rows on replay, DB-level immutability), and HTTP
(API key → REST/MCP, 401 challenge, OAuth metadata).

## Schema changes
Edit `src/db/schema.ts` → `bun run db:generate` → `bun run db:migrate:local`. Better Auth tables live in
`src/db/auth-schema.ts`, regenerate with `bunx auth@latest generate --config auth.cli.ts --output src/db/auth-schema.ts --yes`.

## Deploy (later — not done)
```bash
bunx wrangler login
bunx wrangler d1 create outreach-crm                 # paste database_id into wrangler.jsonc
# set vars.BETTER_AUTH_URL in wrangler.jsonc to the public URL (e.g. https://crm.example.com)
bunx wrangler secret put BETTER_AUTH_SECRET
bunx wrangler d1 migrations apply DB --remote
bun run deploy
```
