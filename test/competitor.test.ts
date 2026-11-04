import { describe, expect, it } from "vitest";
import { makeOrg } from "./helpers";
import { matchBlocklist } from "../src/rules";

describe("competitor matching", () => {
  it("exact entries match name or company equally; person names containing the word don't", async () => {
    const { svc } = await makeOrg();
    for (const v of ["Drover", "Station", "Orca"]) await svc.add_competitor({ value: v, kind: "name" });
    for (const v of ["Drover", "Station", "Orca"]) {
      expect((await svc.is_competitor({ name: v })).is_competitor).toBe(true);
      expect((await svc.is_competitor({ company: v })).is_competitor).toBe(true);
    }
    expect((await svc.is_competitor({ company: "Station Labs Ltd" })).is_competitor).toBe(true);
    expect((await svc.is_competitor({ name: "John Station" })).is_competitor).toBe(false);
    expect((await svc.is_competitor({ company: "Gas Station" })).is_competitor).toBe(false);
    expect((await svc.is_competitor({ name: "Orca Whale" })).is_competitor).toBe(false);
  });

  it("stores the full display name; fuzzy never broader than the full name", async () => {
    const { svc } = await makeOrg();
    const c = await svc.add_competitor({ value: "Concord AI", kind: "name" });
    const o = await svc.add_competitor({ value: "Orchestrator.inc", kind: "name" });
    expect(c).toMatchObject({ value: "concord ai", displayName: "Concord AI", match: "fuzzy" });
    expect(o).toMatchObject({ value: "orchestrator inc", displayName: "Orchestrator.inc" });
    const entries = await svc.list_competitors();
    const hit = (company: string, person = "") => matchBlocklist(entries, { personNames: [person], companyNames: [company], handles: [], domains: [] }).map((h) => h.entry.displayName);
    expect(hit("Concord AI Platform")).toEqual(["Concord AI"]);
    expect(hit("Concord")).toEqual(["Concord AI"]); // suffix-stripped equality
    expect(hit("Concord Health")).toEqual([]);
    expect(hit("Orchestrator")).toEqual(["Orchestrator.inc"]);
    expect(hit("Cloud Agent Orchestrator")).toEqual([]);
  });

  it("update_competitor restores names and switches match, logged", async () => {
    const { svc } = await makeOrg();
    const e = await svc.add_competitor({ value: "Workbench", kind: "name" });
    expect(e.match).toBe("fuzzy");
    const u = await svc.update_competitor({ id: e.id, match: "exact", idempotency_key: "upd-wb-1", reason: "too generic" });
    expect(u!.match).toBe("exact");
    expect((await svc.is_competitor({ company: "Workbench Studio" })).is_competitor).toBe(false);
    const r = await svc.update_competitor({ id: e.id, value: "Workbench Inc" });
    expect(r).toMatchObject({ value: "workbench inc", displayName: "Workbench Inc", match: "exact" });
    const { svc: viewer } = await makeOrg(["crm:read"], "member");
    await expect(viewer.update_competitor({ id: e.id, match: "fuzzy" })).rejects.toThrow();
  });
});
