import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeOrg } from "./helpers";

/** Keep individual D1 batches modest so the test fixture itself cannot exhaust the workerd database. */
const batchInChunks = async (statements: D1PreparedStatement[], size = 40) => {
  for (let n = 0; n < statements.length; n += size) await env.DB.batch(statements.slice(n, n + size));
};

describe("contact list pagination", () => {
  it("paginates past the 500-row UI page instead of hiding the oldest rows", async () => {
    const { id, svc } = await makeOrg();
    const rows = Array.from({ length: 620 }, (_, i) => ({ id: crypto.randomUUID(), name: `Lead ${i}` }));
    await batchInChunks(
      rows.map((r) => env.DB.prepare("insert into contacts (id, org_id, name, stage, updated_at) values (?, ?, ?, 'new', 1700000000000)").bind(r.id, id, r.name)),
    );
    // Bulk imports share a timestamp; pagination must still have a deterministic tiebreaker.
    const first = await svc.list_contacts_view({ lifecycle: "lead", limit: 500, offset: 0 });
    const second = await svc.list_contacts_view({ lifecycle: "lead", limit: 500, offset: 500 });
    expect([first.contacts.length, first.total, second.contacts.length, second.total]).toEqual([500, 620, 120, 620]);
    const sortedIds = rows.map((r) => r.id).toSorted();
    expect(first.contacts.map((c) => c.id)).toEqual(sortedIds.slice(0, 500));
    expect([...first.contacts, ...second.contacts].map((c) => c.id)).toEqual(sortedIds);
    expect(new Set([...first.contacts, ...second.contacts].map((c) => c.id)).size).toBe(620);
  });
});
