import { env } from "cloudflare:test";
import { organization } from "../src/db/schema";
import type { Role } from "../src/roles";
import type { OrgContext } from "../src/context";
import { createDb } from "../src/repository";
import { CrmService } from "../src/service";

export const db = createDb(env.DB);

export async function makeOrg(scopes = ["crm:read", "crm:write"], role: Role = "admin") {
  const id = crypto.randomUUID();
  await db.insert(organization).values({ id, name: `Org ${id}`, slug: `org-${id}`, createdAt: new Date() });
  const ctx: OrgContext = { orgId: id, actor: { type: "agent", id: "test-agent" }, scopes, role };
  return { id, ctx, svc: new CrmService(db, ctx) };
}
