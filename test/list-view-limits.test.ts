import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeOrg } from "./helpers";

const stageAt = (i: number) => (i % 4 === 0 ? "paying" : i % 4 === 1 ? "lost" : "new");
/** Keep individual D1 batches modest so the test fixture itself cannot exhaust the workerd database. */
const batchInChunks = async (statements: D1PreparedStatement[], size = 40) => {
  for (let n = 0; n < statements.length; n += size) await env.DB.batch(statements.slice(n, n + size));
};

/** D1 rejects statements with more than 100 bound parameters; list pages must chunk their IN lists. */
describe("list views past D1 parameter limits", () => {
  it("lists 150 contacts/companies and aggregates company counts in SQL", async () => {
    const { id, svc } = await makeOrg();
    const companies = Array.from({ length: 150 }, (_, i) => ({
      id: crypto.randomUUID(),
      name: `Co ${String(i).padStart(3, "0")}`,
      domain: `co${i}.example`,
    }));
    await batchInChunks(
      companies.map((c) => env.DB.prepare("insert into companies (id, org_id, name, domain) values (?, ?, ?, ?)").bind(c.id, id, c.name, c.domain)),
    );

    const contacts = companies.map((company, i) => ({
      id: crypto.randomUUID(),
      name: `Person ${i}`,
      email: `p${i}@${company.domain}`,
      companyId: company.id,
      stage: stageAt(i),
    }));
    await batchInChunks(
      contacts.map((c) => env.DB.prepare("insert into contacts (id, org_id, name, email, company_id, stage) values (?, ?, ?, ?, ?, ?)").bind(c.id, id, c.name, c.email, c.companyId, c.stage)),
    );

    const touchAt = new Date("2026-11-01T00:00:00Z");
    for (const i of [90, 120]) {
      await env.DB.prepare("insert into channel_states (id, org_id, contact_id, channel, stage, last_touch_at) values (?, ?, ?, 'x', 'contacted', ?)").bind(crypto.randomUUID(), id, contacts[i]!.id, touchAt.getTime()).run();
    }

    const view = await svc.list_contacts_view({ limit: 1000 });
    expect(view.contacts).toHaveLength(150);
    expect(view.total).toBe(150);
    expect(view.contacts.every((c) => c.company !== null)).toBe(true);
    expect(view.contacts.find((c) => c.id === contacts[90]!.id)?.lastTouchAt?.getTime()).toBe(touchAt.getTime());
    expect(view.contacts.find((c) => c.id === contacts[120]!.id)?.lastTouchAt?.getTime()).toBe(touchAt.getTime());
    expect(view.counts).toMatchObject({ lead: 74, contact: 38, archived: 38, total: 150 });

    // Pagination: total is filter-scoped and pages do not overlap.
    const page1 = await svc.list_contacts_view({ limit: 100, offset: 0 });
    const page2 = await svc.list_contacts_view({ limit: 100, offset: 100 });
    expect([page1.contacts.length, page2.contacts.length, page1.total]).toEqual([100, 50, 150]);
    expect(new Set([...page1.contacts, ...page2.contacts].map((c) => c.id)).size).toBe(150);
    const leads = await svc.list_contacts_view({ lifecycle: "lead", limit: 10 });
    expect([leads.total, leads.contacts.length]).toEqual([74, 10]);

    // The list payload only carries columns the dashboard renders.
    expect(page1.contacts[0]).not.toHaveProperty("notesText");
    expect(page1.contacts[0]).toHaveProperty("identities");

    // List views intersect lifecycle and stage; list_contacts keeps its documented stage-wins behavior.
    expect((await svc.list_contacts_view({ lifecycle: "archived", stage: "responded", limit: 1000 })).contacts).toHaveLength(0);
    expect((await svc.list_contacts_view({ lifecycle: "archived", stage: "lost", limit: 1000 })).contacts).toHaveLength(38);
    expect(await svc.list_contacts({ lifecycle: "archived", stage: "paying", limit: 500 })).toHaveLength(38);

    const page = await svc.list_companies({ limit: 10 });
    expect(page.total).toBe(150);
    expect(page.companies).toHaveLength(10);
    expect(page.companies.every((c) => c.contacts === 1)).toBe(true);
    expect(page.companies[0]).toMatchObject({ contacts: 1, leads: 0, relationships: 1 });
    expect(page.companies[1]).toMatchObject({ contacts: 1, leads: 0, relationships: 0 });

    const all = await svc.list_companies({ limit: 500 });
    expect(all.companies).toHaveLength(150);
    expect(all.companies.reduce((n, c) => n + (c.contacts ?? 0), 0)).toBe(150);
    expect(all.companies.reduce((n, c) => n + (c.leads ?? 0), 0)).toBe(74);
    expect(all.companies.reduce((n, c) => n + (c.relationships ?? 0), 0)).toBe(38);

    // Companies paginate with offset instead of silently truncating at the page size.
    const coPage1 = await svc.list_companies({ limit: 100, offset: 0 });
    const coPage2 = await svc.list_companies({ limit: 100, offset: 100 });
    expect([coPage1.companies.length, coPage2.companies.length, coPage1.total, coPage2.total]).toEqual([100, 50, 150, 150]);
    expect(new Set([...coPage1.companies, ...coPage2.companies].map((c) => c.id)).size).toBe(150);
  });
});
