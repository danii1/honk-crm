import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { parseImportRow, postId } from "../src/service";
import { normalizeThreadsHandle } from "../src/normalize";
import { makeOrg } from "./helpers";

const DAY = 86_400_000;
const saigonDay = (d: Date | string | null | undefined) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Saigon" }).format(new Date(d!));

describe("mark_draft_sent / sync_sent", () => {
  it("finds a draft by id, intent url or tweet id/url and is idempotent", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ x_handle: "dora" });
    const d1 = await svc.create_draft({ contact_id: contact.id, channel: "x", text: "hey", intent_url: "https://x.com/intent/post?in_reply_to=1111222233334444&text=hey" });
    const r = await svc.mark_draft_sent({ post_id: "https://x.com/dora/status/1111222233334444", external_id: "https://x.com/me/status/9999000011112222", sent_at: "2026-11-04T03:00:00Z" });
    expect(r.status).toBe("sent");
    expect(r.matched_by).toBe("post_id");
    expect(r.draft).toMatchObject({ id: d1.id, state: "sent", externalId: "9999000011112222", externalUrl: "https://x.com/me/status/9999000011112222", threadId: "1111222233334444" });
    expect(r.touch).toMatchObject({ externalId: "9999000011112222", channel: "x" });
    // default +3d on X, 09:00 Saigon
    expect(saigonDay(r.channel_state!.nextFollowupAt)).toBe("2026-11-07");
    expect(r.channel_state!.stage).toBe("contacted");
    // retry by the sent id -> already_sent, no second touch
    const again = await svc.mark_draft_sent({ external_id: "9999000011112222" });
    expect(again.status).toBe("already_sent");
    expect((await svc.get_contact({ id: contact.id })).touches).toHaveLength(1);

    const { contact: c2 } = await svc.upsert_contact({ linkedin_url: "linkedin.com/in/eve" });
    const d2 = await svc.create_draft({ contact_id: c2.id, channel: "linkedin", text: "hi", intent_url: "https://linkedin.com/messaging/eve" });
    await svc.set_channel_state({ contact_id: c2.id, channel: "linkedin", stage: "connected" });
    const d3 = await svc.create_draft({ contact_id: c2.id, channel: "email", text: "mail" });
    const bulk = await svc.sync_sent({ idempotency_key: "sync-batch-1", items: [{ intent_url: "https://linkedin.com/messaging/eve" }, { draft_id: d3.id, external_id: "gmail-msg-1", thread_id: "gmail-thread-1" }, { draft_id: d1.id }, { post_id: "nope-404" }] });
    expect(bulk.results.map((x) => (x.ok ? x.status : x.error))).toEqual(["sent", "sent", "already_sent", "not_found"]);
    expect(bulk).toMatchObject({ sent: 2, already_sent: 1, failed: 1 });
    expect((await svc.sync_sent({ idempotency_key: "sync-batch-1", items: [{ intent_url: "https://linkedin.com/messaging/eve" }, { draft_id: d3.id, external_id: "gmail-msg-1", thread_id: "gmail-thread-1" }, { draft_id: d1.id }, { post_id: "nope-404" }] })).sent).toBe(2);
    const st = (await svc.get_contact({ id: c2.id })).channel_states;
    // linkedin was already further (connected) -> stays; email -> contacted with +4d
    expect(Object.fromEntries(st.map((s) => [s.channel, s.stage]))).toEqual({ linkedin: "connected", email: "contacted" });
    expect(d2.id).toBeTruthy();
    expect(postId("https://x.com/a/status/123?s=20")).toBe("123");
  });

  it("refuses ambiguous matches", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ x_handle: "fred" });
    await svc.create_draft({ contact_id: contact.id, channel: "x", text: "a", intent_url: "https://x.com/intent/post?in_reply_to=555" });
    await svc.create_draft({ contact_id: contact.id, channel: "x", text: "b", intent_url: "https://x.com/intent/post?in_reply_to=555&x=1" });
    await expect(svc.mark_draft_sent({ post_id: "555" })).rejects.toThrow(/2 open drafts/);
  });
});

describe("record_event + threads", () => {
  it("dedupes, resolves contacts by identity/thread and advances stages", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ x_handle: "gina", linkedin_url: "linkedin.com/in/gina", email: "gina@acme.io" });
    const d = await svc.create_draft({ contact_id: contact.id, channel: "x", text: "yo", thread_id: "conv-42" });
    await svc.mark_draft_sent({ draft_id: d.id, external_id: "777" });
    expect((await svc.find_by_thread({ channel: "x", thread_id: "conv-42" })).contact!.id).toBe(contact.id);
    expect((await svc.find_by_thread({ channel: "x", thread_id: "777" })).contact!.id).toBe(contact.id);
    expect((await svc.find_by_thread({ channel: "x", thread_id: "zzz" })).contact).toBeNull();

    const r = await svc.record_event({ type: "reply_received", channel: "x", external_id: "888", thread_id: "conv-42", summary: "sounds good" });
    expect(r).toMatchObject({ deduped: false, resolved_by: expect.stringMatching(/^thread:/), stage_changed: true, overall_stage: "responded" });
    expect(r.channel_state).toMatchObject({ stage: "responded", nextFollowupAt: null, nextStep: "reply" });
    expect((await svc.record_event({ type: "reply_received", channel: "x", external_id: "888" })).deduped).toBe(true);

    const acc = await svc.record_event({ type: "connection_accepted", channel: "linkedin", external_id: "linkedin.com/in/gina", linkedin_url: "https://www.linkedin.com/in/gina/" });
    expect(acc.channel_state).toMatchObject({ stage: "connected", nextStep: "send first message" });
    expect(saigonDay(acc.channel_state!.nextFollowupAt)).toBe(saigonDay(new Date()));

    const em = await svc.record_event({ type: "email_reply", channel: "email", external_id: "gm-1", thread_id: "gt-1", email: "GINA@acme.io" });
    expect(em.channel_state!.stage).toBe("responded");
    expect((await svc.find_by_thread({ channel: "email", thread_id: "gt-1" })).matched_by).toBe("event");
    const mb = await svc.record_event({ type: "meeting_booked", channel: "email", external_id: "cal-1", contact_id: contact.id });
    expect((mb as { overall_stage?: string }).overall_stage).toBe("call_booked");

    // terminal guard: lost contacts are not revived
    await svc.update_stage({ contact_id: contact.id, stage: "lost" });
    const late = await svc.record_event({ type: "reply_received", channel: "linkedin", external_id: "li-msg-1", contact_id: contact.id });
    expect(late.stage_changed).toBe(false);
    expect((late as { skipped?: string }).skipped).toMatch(/lost/);
    expect((late as { overall_stage?: string }).overall_stage).toBe("lost");
    const acts = await svc.get_activity({ entity_id: contact.id, limit: 100 });
    expect(acts.filter((a) => a.action === "event.recorded")).toHaveLength(5);
    await expect(svc.record_event({ type: "reply_received", channel: "x", external_id: "q", x_handle: "nobody" })).rejects.toThrow(/no contact/);
  });
});

describe("followup rules, stale, bulk, overview", () => {
  it("applies configurable per-channel follow-ups and stale thresholds", async () => {
    const { svc } = await makeOrg();
    expect((await svc.get_followup_rules({})).followup_days).toMatchObject({ x: 3, linkedin: 5, email: 4, reddit: 4, threads: 3 });
    await svc.set_followup_rules({ followup_days: { email: 2 }, stale_days: { x: 1 } });
    const rules = await svc.get_followup_rules({});
    expect(rules.followup_days.email).toBe(2);
    expect(rules.stale_days).toMatchObject({ x: 1, linkedin: 10 });
    const { contact } = await svc.upsert_contact({ email: "h@corp.io", x_handle: "hank", linkedin_url: "linkedin.com/in/hank" });
    const t = new Date(Date.now() - 2 * DAY).toISOString();
    await svc.log_touch({ contact_id: contact.id, channel: "email", sent_at: t });
    await svc.set_channel_state({ contact_id: contact.id, channel: "x", stage: "contacted", last_touch_at: t });
    await svc.set_channel_state({ contact_id: contact.id, channel: "linkedin", stage: "contacted", last_touch_at: t, next_followup_at: "2030-01-01T00:00:00Z" });
    const st = Object.fromEntries((await svc.get_contact({ id: contact.id })).channel_states.map((s) => [s.channel, s]));
    expect(saigonDay(st.x!.nextFollowupAt)).toBe(saigonDay(new Date(Date.parse(t) + 3 * DAY)));
    expect(saigonDay(st.linkedin!.nextFollowupAt)).toBe("2030-01-01"); // explicit wins
    // email touch logged "now" -> +2d from today
    expect(saigonDay(st.email!.nextFollowupAt)).toBe(saigonDay(new Date(Date.now() + 2 * DAY)));
    const stale = await svc.stale_no_response({});
    expect(stale.map((s) => [s.channel, s.threshold_days])).toEqual([["x", 1]]);
    expect((await svc.stale_no_response({ days: 0 })).length).toBe(3);
    const viewer = await makeOrg(["crm:read"], "viewer");
    await expect(viewer.svc.set_followup_rules({ followup_days: { x: 1 } })).rejects.toThrow();
  });

  it("bulk_update_stage gives per-item results and overview aggregates", async () => {
    const { svc } = await makeOrg();
    const { contact: a } = await svc.upsert_contact({ x_handle: "ivy" });
    const { contact: b } = await svc.upsert_contact({ x_handle: "jon" });
    const items = [{ contact_id: a.id, channel: "x" as const, stage: "responded" as const }, { contact_id: b.id, stage: "pilot" as const }, { contact_id: "missing", stage: "lost" as const }];
    const r = await svc.bulk_update_stage({ items, idempotency_key: "bulk-stage-1" });
    expect(r.results.map((x) => x.ok)).toEqual([true, true, false]);
    expect(r).toMatchObject({ updated: 2, failed: 1 });
    expect((await svc.bulk_update_stage({ items, idempotency_key: "bulk-stage-1" })).updated).toBe(2);
    expect((await svc.bulk_update_stage({ items: items.slice(0, 2) })).unchanged).toBe(2);

    await svc.create_draft({ contact_id: a.id, channel: "x", text: "draft" });
    await svc.record_event({ type: "reply_received", channel: "x", external_id: "r1", contact_id: a.id });
    const o = await svc.daily_overview({});
    expect(o.tz).toBe("Asia/Saigon");
    expect(o.drafts_pending).toHaveLength(1);
    expect(o.new_replies.map((e) => e.name ?? e.contactId)).toHaveLength(1);
    expect(o.goal).toMatchObject({ pilots: 1, paying: 0 });
    expect(o.stages.pilot).toBe(1);
    expect(o.x_pacing).toHaveProperty("ok_to_send");
  });
});

const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

describe("linkedin_connected_no_first_message", () => {
  it("lists connections older than N days without an outbound message since acceptance", async () => {
    const { svc } = await makeOrg();
    const mk = async (slug: string) => (await svc.upsert_contact({ linkedin_url: `linkedin.com/in/${slug}` })).contact;
    const [old, fresh, messaged, sentBefore] = await Promise.all([mk("old1"), mk("fresh1"), mk("msg1"), mk("before1")]);
    await svc.log_touch({ contact_id: sentBefore.id, channel: "linkedin", body: "invite note", sent_at: ago(10) });
    for (const [c, d] of [[old, 5], [fresh, 1], [messaged, 5], [sentBefore, 5]] as const) await svc.record_event({ type: "connection_accepted", channel: "linkedin", external_id: `acc-${c.id}`, contact_id: c.id, occurred_at: ago(d) });
    await svc.log_touch({ contact_id: messaged.id, channel: "linkedin", body: "thanks for connecting", sent_at: ago(4) });
    const r = await svc.linkedin_connected_no_first_message({ days: 3 });
    expect(r.map((x) => x.contact_id).toSorted()).toEqual([old.id, sentBefore.id].toSorted());
    expect(r[0]!.days_connected).toBeGreaterThanOrEqual(4);
    expect((await svc.linkedin_connected_no_first_message({})).map((x) => x.contact_id)).toContain(fresh.id);
  });
});

describe("threads (Meta) identity", () => {
  it("normalizes, dedupes, finds, imports and exports threads handles", async () => {
    expect(normalizeThreadsHandle("https://www.threads.net/@Kate.Dev")).toBe("kate.dev");
    expect(normalizeThreadsHandle("threads.com/@kate.dev/post/abc")).toBe("kate.dev");
    expect(normalizeThreadsHandle("@kate.dev")).toBe("kate.dev");
    expect(normalizeThreadsHandle("threads:kate.dev")).toBe("kate.dev");
    const { svc } = await makeOrg();
    const a = await svc.upsert_contact({ threads_handle: "https://threads.net/@Kate.Dev", name: "Kate" });
    const b = await svc.upsert_contact({ threads_handle: "@kate.dev", email: "kate@k.dev" });
    expect(b.deduped).toBe(true);
    expect(b.contact.id).toBe(a.contact.id);
    expect((await svc.find_existing({ identity: "https://www.threads.com/@kate.dev" })).exact.map((e) => e.match)).toEqual([["threads_handle"]]);
    expect((await svc.find_existing({ threads_handle: "kate.dev" })).exact).toHaveLength(1);

    const p1 = parseImportRow({ handle: "threads:@lee_x", name: "Lee", source: "threads_search" });
    expect(p1.ids.threadsHandle).toBe("lee_x");
    expect(p1.source).toBe("threads");
    expect(p1.channel).toBe("threads");
    const p2 = parseImportRow({ handle: "", profile_url: "https://www.threads.net/@mo.ra", source: "web" });
    expect(p2.ids.threadsHandle).toBe("mo.ra");
    expect(p2.source).toBe("threads");
    const p3 = parseImportRow({ handle: "https://threads.com/@nia", source: "" });
    expect(p3.ids.threadsHandle).toBe("nia");

    const imp = await svc.import_leads_csv({ csv: "handle,name,source\nthreads:@lee_x,Lee,threads\n", dry_run: false });
    expect(imp).toBeTruthy();
    const lee = (await svc.find_existing({ threads_handle: "lee_x" })).exact[0]!.contact;
    expect(lee.source).toBe("threads");
    const csv = (await svc.export_csv({})).csv;
    expect(csv.split("\n")[0]).toContain("threads_handle");
    expect(csv).toContain("threads:@lee_x");

    await svc.add_competitor({ kind: "handle", value: "threads.net/@rivalco" });
    expect((await svc.is_competitor({ handle: "https://www.threads.com/@RivalCo" })).is_competitor).toBe(true);
    await expect(svc.upsert_contact({ threads_handle: "@rivalco" })).rejects.toThrow();

    const d = await svc.create_draft({ contact_id: a.contact.id, channel: "threads", text: "hi" });
    const sent = await svc.mark_draft_sent({ draft_id: d.id });
    expect(sent.channel_state!.stage).toBe("contacted");
  });
});

describe("dashboard + /v1/overview", () => {
  it("redirects anonymous users and renders for a signed-in viewer session", async () => {
    const anon = await SELF.fetch("http://localhost/dashboard", { redirect: "manual" });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/sign-in?next=%2Fdashboard");

    const auth = createAuth(env);
    const email = `dash-${crypto.randomUUID()}@test.dev`;
    const up = await SELF.fetch("http://localhost/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ email, password: "correct-horse-battery", name: "Dash" }) });
    expect(up.status).toBe(200);
    const cookie = up.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const { user } = (await up.json()) as { user: { id: string } };
    const org = await auth.api.createOrganization({ body: { name: "dash", slug: `dash-${crypto.randomUUID()}`, userId: user.id } });
    const key = await auth.api.createApiKey({ body: { name: "dash-agent", organizationId: org!.id, userId: user.id } });
    const c = await SELF.fetch("http://localhost/v1/upsert_contact", { method: "POST", headers: { "x-api-key": key.key, "content-type": "application/json" }, body: JSON.stringify({ x_handle: "olga", name: "Olga <script>" }) });
    const { contact } = (await c.json()) as { contact: { id: string } };

    const ov = await SELF.fetch("http://localhost/v1/overview", { headers: { "x-api-key": key.key } });
    expect(ov.status).toBe(200);
    expect(await ov.json()).toMatchObject({ tz: "Asia/Saigon", goal: { paying: 0 } });

    const page = await SELF.fetch("http://localhost/dashboard", { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Follow-ups due");
    expect(html).toContain("X pacing");
    const list = await (await SELF.fetch("http://localhost/dashboard/contacts?stage=new", { headers: { cookie } })).text();
    expect(list).toContain("Olga &lt;script&gt;");
    expect(list).not.toContain("<script>");
    const detail = await SELF.fetch(`http://localhost/dashboard/contacts/${contact.id}`, { headers: { cookie } });
    expect(await detail.text()).toContain("Timeline");
    expect((await SELF.fetch("http://localhost/dashboard/contacts/nope", { headers: { cookie } })).status).toBe(404);
  });
});
