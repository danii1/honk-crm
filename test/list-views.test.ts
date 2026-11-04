import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeOrg } from "./helpers";

describe("contact list views", () => {
  it("scopes lifecycle counts to the same filters as the rows", async () => {
    const { svc } = await makeOrg();
    await svc.upsert_contact({ name: "Alice Lead", x_handle: "alice_lead" });
    const bob = await svc.upsert_contact({ name: "Bob Relationship", email: "bob@acme.dev" });
    await svc.update_stage({ contact_id: bob.contact.id, stage: "responded" });

    const filtered = await svc.list_contacts_view({ query: "alice", limit: 100 });
    expect(filtered.total).toBe(1);
    expect(filtered.contacts.map((c) => c.name)).toEqual(["Alice Lead"]);
    expect(filtered.counts).toMatchObject({ lead: 1, contact: 0, archived: 0, total: 1, stages: { new: 1 } });

    // The lifecycle filter itself is excluded so a tab can show the other lifecycle's total.
    const relationships = await svc.list_contacts_view({ lifecycle: "contact", limit: 100 });
    expect(relationships.total).toBe(1);
    expect(relationships.counts).toMatchObject({ lead: 1, contact: 1, archived: 0, total: 2 });
    expect(relationships.counts.stages).toMatchObject({ new: 1, responded: 1 });
  });

  it("keeps every lifecycle total when a stage filter is active", async () => {
    const { svc } = await makeOrg();
    await svc.upsert_contact({ name: "Alice Lead", x_handle: "alice_stage" });
    const bob = await svc.upsert_contact({ name: "Bob Relationship", email: "bob-stage@acme.dev" });
    await svc.update_stage({ contact_id: bob.contact.id, stage: "responded" });
    const lost = await svc.upsert_contact({ name: "Carol Lost", x_handle: "carol_lost" });
    await svc.update_stage({ contact_id: lost.contact.id, stage: "lost" });

    const filtered = await svc.list_contacts_view({ lifecycle: "contact", stage: "responded", limit: 100 });
    expect(filtered.total).toBe(1);
    expect(filtered.contacts.map((c) => c.name)).toEqual(["Bob Relationship"]);
    // Stage and lifecycle are excluded from the tab counts; the archived tab must still show its total.
    expect(filtered.counts).toMatchObject({ lead: 1, contact: 1, archived: 1, total: 3 });
    expect(filtered.counts.stages).toMatchObject({ new: 1, responded: 1, lost: 1 });
  });

  it("filters by channel_stage when a channel is selected", async () => {
    const { id, svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ x_handle: "stage_probe", name: "Stage Probe" });
    await svc.update_stage({ contact_id: contact.id, stage: "responded" });
    await env.DB
      .prepare("insert into channel_states (id, org_id, contact_id, channel, stage) values (?, ?, ?, 'x', 'new')")
      .bind(crypto.randomUUID(), id, contact.id)
      .run();

    // Overall stage "new" is not this contact's overall stage; the channel stage is.
    expect((await svc.list_contacts_view({ channel: "x", stage: "new", limit: 100 })).contacts).toEqual([]);
    const byChannelStage = await svc.list_contacts_view({ channel: "x", channel_stage: "new", limit: 100 });
    expect(byChannelStage.contacts.map((c) => c.id)).toEqual([contact.id]);
  });

  it("daily_overview carries the lifecycle for linked rows", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ x_handle: "paying_row" });
    await svc.update_stage({ contact_id: contact.id, stage: "paying" });
    await svc.create_draft({ contact_id: contact.id, channel: "x", text: "hello" });
    await svc.record_event({ type: "reply_received", channel: "x", external_id: "reply-1", contact_id: contact.id });

    const overview = await svc.daily_overview({});
    expect(overview.drafts_pending.find((d) => d.contact_id === contact.id)?.lifecycle).toBe("contact");
    expect(overview.new_replies.find((e) => e.contactId === contact.id)?.lifecycle).toBe("contact");
  });
});
