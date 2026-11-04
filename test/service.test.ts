import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { makeOrg } from "./helpers";

describe("tenant isolation", () => {
  it("never reads or writes across orgs", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const { contact } = await a.svc.upsert_contact({ email: "ceo@acme.com", name: "Ada" });

    // Same email in org B is a *new* contact, not a dedupe hit.
    const inB = await b.svc.upsert_contact({ email: "ceo@acme.com" });
    expect(inB.created).toBe(true);
    expect(inB.contact.id).not.toBe(contact.id);

    await expect(b.svc.get_contact({ id: contact.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(b.svc.log_touch({ contact_id: contact.id, channel: "email" })).rejects.toMatchObject({ code: "not_found" });
    await expect(b.svc.update_stage({ contact_id: contact.id, stage: "paying" })).rejects.toMatchObject({ code: "not_found" });
    await expect(b.svc.add_note({ entity_id: contact.id, body: "x" })).rejects.toMatchObject({ code: "not_found" });

    expect((await b.svc.search_contacts({ query: "acme" })).map((c) => c.id)).toEqual([inB.contact.id]);
    expect((await a.svc.get_contact({ id: contact.id })).stage).toBe("new");
    expect((await b.svc.get_activity({})).every((r) => r.orgId === b.id)).toBe(true);
    expect((await a.svc.pipeline_summary()).total).toBe(1);
  });

  it("enforces scopes", async () => {
    const ro = await makeOrg(["crm:read"]);
    await expect(ro.svc.upsert_company({ domain: "x.com" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(ro.svc.search_contacts({})).resolves.toEqual([]);
  });

  it("D1 rows are stamped with org_id", async () => {
    const a = await makeOrg();
    await a.svc.upsert_contact({ email: "z@zeta.io" });
    const r = await env.DB.prepare("select count(*) n from contacts where org_id is null").first<{ n: number }>();
    expect(r?.n).toBe(0);
  });
});

describe("dedupe", () => {
  it("contacts by normalized email, companies by domain", async () => {
    const { svc } = await makeOrg();
    const first = await svc.upsert_contact({ email: "Jane.Doe@Stripe.com", name: "Jane" });
    const again = await svc.upsert_contact({ email: "  jane.doe@stripe.com ", title: "CTO" });
    expect(again.deduped).toBe(true);
    expect(again.contact.id).toBe(first.contact.id);
    expect(again.contact.name).toBe("Jane");
    expect(again.contact.role).toBe("CTO");

    const co = await svc.upsert_company({ domain: "https://www.stripe.com/about" });
    expect(co.company.id).toBe(first.contact.companyId);

    // free-mail does not create a company
    const g = await svc.upsert_contact({ email: "someone@gmail.com" });
    expect(g.contact.companyId).toBeNull();
  });

  it("falls back to LinkedIn URL", async () => {
    const { svc } = await makeOrg();
    const a = await svc.upsert_contact({ linkedin: "https://www.linkedin.com/in/jdoe/", name: "J" });
    const b = await svc.upsert_contact({ linkedin: "linkedin.com/in/jdoe", email: "j@doe.dev" });
    expect(b.contact.id).toBe(a.contact.id);
    expect(b.contact.email).toBe("j@doe.dev");
  });

  it("touches by channel + external_id", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ email: "a@b.co" });
    const t1 = await svc.log_touch({ contact_id: contact.id, channel: "email", external_id: "<m1@x>" });
    const t2 = await svc.log_touch({ contact_id: contact.id, channel: "email", external_id: "<m1@x>" });
    expect(t2.deduped).toBe(true);
    expect(t2.touch.id).toBe(t1.touch.id);
  });
});

describe("idempotency", () => {
  it("replays the stored response for the same key + input", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ email: "i@dem.io" });
    const input = { contact_id: contact.id, channel: "linkedin" as const, body: "hi", follow_up_in_days: 3, idempotency_key: "key-0001" };
    const r1 = await svc.log_touch(input);
    const r2 = await svc.log_touch(input);
    expect(r2.touch.id).toBe(r1.touch.id);
    expect(r2.follow_up_task?.id).toBe(r1.follow_up_task?.id);
    const full = await svc.get_contact({ id: contact.id });
    expect(full.touches).toHaveLength(1);
    expect(full.open_tasks).toHaveLength(1);
  });

  it("rejects key reuse with a different input", async () => {
    const { svc } = await makeOrg();
    await svc.create_task({ title: "a", idempotency_key: "key-0002" });
    await expect(svc.create_task({ title: "b", idempotency_key: "key-0002" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("keys are scoped per org", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const ta = await a.svc.create_task({ title: "t", idempotency_key: "same-key" });
    const tb = await b.svc.create_task({ title: "t", idempotency_key: "same-key" });
    expect(tb.id).not.toBe(ta.id);
  });
});

describe("activity log", () => {
  it("records every write with actor and reason, newest first", async () => {
    const { svc, ctx } = await makeOrg();
    const { contact } = await svc.upsert_contact({ email: "log@x.io", reason: "imported from list" });
    await svc.log_touch({ contact_id: contact.id, channel: "email" });
    await svc.update_stage({ contact_id: contact.id, stage: "call_booked", reason: "booked call" });
    await svc.add_note({ entity_id: contact.id, body: "likes golf" });
    const task = await svc.create_task({ title: "send deck", contact_id: contact.id });
    await svc.complete_task({ id: task.id });

    const log = await svc.get_activity({});
    const actions = log.map((r) => r.action);
    for (const a of ["company.created", "contact.created", "touch.logged", "contact.stage_changed", "note.added", "task.created", "task.completed"])
      expect(actions).toContain(a);
    expect(log.every((r) => r.actorId === ctx.actor.id && r.actorType === "agent")).toBe(true);
    expect(log.find((r) => r.action === "contact.stage_changed")?.reason).toBe("booked call");
    expect((await svc.get_contact({ id: contact.id })).stage).toBe("call_booked");
  });

  it("idempotent replays do not add log rows", async () => {
    const { svc } = await makeOrg();
    await svc.upsert_company({ domain: "once.io", idempotency_key: "key-0003" });
    await svc.upsert_company({ domain: "once.io", idempotency_key: "key-0003" });
    expect(await svc.get_activity({})).toHaveLength(1);
  });

  it("has no update/delete path (DB trigger)", async () => {
    const { svc } = await makeOrg();
    await svc.upsert_company({ domain: "t.io" });
    await expect(env.DB.prepare("update activity_log set action='x'").run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("delete from activity_log").run()).rejects.toThrow(/append-only/);
  });
});

describe("follow-ups", () => {
  it("lists due tasks only for this org, by ISO date", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    const { contact } = await a.svc.upsert_contact({ email: "f@u.io" });
    await a.svc.create_task({ title: "past", contact_id: contact.id, due_at: "2020-01-01T00:00:00Z" });
    await a.svc.create_task({ title: "future", due_at: "2999-01-01" });
    expect((await a.svc.list_due_followups({})).length).toBe(1);
    expect((await a.svc.list_due_followups({ before: "3000-01-01" })).length).toBe(2);
    expect(await b.svc.list_due_followups({ before: "3000-01-01" })).toEqual([]);
    await expect(a.svc.create_task({ title: "x", due_at: "not a date" })).rejects.toThrow();
  });
});
