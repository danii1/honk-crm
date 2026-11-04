import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import backfillSql from "../migrations/0008_channel_registry.sql?raw";
import { BUILTIN_CHANNELS, BUILTIN_REGISTRY as reg, maskPhone, normalizePhone } from "../src/channels";
import { CrmService, parseImportRow } from "../src/service";
import { contacts } from "../src/db/schema";
import { db, makeOrg } from "./helpers";

const p = (raw: string) => {
  const r = reg.parse(raw);
  return r && { kind: r.kind, value: r.value, scope: r.scope };
};

describe("channel registry parsing", () => {
  it("parses URLs and prefixes for every channel", () => {
    const cases: [string, string, string, string?][] = [
      ["https://x.com/JaneD", "x_handle", "janed"],
      ["x:@JaneD", "x_handle", "janed"],
      ["https://www.linkedin.com/in/jane-d/", "linkedin_url", "linkedin.com/in/jane-d"],
      ["https://reddit.com/user/jo_r", "reddit_user", "jo_r"],
      ["mailto:Jane@Corp.io", "email", "jane@corp.io"],
      ["https://www.threads.net/@mo.ra", "threads_handle", "mo.ra"],
      ["https://news.ycombinator.com/user?id=pg", "hn_user", "pg"],
      ["hn:pg", "hn_user", "pg"],
      ["https://github.com/octo-cat", "github", "octo-cat"],
      ["gh:octo-cat", "github", "octo-cat"],
      ["discord:rustlang/ferris", "discord_user", "ferris", "rustlang"],
      ["slack:https://acme.slack.com/team/U0123ABC", "slack_user", "U0123ABC", "acme"],
      ["https://bsky.app/profile/alice.bsky.social", "bsky_handle", "alice.bsky.social"],
      ["bsky:alice", "bsky_handle", "alice.bsky.social"],
      ["https://www.tiktok.com/@dancer_1", "tiktok", "dancer_1"],
      ["tiktok:@dancer_1", "tiktok", "dancer_1"],
      ["https://instagram.com/photo.guy/", "instagram", "photo.guy"],
      ["ig:photo.guy", "instagram", "photo.guy"],
      ["https://www.youtube.com/@TechChan", "youtube", "@techchan"],
      ["yt:@TechChan", "youtube", "@techchan"],
      ["https://facebook.com/zuck.berg", "facebook", "zuck.berg"],
      ["fb:Zuck.Berg", "facebook", "zuck.berg"],
      ["https://t.me/durov", "telegram", "durov"],
      ["tg:@durov", "telegram", "durov"],
      ["https://wa.me/84901234567", "whatsapp", "+84901234567"],
      ["wa:+84 90 123 4567", "whatsapp", "+84901234567"],
    ];
    for (const [raw, kind, value, scope] of cases) expect(p(raw), raw).toMatchObject({ kind, value, scope: scope ?? "" });
    // every built-in channel is covered by at least one case
    const covered = new Set(cases.map(([, k]) => reg.kind(k)!.channel));
    expect(BUILTIN_CHANNELS.map((c) => c.id).filter((c) => !covered.has(c))).toEqual([]);
    expect(reg.normalize("discord_user", "Ferris", "RustLang")).toMatchObject({ value: "ferris", scope: "rustlang" });
    expect(reg.normalize("hn", "news.ycombinator.com/user?id=dang")).toMatchObject({ kind: "hn_user", value: "dang" });
    expect(p("https://example.com/about")).toBeNull();
    expect(normalizePhone("0084 (90) 123-4567")).toBe("+84901234567");
    expect(maskPhone("+84901234567")).toMatch(/^\+849\*+67$/);
  });

  it("import rows pick up new channel prefixes and URLs", () => {
    expect(parseImportRow({ handle: "hn:pg", name: "PG" })).toMatchObject({ source: "hackernews", channel: "hackernews", extra: [{ kind: "hn_user", value: "pg" }] });
    expect(parseImportRow({ handle: "", profile_url: "https://bsky.app/profile/alice.bsky.social", source: "web" })).toMatchObject({ source: "bluesky", website: null, extra: [{ kind: "bsky_handle" }] });
    expect(parseImportRow({ handle: "https://t.me/durov" }).extra).toMatchObject([{ kind: "telegram", value: "durov" }]);
    // legacy prefixes unchanged
    expect(parseImportRow({ handle: "li:jo" }).ids.linkedin).toBe("linkedin.com/in/jo");
  });
});

describe("contact_identities", () => {
  it("mirrors legacy columns and dedupes across every identity", async () => {
    const { svc } = await makeOrg();
    const a = await svc.upsert_contact({ x_handle: "jane", identities: [{ kind: "hn_user", value: "janeh" }, { kind: "discord", value: "ferris", scope: "rustlang" }] });
    expect(a.identities.map((i) => i.kind).toSorted()).toEqual(["discord_user", "hn_user", "x_handle"]);
    // same person via an HN URL -> deduped, new identity added
    const b = await svc.upsert_contact({ identities: [{ kind: "hn", value: "https://news.ycombinator.com/user?id=janeh" }, { kind: "bsky", value: "jane" }], name: "Jane" });
    expect(b).toMatchObject({ created: false, deduped: true });
    expect(b.contact.id).toBe(a.contact.id);
    // scoped: same discord user in another server is a different identity
    const c = await svc.upsert_contact({ identities: [{ kind: "discord_user", value: "ferris", scope: "other" }] });
    expect(c.created).toBe(true);
    await expect(svc.upsert_contact({ identities: [{ kind: "bsky", value: "jane" }, { kind: "discord_user", value: "other/ferris" }] })).rejects.toThrow(/2 different contacts/);
    await expect(svc.upsert_contact({ contact_id: c.contact.id, identities: [{ kind: "hn", value: "janeh" }] })).rejects.toThrow(/other contacts/);
    // find_existing / find_by_identity / legacy update sync
    expect((await svc.find_existing({ identity: "bsky:jane.bsky.social" })).exact[0]).toMatchObject({ contact: { id: a.contact.id }, matched_kinds: ["bsky_handle"] });
    expect((await svc.find_existing({ identities: [{ kind: "discord_user", value: "ferris", scope: "rustlang" }] })).found).toBe(true);
    expect((await svc.find_by_identity({ value: "https://x.com/Jane" })).contacts[0]!.id).toBe(a.contact.id);
    await svc.upsert_contact({ contact_id: a.contact.id, x_handle: "jane_new" });
    expect((await svc.find_by_identity({ kind: "x_handle", value: "jane" })).found).toBe(false);
    expect((await svc.find_by_identity({ kind: "x", value: "@jane_new" })).found).toBe(true);
    await svc.upsert_contact({ contact_id: a.contact.id, clear: ["x_handle"] });
    expect((await svc.get_contact({ id: a.contact.id })).identities.map((i) => i.kind)).not.toContain("x_handle");
    // identities[] for legacy kinds land in the legacy columns
    const d = await svc.upsert_contact({ identities: [{ kind: "github", value: "https://github.com/octo" }, { kind: "email", value: "Octo@Corp.io" }] });
    expect(d.contact).toMatchObject({ github: "octo", email: "octo@corp.io" });
    // record_event resolves by a new identity
    const ev = await svc.record_event({ type: "reply_received", channel: "hackernews", external_id: "hn-item-1", identities: [{ kind: "hn", value: "janeh" }] });
    expect(ev.contact_id).toBe(a.contact.id);
  });

  it("import dedupes against table identities, also on dry run within the file", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ identities: [{ kind: "tiktok", value: "dancer" }], name: "Dancer", source: "tiktok" });
    const csv = "handle,name,source\ntiktok:@dancer,Dancer,\nig:new.one,New One,\nhttps://instagram.com/new.one,New One again,\n";
    const dry = await svc.import_leads_csv({ csv, dry_run: true });
    expect(dry).toMatchObject({ created: 1, updated: 0, unchanged: 2 });
    const real = await svc.import_leads_csv({ csv, dry_run: false });
    expect(real.rows[0]).toMatchObject({ action: "unchanged", contact_id: contact.id });
    expect(real.created).toBe(1);
    const ig = await svc.find_by_identity({ value: "ig:new.one" });
    expect(ig.contacts[0]).toMatchObject({ source: "instagram", name: "New One" });
    expect((await svc.import_leads_csv({ csv, dry_run: false })).created).toBe(0);
  });

  it("is_competitor and blocklist see new identity handles", async () => {
    const { svc } = await makeOrg();
    await svc.add_competitor({ kind: "handle", value: "rivalco" });
    await expect(svc.upsert_contact({ identities: [{ kind: "tiktok", value: "@rivalco" }] })).rejects.toThrow(/competitor/);
    expect((await svc.is_competitor({ handle: "https://t.me/rivalco" })).is_competitor).toBe(true);
  });

  it("backfill SQL copies legacy columns into contact_identities", async () => {
    const { id, svc } = await makeOrg();
    const now = new Date();
    await db.insert(contacts).values([
      { id: `bf-1-${id}`, orgId: id, name: "A", email: "a@x.io", xHandle: "a_x", linkedin: "linkedin.com/in/a", redditUser: "a_r", github: "a-gh", threadsHandle: "a.th", stage: "new", createdAt: now, updatedAt: now } as never,
      { id: `bf-2-${id}`, orgId: id, name: "B", xHandle: "b_x", stage: "new", createdAt: now, updatedAt: now } as never,
    ]);
    const stmts = backfillSql.split("--> statement-breakpoint").map((x: string) => x.trim()).filter((x: string) => x.startsWith("INSERT"));
    expect(stmts).toHaveLength(6);
    for (const q of stmts) await env.DB.prepare(q).run();
    await env.DB.prepare(stmts[0]!).run(); // idempotent (INSERT OR IGNORE)
    const rows = await env.DB.prepare("select kind, value_normalized v, contact_id c from contact_identities where org_id = ? order by c, kind").bind(id).all<{ kind: string; v: string; c: string }>();
    expect(rows.results.map((r) => `${r.c.slice(0, 4)}:${r.kind}=${r.v}`)).toEqual([
      "bf-1:email=a@x.io", "bf-1:github=a-gh", "bf-1:linkedin_url=linkedin.com/in/a", "bf-1:reddit_user=a_r", "bf-1:threads_handle=a.th", "bf-1:x_handle=a_x",
      "bf-2:x_handle=b_x",
    ]);
    expect((await svc.find_existing({ x_handle: "b_x" })).exact[0]!.contact.id).toBe(`bf-2-${id}`);
  });
});

describe("whatsapp privacy", () => {
  it("masks phones except for admins passing include_private", async () => {
    const { svc, ctx } = await makeOrg();
    const { contact } = await svc.upsert_contact({ name: "Wa Person", identities: [{ kind: "whatsapp", value: "+84 901 234 567" }] });
    const masked = (await svc.get_contact({ id: contact.id })).identities.find((i) => i.kind === "whatsapp")!;
    expect(masked.value).not.toContain("1234");
    expect(masked).toMatchObject({ private: true });
    expect((await svc.get_contact({ id: contact.id, include_private: true })).identities[0]!.value).toBe("+84901234567");
    const csvMasked = (await svc.export_csv({})).csv;
    expect(csvMasked).not.toContain("+84901234567");
    expect(csvMasked).toContain("whatsapp:+849");
    expect((await svc.export_csv({ include_private: true })).csv).toContain("whatsapp:+84901234567");
    const member = new CrmService(db, { ...ctx, role: "member" });
    await expect(member.get_contact({ id: contact.id, include_private: true })).rejects.toThrow(/admin/);
    await expect(member.export_csv({ include_private: true })).rejects.toThrow(/admin/);
    expect((await member.find_by_identity({ value: "wa:+84901234567" })).identity.value).not.toContain("1234");
    expect(JSON.stringify(await svc.daily_overview({}))).not.toContain("+84901234567");
  });
});

describe("custom channels", () => {
  it("adds a runtime channel usable for identities, imports, states and follow-ups", async () => {
    const { svc, ctx } = await makeOrg();
    const viewer = new CrmService(db, { ...ctx, role: "viewer", scopes: ["crm:read"] });
    const member = new CrmService(db, { ...ctx, role: "member" });
    await expect(member.add_custom_channel({ id: "mastodon", label: "Mastodon" })).rejects.toThrow(/admin/);
    await expect(svc.add_custom_channel({ id: "x2", label: "Bad", prefix: "x" })).rejects.toThrow(/collides/);
    await svc.add_custom_channel({ id: "mastodon", label: "Mastodon", url_pattern: "https://mastodon.social/@{handle}", prefix: "masto", followup_days: 9, stale_days: 20 });
    const listed = (await viewer.list_channels()).channels.find((c) => c.id === "mastodon");
    expect(listed).toMatchObject({ custom: true, followup_days: 9, stale_days: 20, prefixes: ["masto"] });
    expect((await svc.get_followup_rules({})).followup_days.mastodon).toBe(9);

    const { contact } = await svc.upsert_contact({ identities: [{ kind: "mastodon", value: "https://mastodon.social/@Alice" }], source: "mastodon" });
    expect(contact.source).toBe("mastodon");
    expect((await svc.find_by_identity({ value: "masto:alice" })).contacts[0]!.id).toBe(contact.id);
    const imp = await svc.import_leads_csv({ csv: "handle,name\nmasto:alice,Alice\nhttps://mastodon.social/@bob,Bob\n", dry_run: false });
    expect(imp).toMatchObject({ created: 1, updated: 1 });
    expect((await svc.find_by_identity({ value: "https://mastodon.social/@bob" })).contacts[0]).toMatchObject({ name: "Bob", source: "mastodon" });

    await svc.log_touch({ contact_id: contact.id, channel: "mastodon", sent_at: "2026-11-04T03:00:00Z" });
    const st = (await svc.get_contact({ id: contact.id })).channel_states.find((s) => s.channel === "mastodon")!;
    expect(st.stage).toBe("contacted");
    expect(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Saigon" }).format(st.nextFollowupAt!)).toBe("2026-11-13");
    await expect(svc.set_channel_state({ contact_id: contact.id, channel: "nope", stage: "contacted" })).rejects.toThrow(/unknown channel/);
    await expect(svc.upsert_contact({ name: "Z", source: "nope" })).rejects.toThrow(/unknown source/);
    // other orgs don't see it
    const { svc: other } = await makeOrg();
    await expect(other.set_channel_state({ contact_id: contact.id, channel: "mastodon", stage: "contacted" })).rejects.toThrow(/unknown channel/);
  });
});
