import { describe, expect, it } from "vitest";
import { ChannelRegistry, profileUrl, websiteUrl } from "../src/channels";
import { lifecycleCounts, lifecycleOf, stagesForLifecycle } from "../src/lifecycle";
import { makeOrg } from "./helpers";

describe("lead vs contact lifecycle", () => {
  it("derives lifecycle from the pipeline stage", () => {
    for (const stage of ["new", "qualified", "drafted", "contacted", "connection_pending", "connected"]) expect(lifecycleOf(stage)).toBe("lead");
    for (const stage of ["responded", "call_booked", "pilot", "paying"]) expect(lifecycleOf(stage)).toBe("contact");
    for (const stage of ["lost", "do_not_contact"]) expect(lifecycleOf(stage)).toBe("archived");
    expect(lifecycleOf(undefined)).toBe("lead");
  });

  it("maps lifecycle back to stage groups and counts", () => {
    expect(stagesForLifecycle("lead")).toEqual(["new", "qualified", "drafted", "contacted", "connection_pending", "connected"]);
    expect(stagesForLifecycle("contact")).toEqual(["responded", "call_booked", "pilot", "paying"]);
    expect(stagesForLifecycle("archived")).toEqual(["lost", "do_not_contact"]);
    expect(lifecycleCounts({ new: 2, connected: 1, responded: 3, pilot: 1, lost: 2 })).toEqual({ lead: 3, contact: 4, archived: 2, total: 9 });
  });

  it("splits list results and keeps counts across the split", async () => {
    const { svc } = await makeOrg();
    const lead = await svc.upsert_contact({ x_handle: "lead_one", name: "Lead One", source: "x" });
    const contact = await svc.upsert_contact({ email: "contact@acme.dev", name: "Contact One" });
    await svc.update_stage({ contact_id: contact.contact.id, stage: "responded" });
    const archived = await svc.upsert_contact({ github: "archived-one", name: "Archived One" });
    await svc.update_stage({ contact_id: archived.contact.id, stage: "lost" });

    expect((await svc.list_contacts({ lifecycle: "lead" })).map((c) => c.id)).toEqual([lead.contact.id]);
    expect((await svc.list_contacts({ lifecycle: "contact" })).map((c) => c.id)).toEqual([contact.contact.id]);
    expect((await svc.list_contacts({ lifecycle: "archived" })).map((c) => c.id)).toEqual([archived.contact.id]);

    const view = await svc.list_contacts_view({});
    expect(view.counts).toMatchObject({ lead: 1, contact: 1, archived: 1, total: 3 });
    expect(view.contacts.find((c) => c.id === lead.contact.id)?.lifecycle).toBe("lead");
    expect(view.contacts.find((c) => c.id === contact.contact.id)?.lifecycle).toBe("contact");
    expect((await svc.pipeline_summary()).lifecycles).toMatchObject({ lead: 1, contact: 1, archived: 1 });
  });
});

describe("profile URL builder", () => {
  it("builds every registry profile URL", () => {
    expect(profileUrl("x_handle", "jane")).toBe("https://x.com/jane");
    expect(profileUrl("linkedin_url", "linkedin.com/in/jane")).toBe("https://linkedin.com/in/jane");
    expect(profileUrl("reddit_user", "jane_dev")).toBe("https://www.reddit.com/user/jane_dev");
    expect(profileUrl("github", "janedev")).toBe("https://github.com/janedev");
    expect(profileUrl("threads_handle", "jane.dev")).toBe("https://www.threads.com/@jane.dev");
    expect(profileUrl("email", "jane@acme.dev")).toBe("mailto:jane@acme.dev");
    expect(profileUrl("hn_user", "pg")).toBe("https://news.ycombinator.com/user?id=pg");
    expect(profileUrl("bsky_handle", "jane.bsky.social")).toBe("https://bsky.app/profile/jane.bsky.social");
    expect(profileUrl("telegram", "jane")).toBe("https://t.me/jane");
    expect(profileUrl("youtube", "@jane")).toBe("https://www.youtube.com/@jane");
    expect(profileUrl("whatsapp", "+14155550123")).toBe("https://wa.me/14155550123");
    expect(profileUrl("slack_user", "U12345678", "acme")).toBe("https://acme.slack.com/team/U12345678");
    expect(profileUrl("discord_user", "123456789012345678")).toBe("https://discord.com/users/123456789012345678");
    expect(profileUrl("not_a_kind", "x")).toBeNull();
  });

  it("uses org custom channel URL patterns", () => {
    const reg = new ChannelRegistry([{ id: "mastodon", label: "Mastodon", urlPattern: "mastodon.social/@{handle}", prefix: "masto" }]);
    expect(reg.profileUrl("mastodon", "alice")).toBe("https://mastodon.social/@alice");
  });

  it("normalizes website/domain links", () => {
    expect(websiteUrl("acme.dev")).toBe("https://acme.dev");
    expect(websiteUrl("https://acme.dev/about")).toBe("https://acme.dev/about");
    expect(websiteUrl("//acme.dev")).toBe("https://acme.dev");
    expect(websiteUrl("")).toBeNull();
  });

  it("masks whatsapp in identity views unless an admin asks to reveal it", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ identities: [{ kind: "whatsapp", value: "+14155550123" }], name: "Phone Person" });
    const masked = await svc.get_contact({ id: contact.id });
    const phone = masked.identities.find((i) => i.kind === "whatsapp")!;
    expect(phone.value).not.toContain("4155550123");
    expect(phone.url).toBeNull();

    const revealed = await svc.get_contact({ id: contact.id, include_private: true });
    const visible = revealed.identities.find((i) => i.kind === "whatsapp")!;
    expect(visible.value).toBe("+14155550123");
    expect(visible.url).toBe("https://wa.me/14155550123");
  });
});
