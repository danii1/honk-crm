import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { CrmError, type OrgContext } from "./context";
import type { DB } from "./repository";
import type { TeamDeps, teamSchemas } from "./team";

type AnySchema = (typeof teamSchemas)["accept_invite"];
import { callTool, TOOLS } from "./tools";

/** One fresh MCP server per request, bound to that request's org context. */
export function createCrmMcpServer(db: DB, ctx: OrgContext, deps: TeamDeps) {
  const server = new McpServer({ name: "outreach-crm", version: "0.2.0" });
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.schema as AnySchema,
        annotations: { readOnlyHint: !t.write, idempotentHint: true, destructiveHint: t.name === "delete_org" || undefined },
      },
      async (args: unknown) => {
        try {
          const result = await callTool(t.name, args, db, ctx, deps);
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

export function handleMcp(req: Request, env: unknown, exec: ExecutionContext, db: DB, ctx: OrgContext, deps: TeamDeps) {
  return createMcpHandler(() => createCrmMcpServer(db, ctx, deps), { route: "/mcp" })(req, env, exec);
}
