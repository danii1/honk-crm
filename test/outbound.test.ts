import { describe, expect, it } from "vitest";
import { db, makeOrg } from "./helpers";
import { CrmService, parseImportRow } from "../src/service";
import { extractIdentities, mapStatus, parseCsv } from "../src/csv";
import { normalizeLinkedin, normalizeRedditUser, normalizeXHandle, endOfLocalDay, startOfLocalDay } from "../src/normalize";
import { advance, rollup } from "../src/rules";

const HEADER = "handle,name,profile_url,bio_summary,followers,company,role,est_team_size,signal_post_url,signal_post_date,signal_summary,score,source,status,first_seen,notes";

describe("normalization", () => {
  it("normalizes identities", () => {
    expect(normalizeXHandle("https://x.com/Foo_Bar/status/123")).toBe("foo_bar");
    expect(normalizeXHandle("@Foo")).toBe("foo");
    expect(normalizeLinkedin("https://www.linkedin.com/in/Jane-Doe/?utm=1")).toBe("linkedin.com/in/jane-doe");
    expect(normalizeLinkedin("https://uk.linkedin.com/in/jane-doe")).toBe("linkedin.com/in/jane-doe");
    expect(normalizeRedditUser("https://old.reddit.com/user/Some_Dev/")).toBe("some_dev");
    expect(normalizeRedditUser("u/some_dev")).toBe("some_dev");
  });
  it("computes Asia/Saigon day bounds", () => {
    const now = new Date("2026-11-04T20:30:00Z"); // 03:30 Nov 5 in Saigon
    expect(startOfLocalDay(now, "Asia/Saigon").toISOString()).toBe("2026-11-04T17:00:00.000Z");
    expect(endOfLocalDay(now, "Asia/Saigon").toISOString()).toBe("2026-11-05T17:00:00.000Z");
  });
  it("stage rules only move forward; dnc is sticky", () => {
    expect(advance("responded", "contacted")).toBe("responded");
    expect(advance("contacted", "responded")).toBe("responded");
    expect(advance("do_not_contact", "paying")).toBe("do_not_contact");
    expect(rollup("new", ["contacted", "connected"])).toBe("connected");
    expect(rollup("pilot", ["contacted"])).toBe("pilot");
    expect(rollup("contacted", ["lost", "lost"])).toBe("lost");
    expect(rollup("contacted", ["responded", "do_not_contact"])).toBe("do_not_contact");
  });
});

describe("dedupe across identities", () => {
  it("matches by any identity and refuses to merge two contacts", async () => {
    const { svc } = await makeOrg();
    const a = await svc.upsert_contact({ x_handle: "@Alice", name: "Alice A" });
    const b = await svc.upsert_contact({ x_handle: "https://x.com/alice", linkedin_url: "linkedin.com/in/alice-a", reddit_user: "u/alice_dev" });
    expect(b.contact.id).toBe(a.contact.id);
    const c = await svc.upsert_contact({ reddit_user: "https://reddit.com/user/Alice_Dev", github: "github.com/alicegh" });
    expect(c.contact.id).toBe(a.contact.id);
    expect(c.contact.github).toBe("alicegh");
    await svc.upsert_contact({ email: "bob@bobco.dev", name: "Bob" });
    await expect(svc.upsert_contact({ email: "bob@bobco.dev", x_handle: "alice" })).rejects.toMatchObject({ code: "conflict" });
    await expect(svc.upsert_contact({ x_handle: "not a handle!!" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("find_existing: identity, domain and fuzzy name+company candidates", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ email: "jon@acme.io", name: "Jonathan Smith", company_name: "Acme", linkedin_url: "linkedin.com/in/jsmith" });
    const byAny = await svc.find_existing({ identity: "https://www.linkedin.com/in/JSmith/" });
    expect(byAny.found).toBe(true);
    expect(byAny.exact[0]!.match).toContain("linkedin_url");
    const byDomain = await svc.find_existing({ domain: "https://acme.io" });
    expect(byDomain.by_domain.map((d) => (d.contact as { id: string }).id)).toContain(contact.id);
    const fuzzy = await svc.find_existing({ name: "Jonathon Smith", company: "Acme Inc" });
    expect(fuzzy.found).toBe(false);
    expect(fuzzy.candidates[0]!.reason).toMatch(/company/);
    const none = await svc.find_existing({ name: "Jonathon Smith", company: "Other Corp" });
    expect(none.candidates).toHaveLength(0);
  });
});

describe("competitor blocklist", () => {
  it("rejects matching leads, allows competitor records, and is checkable", async () => {
    const { svc } = await makeOrg();
    await svc.add_competitor({ value: "Factory AI", kind: "name" });
    await svc.add_competitor({ value: "https://devin.ai" });
    await svc.add_competitor({ value: "@cognition_labs" });
    expect((await svc.list_competitors()).map((e) => e.kind).toSorted()).toEqual(["domain", "handle", "name"]);

    await expect(svc.upsert_contact({ email: "sales@app.devin.ai" })).rejects.toMatchObject({ code: "blocked" });
    await expect(svc.upsert_contact({ x_handle: "Cognition_Labs" })).rejects.toMatchObject({ code: "blocked" });
    await expect(svc.upsert_contact({ name: "Eve", company_name: "Factory AI" })).rejects.toMatchObject({ code: "blocked" });
    const comp = await svc.upsert_contact({ x_handle: "cognition_labs", contact_type: "competitor" });
    expect(comp.contact.contactType).toBe("competitor");
    await expect(svc.create_draft({ contact_id: comp.contact.id, channel: "x", text: "hi" })).rejects.toMatchObject({ code: "blocked" });

    expect((await svc.is_competitor({ domain: "devin.ai" })).is_competitor).toBe(true);
    expect((await svc.is_competitor({ company: "Factorial" })).is_competitor).toBe(false);
    expect((await svc.is_competitor({ contact_id: comp.contact.id })).is_competitor).toBe(true);
    expect((await svc.find_existing({ identity: "@cognition_labs" })).is_competitor).toBe(true);
  });
});

describe("per-channel state", () => {
  it("tracks stage + follow-ups per channel and rolls up the overall stage", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ x_handle: "carol", linkedin_url: "linkedin.com/in/carol" });
    await svc.set_channel_state({ contact_id: contact.id, channel: "linkedin", stage: "connection_pending", last_touch_at: "2020-01-01T00:00:00Z", next_followup_at: "2020-01-01T00:00:00Z", next_step: "check acceptance" });
    const r = await svc.set_channel_state({ contact_id: contact.id, channel: "x", stage: "contacted", last_touch_at: "2020-01-01T00:00:00Z" });
    expect(r.overall_stage).toBe("connection_pending");

    const due = await svc.due_followups({});
    // x got the default +3d follow-up (2020-01-04 09:00 Saigon) when it moved to contacted
    expect(due.channel_followups.map((d) => [d.channel, d.overdue]).toSorted()).toEqual([["linkedin", true], ["x", true]]);
    expect((await svc.stale_no_response({ days: 3 })).map((s) => s.channel).toSorted()).toEqual(["linkedin", "x"]);
    expect((await svc.linkedin_needs_first_message({})).map((x) => x.contact_id)).toEqual([contact.id]);

    await svc.log_touch({ contact_id: contact.id, channel: "linkedin", body: "thanks for connecting" });
    expect(await svc.linkedin_needs_first_message({})).toEqual([]);
    await svc.log_touch({ contact_id: contact.id, channel: "x", direction: "inbound", body: "tell me more" });
    const full = await svc.get_contact({ id: contact.id });
    expect(Object.fromEntries(full.channel_states.map((s) => [s.channel, s.stage]))).toEqual({ linkedin: "connection_pending", x: "responded" });
    expect(full.stage).toBe("responded");
    expect((await svc.list_contacts({ channel: "x", channel_stage: "responded" })).map((c) => c.id)).toEqual([contact.id]);

    await svc.set_channel_state({ contact_id: contact.id, channel: "linkedin", next_followup_at: null });
    expect((await svc.due_followups({})).channel_followups).toEqual([]);
  });
});

describe("drafts state machine", () => {
  it("drafted -> approved -> sent, logs everything, never sends", async () => {
    const { svc } = await makeOrg();
    const { campaign } = await svc.upsert_campaign({ name: "Nov pilot", offer_text: "Free 2-week pilot" });
    const { contact } = await svc.upsert_contact({ x_handle: "dave", campaign_id: campaign.id });
    const d = await svc.create_draft({ contact_id: contact.id, channel: "x", text: "v1", intent_url: "https://x.com/intent/post?text=v1" });
    expect(d.campaignId).toBe(campaign.id);
    expect((await svc.get_contact({ id: contact.id })).channel_states[0]!.stage).toBe("drafted");

    await expect(svc.transition_draft({ draft_id: d.id, to: "sent" })).rejects.toMatchObject({ code: "conflict" });
    await expect(svc.transition_draft({ draft_id: d.id, to: "approved", text: "x" })).rejects.toMatchObject({ code: "invalid" });
    await svc.transition_draft({ draft_id: d.id, to: "drafted", text: "v2" });
    await svc.transition_draft({ draft_id: d.id, to: "approved" });
    expect((await svc.list_drafts({ state: "approved" })).map((x) => x.id)).toEqual([d.id]);
    const sent = await svc.transition_draft({ draft_id: d.id, to: "sent", follow_up_in_days: 3, external_id: "https://x.com/me/status/1" });
    expect(sent.draft.state).toBe("sent");
    expect(sent.touch?.body).toBe("v2");
    expect(sent.x_pacing_before_send).not.toBeNull();
    await expect(svc.transition_draft({ draft_id: d.id, to: "discarded" })).rejects.toMatchObject({ code: "conflict" });

    const full = await svc.get_contact({ id: contact.id });
    expect(full.channel_states[0]!.stage).toBe("contacted");
    expect(full.channel_states[0]!.nextFollowupAt).not.toBeNull();
    const log = (await svc.get_activity({ entity_type: "draft", entity_id: d.id })).map((r) => (r.payload as { to?: string })?.to ?? r.action);
    expect(log).toEqual(["sent", "approved", "drafted", "draft.created"]);
  });

  it("discarding the only open draft releases the channel from drafted", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ x_handle: "erin" });
    const d = await svc.create_draft({ contact_id: contact.id, channel: "x", text: "hi" });
    await svc.transition_draft({ draft_id: d.id, to: "discarded" });
    expect((await svc.get_contact({ id: contact.id })).channel_states[0]!.stage).toBe("qualified");
  });
});

describe("x pacing", () => {
  it("enforces 60-min gap and 8/day in Asia/Saigon", async () => {
    const { svc } = await makeOrg();
    const day = "2026-11-04";
    const at = (hhmm: string) => new Date(`${day}T${hhmm}:00+07:00`).toISOString();
    for (let n = 0; n < 8; n++) {
      const { contact } = await svc.upsert_contact({ x_handle: `px${n}` });
      await svc.log_touch({ contact_id: contact.id, channel: "x", sent_at: at(`${String(8 + n).padStart(2, "0")}:00`) });
    }
    const { contact } = await svc.upsert_contact({ x_handle: "pxd" });
    await svc.create_draft({ contact_id: contact.id, channel: "x", text: "queued" });

    const p1 = await svc.x_pacing_today({ now: at("15:30") });
    expect(p1).toMatchObject({ sent_today: 8, cap_ok: false, gap_ok: false, ok_to_send: false, remaining_today: 0 });
    expect(new Date(p1.next_allowed_at).toISOString()).toBe(new Date(`2026-11-05T00:00:00+07:00`).toISOString());
    const p2 = await svc.x_pacing_today({ now: at("10:20") });
    expect(p2).toMatchObject({ sent_today: 3, gap_ok: false, cap_ok: true, ok_to_send: false, minutes_since_last_send: 20 });
    // early next morning Saigon time (still Nov 4 in UTC) is a new day
    const p3 = await svc.x_pacing_today({ now: new Date("2026-11-05T06:30:00+07:00").toISOString() });
    expect(p3).toMatchObject({ sent_today: 0, ok_to_send: true });
  });
});

describe("report", () => {
  it("computes per-channel rates, LinkedIn acceptance and goal progress", async () => {
    const { svc, ctx } = await makeOrg();
    expect((await svc.outreach_report({})).goal).toBeNull();
    const member = new CrmService(db, { ...ctx, role: "member" });
    await expect(member.set_goals({ targets: [{ stage: "pilot", count: 4 }] })).rejects.toThrow(/admin/);
    await svc.set_goals({ targets: [{ stage: "pilot", count: 4 }, { stage: "paying", count: 2 }], deadline: "2027-12-15" });
    const { campaign } = await svc.upsert_campaign({ name: "C1" });
    const mk = async (h: string, li: string, stage?: "pilot" | "paying") => {
      const { contact } = await svc.upsert_contact({ x_handle: h, campaign_id: campaign.id });
      await svc.set_channel_state({ contact_id: contact.id, channel: "linkedin", stage: li as "connected" });
      if (stage) await svc.update_stage({ contact_id: contact.id, stage });
    };
    await mk("r1", "connection_pending");
    await mk("r2", "connected");
    await mk("r3", "responded", "pilot");
    await mk("r4", "paying", "paying");
    const rep = await svc.outreach_report({});
    expect(rep.by_channel.linkedin).toMatchObject({ contacted: 4, invites: 4, accepted: 3, acceptance_rate_pct: 75, responded: 2, response_rate_pct: 50 });
    expect(rep.by_campaign[0]).toMatchObject({ name: "C1", leads: 4, pilots: 2, paying: 1 });
    expect(rep.goal).toMatchObject({ targets: [{ stage: "pilot", current: 2, target: 4 }, { stage: "paying", current: 1, target: 2 }], deadline: "2027-12-15", met: false });
    expect((await svc.get_goals()).targets).toHaveLength(2);
    const { svc: other } = await makeOrg();
    expect((await other.outreach_report({})).goal).toBeNull();
    await svc.set_goals({ targets: [] });
    expect((await svc.daily_overview({})).goal).toBeNull();
  });
});

describe("CSV import", () => {
  it("parses messy rows", () => {
    expect(parseCsv('a,b\n"x, ""y""",2\r\n"multi\nline",3\n')).toEqual([["a", "b"], ['x, "y"', "2"], ["multi\nline", "3"]]);
    const e = extractIdentities("ping me: Jane.Doe@Corp.io / https://www.linkedin.com/in/janed/ and github.com/janed-gh, also u/jane_r; site https://janed.dev.");
    expect(e).toMatchObject({ emails: ["jane.doe@corp.io"], linkedin: ["linkedin.com/in/janed"], github: ["janed-gh"], reddit: ["jane_r"], other_urls: ["https://janed.dev"] });
    expect(mapStatus("DM sent")).toMatchObject({ stage: "contacted", known: true });
    expect(mapStatus("Connection-Sent").stage).toBe("connection_pending");
    expect(mapStatus("weird")).toMatchObject({ stage: "new", known: false });
    const w: string[] = [];
    const p = parseImportRow({ handle: "@JaneD", name: "Jane", followers: "12.5k", score: "9", source: "twitter", status: "replied", notes: "jane@corp.io", company: "Corp" }, w);
    expect(p).toMatchObject({ source: "x", channel: "x", followers: 12500, score: 5, scoreOriginal: "9", companyDomain: "corp.io", ids: { xHandle: "janed", email: "jane@corp.io" }, mapped: { stage: "responded" } });
    expect(w.join()).not.toMatch(/score/);
  });

  it("dry-run reports, real run writes, re-run is a no-op", async () => {
    const { svc } = await makeOrg();
    await svc.add_competitor({ value: "rivalcorp.com" });
    const csv = [
      HEADER,
      '@ann,Ann,https://x.com/ann,"Builds agents, ships fast",1.2k,Ann Co,CTO,5,https://x.com/ann/status/1,2026-10-30,Asked about PR bots,4,x,dm sent,2026-10-30,"email ann@annco.dev, li: https://linkedin.com/in/ann-a"',
      "@ann_dup,Ann again,,,,,,,,,,,x,new,,see https://linkedin.com/in/ann-a",
      "u/redd,Red,https://reddit.com/user/redd,,,,,,,,,,reddit,connected,,",
      "@riv,Rival Person,,,,,,,,,,,x,new,,rival@rivalcorp.com",
      ",,,,,,,,,,,,web,new,,nothing here",
    ].join("\n");
    const dry = await svc.import_leads_csv({ csv });
    expect(dry).toMatchObject({ dry_run: true, total_rows: 5, created: 2, updated: 0, unchanged: 1, skipped: 2 });
    expect(await svc.list_contacts({})).toEqual([]);

    const real = await svc.import_leads_csv({ csv, dry_run: false });
    expect(real).toMatchObject({ dry_run: false, created: 2, updated: 0, unchanged: 1, skipped: 2 });
    const [ann] = await svc.list_contacts({ source: "x" });
    expect(ann).toMatchObject({ xHandle: "ann", email: "ann@annco.dev", linkedin: "linkedin.com/in/ann-a", followers: 1200, score: 4, stage: "contacted" });
    const full = await svc.get_contact({ id: ann!.id });
    expect(full.company?.domain).toBe("annco.dev");
    expect(full.channel_states.map((s) => [s.channel, s.stage])).toEqual([["x", "contacted"]]);
    expect(real.rows.find((r) => r.row === 3)!.warnings.join()).toMatch(/xHandle differs/);

    const again = await svc.import_leads_csv({ csv, dry_run: false });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3, skipped: 2 });
    const exp = await svc.export_csv({});
    expect(exp.rows).toBe(2);
    expect(exp.csv.split("\n")[0]!.startsWith(HEADER.replace(",status,", ",stage,"))).toBe(true);
  });
});

describe("tenant isolation of new tables", () => {
  it("blocklist, channel states, drafts, campaigns and imports are per org", async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    await a.svc.add_competitor({ value: "rival.io" });
    const { campaign } = await a.svc.upsert_campaign({ name: "A only" });
    const { contact } = await a.svc.upsert_contact({ x_handle: "shared", campaign_id: campaign.id });
    const d = await a.svc.create_draft({ contact_id: contact.id, channel: "x", text: "hi" });
    await a.svc.set_channel_state({ contact_id: contact.id, channel: "x", stage: "contacted", next_followup_at: "2020-01-01T00:00:00Z" });

    expect(await b.svc.list_competitors()).toEqual([]);
    await expect(b.svc.upsert_contact({ email: "x@rival.io" })).resolves.toBeTruthy();
    expect(await b.svc.list_campaigns()).toEqual([]);
    await expect(b.svc.upsert_contact({ x_handle: "z", campaign_id: campaign.id })).rejects.toMatchObject({ code: "not_found" });
    expect(await b.svc.list_drafts({})).toEqual([]);
    await expect(b.svc.transition_draft({ draft_id: d.id, to: "approved" })).rejects.toMatchObject({ code: "not_found" });
    await expect(b.svc.set_channel_state({ contact_id: contact.id, channel: "x", stage: "lost" })).rejects.toMatchObject({ code: "not_found" });
    expect((await b.svc.due_followups({})).channel_followups).toEqual([]);
    expect((await b.svc.find_existing({ x_handle: "shared" })).found).toBe(false);
    const imp = await b.svc.import_leads_csv({ csv: `${HEADER}\n@shared,S,,,,,,,,,,,x,new,,`, dry_run: false });
    expect(imp.created).toBe(1);
    expect((await a.svc.outreach_report({})).totals.leads).toBe(1);
    expect((await b.svc.x_pacing_today({})).drafted_today).toBe(0);
  });
});
