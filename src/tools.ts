import type { ZodType } from "zod";
import { requireRole, requireScope, type OrgContext } from "./context";
import type { DB } from "./repository";
import type { Role } from "./roles";
import { ADMIN_CRM_TOOLS, CrmService, schemas, TOOL_DESCRIPTIONS, TOOL_NAMES, WRITE_TOOLS } from "./service";
import { TEAM_TOOL_DESCRIPTIONS, TEAM_TOOL_NAMES, TEAM_TOOL_ROLE, TEAM_WRITE_TOOLS, TeamService, teamSchemas, type TeamDeps, type TeamTool } from "./team";

/** One registry for REST (/v1/:tool) and MCP: CRM tools + team/org admin tools, with a central role guard. */
export interface ToolDef {
  name: string;
  schema: ZodType;
  description: string;
  write: boolean;
  minRole: Role;
  kind: "crm" | "team";
}

const crmDefs: ToolDef[] = TOOL_NAMES.map((name) => ({
  name,
  schema: schemas[name],
  description: TOOL_DESCRIPTIONS[name],
  write: WRITE_TOOLS.has(name),
  minRole: ADMIN_CRM_TOOLS.has(name) ? "admin" : WRITE_TOOLS.has(name) ? "member" : "viewer",
  kind: "crm",
}));
const teamDefs: ToolDef[] = TEAM_TOOL_NAMES.map((name) => ({
  name,
  schema: teamSchemas[name],
  description: TEAM_TOOL_DESCRIPTIONS[name],
  write: TEAM_WRITE_TOOLS.has(name),
  minRole: TEAM_TOOL_ROLE[name],
  kind: "team",
}));
export const TOOLS: ToolDef[] = [...crmDefs, ...teamDefs];
export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));
/** Tools a user-actor may call regardless of org role (they act on the user, not the org). */
const USER_TOOLS = new Set(["accept_invite", "list_my_orgs", "switch_org"]);

export async function callTool(name: string, args: unknown, db: DB, ctx: OrgContext, deps: TeamDeps): Promise<unknown> {
  const def = TOOL_INDEX.get(name);
  if (!def) throw new Error(`unknown tool ${name}`);
  if (!USER_TOOLS.has(name)) {
    requireScope(ctx, def.write ? "crm:write" : "crm:read");
    requireRole(ctx, def.minRole);
  }
  if (def.kind === "crm") {
    const svc = new CrmService(db, ctx);
    return (svc[name as keyof CrmService] as (a: unknown) => Promise<unknown>).call(svc, args);
  }
  const team = new TeamService(db, ctx, deps);
  return (team[name as TeamTool] as (a: unknown) => Promise<unknown>).call(team, args ?? {});
}
