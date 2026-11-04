import { describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import { createAuth } from "../src/auth";

async function setupOrgKey(tag: string) {
  const auth = createAuth(env);
  const { user } = await auth.api.signUpEmail({ body: { email: `${tag}-${crypto.randomUUID()}@test.dev`, password: "correct-horse-battery", name: tag } });
  const org = await auth.api.createOrganization({ body: { name: tag, slug: `${tag}-${crypto.randomUUID()}`, userId: user.id } });
  const key = await auth.api.createApiKey({ body: { name: `${tag}-agent`, organizationId: org!.id, userId: user.id } });
  return { orgId: org!.id, key: key.key };
}

const rest = (key: string, tool: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`http://localhost/v1/${tool}`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const mcp = (key: string, method: string, params: unknown, id = 1) =>
  SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers: { host: "localhost", authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

async function rpcResult(res: Response) {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json);
}

describe("HTTP surfaces", () => {
  it("rejects unauthenticated MCP with a resource_metadata challenge", async () => {
    const res = await mcp("nope", "tools/list", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
  });

  it("serves OAuth metadata", async () => {
    const pr = await SELF.fetch("http://localhost/.well-known/oauth-protected-resource");
    expect((await pr.json<{ resource: string }>()).resource).toBe("http://localhost/mcp");
    const as = await SELF.fetch("http://localhost/.well-known/oauth-authorization-server/api/auth");
    expect(as.status).toBe(200);
    expect(await as.json()).toHaveProperty("token_endpoint");
  });

  it("org API key -> REST, scoped to its org, with Idempotency-Key header", async () => {
    const a = await setupOrgKey("alpha");
    const b = await setupOrgKey("beta");
    const me = await SELF.fetch("http://localhost/v1/me", { headers: { "x-api-key": a.key } });
    expect(await me.json()).toMatchObject({ orgId: a.orgId, actor: { type: "agent" }, scopes: ["crm:read", "crm:write"] });

    const r1 = await rest(a.key, "upsert_contact", { email: "x@corp.io" }, { "idempotency-key": "http-key-1" });
    const r2 = await rest(a.key, "upsert_contact", { email: "x@corp.io" }, { "idempotency-key": "http-key-1" });
    const c1 = await r1.json<{ contact: { id: string } }>();
    expect((await r2.json<{ contact: { id: string } }>()).contact.id).toBe(c1.contact.id);

    const cross = await rest(b.key, "get_contact", { id: c1.contact.id });
    expect(cross.status).toBe(404);
    expect((await rest(a.key, "nope", {})).status).toBe(404);
    expect((await rest(a.key, "upsert_company", {})).status).toBe(400);
  });

  it("org API key -> MCP tools/list and tools/call", async () => {
    const a = await setupOrgKey("gamma");
    const init = await mcp(a.key, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.status).toBe(200);
    const list = await rpcResult(await mcp(a.key, "tools/list", {}, 2));
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("log_touch");
    const call = await rpcResult(await mcp(a.key, "tools/call", { name: "upsert_contact", arguments: { email: "m@cp.dev" } }, 3));
    expect(call.result.isError).toBeFalsy();
    const sum = await rpcResult(await mcp(a.key, "tools/call", { name: "pipeline_summary", arguments: {} }, 4));
    expect(JSON.parse(sum.result.content[0].text).total).toBe(1);
  });
});
