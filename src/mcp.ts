import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { CrmError, type OrgContext } from "./context";
import type { DB } from "./repository";
import { CrmService, schemas, TOOL_DESCRIPTIONS, TOOL_NAMES, WRITE_TOOLS } from "./service";

/** One fresh MCP server per request, bound to that request's org context. */
export function createCrmMcpServer(db: DB, ctx: OrgContext) {
  const svc = new CrmService(db, ctx);
  const server = new McpServer({ name: "outreach-crm", version: "0.1.0" });
  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: schemas[name],
        annotations: { readOnlyHint: !WRITE_TOOLS.has(name), idempotentHint: true },
      },
      async (args: unknown) => {
        try {
          const result = await (svc[name] as (a: unknown) => Promise<unknown>).call(svc, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (e) {
          const msg = e instanceof CrmError ? `${e.code}: ${e.message}` : (e as Error).message;
          return { isError: true, content: [{ type: "text" as const, text: msg }] };
        }
      },
    );
  }
  return server;
}

export function handleMcp(req: Request, env: unknown, exec: ExecutionContext, db: DB, ctx: OrgContext) {
  return createMcpHandler(() => createCrmMcpServer(db, ctx), { route: "/mcp" })(req, env, exec);
}
