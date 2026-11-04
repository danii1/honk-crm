import { describe, expect, it } from "vitest";
import { makeOrg } from "./helpers";
import { mapSource, parseImportRow, parseTeamSize } from "../src/service";
import { mapStatus } from "../src/csv";
import { normalizeRedditUser } from "../src/normalize";
import { matchBlocklist, normalizeBlockValue } from "../src/rules";

const HEADER = "handle,name,profile_url,bio_summary,followers,company,role,est_team_size,signal_post_url,signal_post_date,signal_summary,score,source,status,first_seen,notes";

describe("sales outbound dry-run feedback", () => {
  it("reddit refs normalize to reddit users, never names or x handles", () => {
    for (const v of ["u/Vizouru", "/u/vizouru", "https://www.reddit.com/user/vizouru/", "reddit.com/u/vizouru"]) {
      expect(normalizeRedditUser(v)).toBe("vizouru");
      expect(normalizeBlockValue(undefined, v)).toEqual({ kind: "handle", value: "vizouru" });
    }
    const p = parseImportRow({ handle: "u/vizouru", name: "Viz", source: "x" });
    expect(p.ids).toMatchObject({ redditUser: "vizouru", xHandle: null });
    expect(parseImportRow({ handle: "vizouru", source: "reddit_thread" }).ids).toMatchObject({ redditUser: "vizouru", xHandle: null });
  });

  it("add_competitor with u/name stores a reddit handle, not 'u name'", async () => {
    const { svc } = await makeOrg();
    const e = await svc.add_competitor({ value: "u/vizouru" });
    expect(e).toMatchObject({ kind: "handle", value: "vizouru" });
  });

  it("maps free-form sources and keeps the raw value", () => {
    const cases: Record<string, string> = {
      reddit_comment: "reddit", prowlo_scan: "reddit", "via-reddit": "reddit", Email_list: "email", "LinkedIn Post": "linkedin",
      x_reply: "x", Twitter: "x", handoff_partner: "web", website: "web",
    };
    for (const [raw, want] of Object.entries(cases)) expect(mapSource(raw)).toBe(want);
    const w: string[] = [];
    const p = parseImportRow({ handle: "jane@corp.io", source: "Email_list" }, w);
    expect(p).toMatchObject({ source: "email", sourceDetail: "Email_list", channel: "email" });
    expect(w).toEqual([]);
  });

  it("est_team_size: ranges to midpoint, text kept, no warnings", () => {
    expect(parseTeamSize("5-10")).toEqual({ estTeamSize: 8, estTeamSizeText: "5-10" });
    expect(parseTeamSize("12")).toEqual({ estTeamSize: 12, estTeamSizeText: null });
    expect(parseTeamSize("solo founder")).toEqual({ estTeamSize: null, estTeamSizeText: "solo founder" });
    const w: string[] = [];
    parseImportRow({ handle: "@a", est_team_size: "small team" }, w);
    expect(w).toEqual([]);
  });

  it("scores above 5 rescale with one summary notice; warm -> responded", async () => {
    expect(parseImportRow({ handle: "@a", score: "10" })).toMatchObject({ score: 5, scoreOriginal: "10" });
    expect(parseImportRow({ handle: "@a", score: "1" })).toMatchObject({ score: 1, scoreOriginal: null });
    expect(parseImportRow({ handle: "@a", score: "6" }).score).toBe(3);
    expect(mapStatus("warm")).toMatchObject({ stage: "responded", known: true });
    const { svc } = await makeOrg();
    const csv = [HEADER, "@a1,A1,,,,,,5-10,,,,8,x,warm,,", "@a2,A2,,,,,,tiny,,,,7,x,new,,"].join("\n");
    const r = await svc.import_leads_csv({ csv, dry_run: false });
    expect(r.notices).toHaveLength(1);
    expect(r.rows.flatMap((x) => x.warnings)).toEqual([]);
    const c = await svc.list_contacts({});
    expect(JSON.stringify(c)).toMatch(/"estTeamSizeText":"5-10"/);
  });

  it("u/name row does not merge into an x contact with the same name", async () => {
    const { svc } = await makeOrg();
    await svc.import_leads_csv({ csv: [HEADER, "@vizouru,vizouru,,,,,,,,,,,x,new,,"].join("\n"), dry_run: false });
    const r = await svc.import_leads_csv({ csv: [HEADER, "u/vizouru,vizouru,,,,,,,,,,,reddit_post,new,,"].join("\n"), dry_run: false });
    expect(r.created).toBe(1);
  });

  it("generic short competitor names match exactly only", async () => {
    const { svc } = await makeOrg();
    const station = await svc.add_competitor({ value: "Station", kind: "name" });
    expect(station.match).toBe("exact");
    const fuzzy = await svc.add_competitor({ value: "Coral", kind: "name", match: "fuzzy" });
    expect(fuzzy.match).toBe("fuzzy");
    expect((await svc.add_competitor({ value: "Factory AI", kind: "name" })).match).toBe("fuzzy");
    const entries = await svc.list_competitors();
    const probe = (company: string, person = "") => matchBlocklist(entries, { personNames: [person], companyNames: [company], handles: [], domains: [] }).map((h) => h.entry.value);
    expect(probe("Station")).toEqual(["station"]);
    expect(probe("Gas Station Labs", "Station")).toEqual([]);
    expect(probe("Coral Reef Co")).toEqual(["coral"]);
    expect(probe("Big Factory Shop")).toEqual(["factory"]);
  });

  it("purge_competitors lists then deletes by regex", async () => {
    const { svc } = await makeOrg();
    await svc.add_competitor({ value: "u junk", kind: "name" });
    await svc.add_competitor({ value: "u otherone", kind: "name" });
    await svc.add_competitor({ value: "Unity", kind: "name" });
    const dry = await svc.purge_competitors({ value_regex: "^u [a-z0-9_-]+$" });
    expect(dry).toMatchObject({ dry_run: true, count: 2 });
    const done = await svc.purge_competitors({ value_regex: "^u [a-z0-9_-]+$", dry_run: false });
    expect(done.count).toBe(2);
    expect((await svc.list_competitors()).map((e) => e.value)).toEqual(["unity"]);
    const { svc: viewer } = await makeOrg(["crm:read"], "member");
    await expect(viewer.purge_competitors({ ids: ["x"] })).rejects.toThrow();
  });
});
