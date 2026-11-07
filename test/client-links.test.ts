import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Link, MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ARCHIVED_STAGES, CONTACT_STAGES, LEAD_STAGES, STAGES } from "../src/client/lib/constants";
import { contactHref, contactHrefById, stageHref } from "../src/client/lib/links";
import { STAGES as SERVER_STAGES } from "../src/db/schema";
import { contactListFilters, paramsForView, stageForView, stagesForView, viewFromParams } from "../src/client/lib/views";

describe("client detail links", () => {
  it("uses the server's stage definitions instead of a second copy", () => {
    expect(STAGES).toBe(SERVER_STAGES);
  });

  it("keeps detail links inside the contact's lifecycle", () => {
    expect(contactHrefById("c1", "lead")).toBe("/leads/c1");
    expect(contactHrefById("c1", "contact")).toBe("/contacts/c1");
    expect(contactHrefById("c1", "archived")).toBe("/contacts/c1");
    expect(contactHrefById("c1")).toBe("/leads/c1");
    expect(contactHref({ id: "c2", lifecycle: "contact" })).toBe("/contacts/c2");
    expect(contactHref({ id: "c2", lifecycle: "lead" })).toBe("/leads/c2");
  });

  it("routes stage links by the stage's lifecycle", () => {
    for (const stage of LEAD_STAGES) expect(stageHref(stage)).toBe(`/leads?stage=${stage}`);
    for (const stage of CONTACT_STAGES) expect(stageHref(stage)).toBe(`/contacts?stage=${stage}`);
    for (const stage of ARCHIVED_STAGES) expect(stageHref(stage)).toBe(`/contacts?view=archived&stage=${stage}`);
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Link, { to: stageHref("paying") }, "Paying")));
    expect(html).toContain('href="/contacts?stage=paying"');
  });
});

describe("contacts list view URL state", () => {
  it("derives lead/relationship/archived views from the route and query", () => {
    expect(viewFromParams("lead", new URLSearchParams())).toBe("lead");
    expect(viewFromParams("lead", new URLSearchParams("view=archived"))).toBe("lead");
    expect(viewFromParams("contact", new URLSearchParams())).toBe("contact");
    expect(viewFromParams("contact", new URLSearchParams("view=archived"))).toBe("archived");
  });

  it("validates stages against the selected view", () => {
    expect(stagesForView("lead")).toBe(LEAD_STAGES);
    expect(stagesForView("contact")).toBe(CONTACT_STAGES);
    expect(stagesForView("archived")).toBe(ARCHIVED_STAGES);
    expect(stageForView("contact", "responded")).toBe("responded");
    expect(stageForView("contact", "paying")).toBe("paying");
    expect(stageForView("archived", "responded")).toBeUndefined();
    expect(stageForView("lead", "lost")).toBeUndefined();
    expect(stageForView("lead", null)).toBeUndefined();
  });

  it("clears a cross-lifecycle stage when the tab changes and preserves unrelated filters", () => {
    const fromRelationships = new URLSearchParams("stage=responded&query=acme");
    expect(paramsForView(fromRelationships, "archived").toString()).toBe("query=acme&view=archived");
    expect(paramsForView(new URLSearchParams("stage=lost"), "contact").toString()).toBe("");
    expect(paramsForView(new URLSearchParams("stage=responded"), "lead").toString()).toBe("");
    expect(paramsForView(new URLSearchParams("stage=paying&view=archived"), "contact").toString()).toBe("stage=paying");
    expect(paramsForView(new URLSearchParams("stage=lost&view=archived"), "archived").toString()).toBe("stage=lost&view=archived");
  });

  it("sends the stage as channel_stage when a channel filter is active", () => {
    const byChannel = contactListFilters("lead", new URLSearchParams("channel=linkedin&stage=connected&source=x&campaign=c1&query=acme"));
    expect(byChannel).toMatchObject({ lifecycle: "lead", channel: "linkedin", channel_stage: "connected", source: "x", campaign_id: "c1", query: "acme" });
    expect(byChannel.stage).toBeUndefined();

    const overall = contactListFilters("lead", new URLSearchParams("stage=connected"));
    expect(overall.stage).toBe("connected");
    expect(overall.channel_stage).toBeUndefined();
    expect(overall.channel).toBeUndefined();
  });
});
