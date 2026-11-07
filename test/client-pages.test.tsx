import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ProfileLinks } from "../src/client/components/profile-links";
import { LEAD_STAGES, stageCount } from "../src/client/lib/constants";
import { ContactName } from "../src/client/pages/contacts";
import { IdentityProfiles } from "../src/client/pages/contact-detail";
import { makeOrg } from "./helpers";

describe("SPA rendering", () => {
  it("escapes script-bearing profile values and drops non-http(s) hrefs", () => {
    const html = renderToStaticMarkup(
      <ProfileLinks
        identities={[
          { kind: "x_handle", channel: "x", label: "X", value: "Olga <script>alert(1)</script>", url: "javascript:alert(1)" },
          { kind: "slack_user", channel: "slack_community", label: "Slack community", value: "U12345678", url: null },
        ]}
      />,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
  });

  it("renders contact profiles with masked private values and only safe links", () => {
    const html = renderToStaticMarkup(
      <IdentityProfiles
        identities={[
          { kind: "whatsapp", channel: "whatsapp", label: "WhatsApp", value: "+141******23", private: true, url: null },
          { kind: "x_handle", channel: "x", label: "X", value: "jane", url: "javascript:alert(1)" },
          { kind: "slack_user", channel: "slack_community", label: "Slack community", value: "U12345678", url: null },
        ]}
      />,
    );
    expect(html).toContain("+141******23");
    expect(html).toContain("Slack community");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a ");
  });

  it("escapes script-bearing contact names in list rows", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ContactName
          contact={{
            id: "c1",
            name: "Olga <script>alert(1)</script>",
            email: "olga@acme.dev",
            role: null,
            contactType: "lead",
            stage: "new",
            lifecycle: "lead",
            identities: [],
          }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("derives the Overview counts from the full contact population, matching the pipeline", async () => {
    const { svc } = await makeOrg();
    const { contact } = await svc.upsert_contact({ x_handle: "overview_probe", name: "Overview Probe" });
    await svc.update_stage({ contact_id: contact.id, stage: "paying" });
    // Competitors are not outreach leads but still belong to the pipeline counts.
    await svc.upsert_contact({ x_handle: "overview_rival", name: "Overview Rival", contact_type: "competitor" });

    const overview = await svc.daily_overview({});
    const pipeline = await svc.pipeline_summary();
    expect(overview.stages.new).toBe(1);
    expect(stageCount(overview.stages, LEAD_STAGES)).toBe(1);
    expect(stageCount(overview.stages, LEAD_STAGES)).toBe(pipeline.lifecycles.lead);
    expect(stageCount(overview.stages)).toBe(2);
    expect(stageCount(overview.stages)).toBe(pipeline.total);
  });
});
