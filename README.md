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
Every write tool accepts `idempotency_key` (MCP) or an `Idempotency-Key` header (REST). Reusing a key with
different input returns `conflict`. The CRM **never sends anything**; it records what you sent.

| Area | Tools |
|---|---|
| Contacts and companies | `search_contacts`, `get_contact`, `upsert_contact`, `upsert_company`, `find_existing`, `list_contacts`, `add_note`, `get_activity` |
| Channel state and reminders | `set_channel_state`, `log_touch`, `update_stage`, `due_followups`, `stale_no_response`, `linkedin_needs_first_message`, `list_due_followups`, `create_task`, `complete_task` |
| Competitors | `is_competitor`, `add_competitor`, `remove_competitor`, `list_competitors` |
| Drafts and campaigns | `create_draft`, `transition_draft`, `list_drafts`, `upsert_campaign`, `list_campaigns` |
| Pacing and reporting | `x_pacing_today`, `outreach_report`, `pipeline_summary` |
| CSV | `import_leads_csv` (dry run by default), `export_csv` |

Also `GET /v1/me`.

**Identities:** email, x_handle, linkedin_url, reddit_user and github are normalized (lowercase, URL and `@`/`u/`
prefixes stripped) and unique per org. Company domain is unique per org.
**Stages** (overall and per channel x/linkedin/reddit/email): `new, qualified, drafted, contacted,
connection_pending, connected, responded, call_booked, pilot, paying, lost, do_not_contact`. Automatic moves are
forward only; `do_not_contact` is sticky. The overall stage is the furthest channel stage. Explicit
`set_channel_state` / `update_stage` set exactly. **Drafts:** `drafted → approved → sent`, and either one can go to
`discarded` or back to `drafted` (to edit). Marking `sent` logs the touch, sets the channel to `contacted` and an optional
follow-up. **Reminders** are the per-channel `next_followup_at`, read through `due_followups` (tz defaults to Asia/Saigon).
**X pacing:** at least 60 minutes between sends and at most 8 per local day (`x_pacing_today`). **Goal:** 3 paying or 10 pilots by 2026-12-15 (`outreach_report`).
Migration 0002 maps v1 stages: replied→responded, meeting→call_booked, won→paying.

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

### Sales Outbound setup (after deploy)
1. Create the org and an API key once: `bun scripts/bootstrap.ts --url https://<crm-host> --email … --password … --org "Sales"`.
   Keep the printed `ocrm_…` key in the agent's secret store.
2. MCP config (Streamable HTTP):
   ```json
   { "mcpServers": { "crm": { "type": "http", "url": "https://<crm-host>/mcp",
     "headers": { "Authorization": "Bearer ocrm_…" } } } }
   ```
   or `claude mcp add --transport http crm https://<crm-host>/mcp --header "Authorization: Bearer ocrm_…"`.
3. Seed the competitor blocklist with `add_competitor` for each name, handle and domain.
4. Import the existing sheet. Export it as CSV with the columns `handle,name,profile_url,bio_summary,followers,company,role,
   est_team_size,signal_post_url,signal_post_date,signal_summary,score,source,status,first_seen,notes`, then:
   ```bash
   CRM_URL=https://<crm-host> CRM_API_KEY=ocrm_… bun scripts/import-leads.ts leads.csv           # dry-run report
   CRM_URL=https://<crm-host> CRM_API_KEY=ocrm_… bun scripts/import-leads.ts leads.csv --commit  # write
   ```
   You can also call `import_leads_csv` over MCP with `{csv, dry_run:true}`, then `dry_run:false`. Re-runs are
   idempotent: existing contacts are matched on any identity, stages never go backwards, and identities and notes
   only fill blanks. Unknown `status` values become `new` and are listed in the report.

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
