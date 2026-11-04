import { describe, expect, it } from "vitest";
import { makeOrg } from "./helpers";
import { parseImportRow, profileKind } from "../src/service";
import { parseCsv } from "../src/csv";

const HEADER = "handle,name,profile_url,bio_summary,followers,company,role,est_team_size,signal_post_url,signal_post_date,signal_summary,score,source,status,first_seen,notes";

describe("post-import fixes", () => {
  it("non-social profile_url: handle is not an X handle, site kept as website + company domain", () => {
    expect(profileKind("https://vaon.com.vn")).toBe("site");
    expect(profileKind("https://x.com/a")).toBe("x");
    const p = parseImportRow({ handle: "vaon", name: "VAON", profile_url: "https://vaon.com.vn", source: "web" });
    expect(p.ids.xHandle).toBeNull();
    expect(p).toMatchObject({ website: "https://vaon.com.vn", profileUrl: "https://vaon.com.vn", companyDomain: "vaon.com.vn", source: "web" });
    // explicit @ still means X
    expect(parseImportRow({ handle: "@vaon", profile_url: "https://vaon.com.vn" }).ids.xHandle).toBe("vaon");
  });

  it("ambiguous sources follow the profile_url", () => {
    expect(parseImportRow({ handle: "jo", profile_url: "https://x.com/jo", source: "handoff_grokbot" })).toMatchObject({ source: "x", sourceDetail: "handoff_grokbot", ids: { xHandle: "jo" } });
    expect(parseImportRow({ profile_url: "https://www.linkedin.com/in/jo-l", source: "web" }).source).toBe("linkedin");
    expect(parseImportRow({ profile_url: "https://reddit.com/user/jo_r" }).source).toBe("reddit");
    expect(parseImportRow({ handle: "@jo", profile_url: "https://linkedin.com/in/jo", source: "x" }).source).toBe("x");
  });

  it("handle prefixes li:, x:, gh:, reddit:", () => {
    expect(parseImportRow({ handle: "li:mikel-lindsaar" }).ids).toMatchObject({ linkedin: "linkedin.com/in/mikel-lindsaar", xHandle: null });
    expect(parseImportRow({ handle: "x:@TorstenLink" }).ids.xHandle).toBe("torstenlink");
    expect(parseImportRow({ handle: "gh:octo-cat" }).ids.github).toBe("octo-cat");
    expect(parseImportRow({ handle: "reddit:some_user" }).ids.redditUser).toBe("some_user");
  });

  it("export keeps raw profile_url and has a stage column; upsert can pin + clear", async () => {
    const { svc } = await makeOrg();
    await svc.import_leads_csv({ csv: [HEADER, "vaon,VAON,https://vaon.com.vn/,,,,,,,,,,web,warm,,", "jo,Jo,https://twitter.com/Jo?s=20,,,,,,,,,,handoff_grokbot,new,,"].join("\n"), dry_run: false });
    const exp = await svc.export_csv({});
    const rows = parseCsv(exp.csv);
    const head = rows[0]!;
    expect(head).toContain("stage");
    expect(head).toContain("status");
    const byName = (n: string) => rows.find((r) => r[1] === n)!;
    expect(byName("VAON")[2]).toBe("https://vaon.com.vn/");
    expect(byName("Jo")[2]).toBe("https://twitter.com/Jo?s=20");
    expect(byName("VAON")[head.indexOf("stage")]).toBe("responded");
    expect(byName("VAON")[head.indexOf("company_domain")]).toBe("vaon.com.vn");
    const derived = parseCsv((await svc.export_csv({ derived_profile_url: true })).csv);
    expect(derived.find((r) => r[1] === "Jo")![2]).toBe("https://x.com/jo");

    const jo = (await svc.upsert_contact({ x_handle: "jo" })).contact;
    const r = await svc.upsert_contact({ contact_id: jo.id, clear: ["x_handle"], linkedin_url: "li-jo", idempotency_key: "repair-jo-1" });
    expect(r.contact).toMatchObject({ xHandle: null, linkedin: "linkedin.com/in/li-jo" });
    const vaon = (await svc.upsert_contact({ name: "VAON2", x_handle: "vaon2" })).contact;
    const r2 = await svc.upsert_contact({ contact_id: vaon.id, clear: ["x_handle"], website: "https://vaon.com.vn", profile_url: "https://vaon.com.vn", idempotency_key: "repair-vaon-1" });
    expect(r2.contact).toMatchObject({ xHandle: null, website: "https://vaon.com.vn", name: "VAON2" });
  });
});
