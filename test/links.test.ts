import { describe, expect, it } from "vitest";
import { externalUrl } from "../src/channels";
import { safeExternalUrl } from "../src/client/lib/utils";
import { parseImportRow } from "../src/service";
import { makeOrg } from "./helpers";

describe("stored URL allow-list", () => {
  it("normalizes http(s) and rejects other schemes", () => {
    expect(externalUrl("https://x.com/a")).toBe("https://x.com/a");
    expect(externalUrl("example.com/post")).toBe("https://example.com/post");
    expect(externalUrl("//example.com/post")).toBe("https://example.com/post");
    expect(externalUrl("mailto:a@b.dev?subject=hi")).toBe("mailto:a@b.dev?subject=hi");
    expect(externalUrl("javascript:alert(1)")).toBeNull();
    expect(externalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(externalUrl("file:///etc/passwd")).toBeNull();

    expect(safeExternalUrl("https://x.com/a")).toBe("https://x.com/a");
    expect(safeExternalUrl("mailto:a@b.dev")).toBe("mailto:a@b.dev");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,hi")).toBeNull();
  });

  it("rejects unsafe write payloads and normalizes safe ones", async () => {
    const { svc } = await makeOrg();
    await expect(svc.upsert_contact({ x_handle: "evil", signal_post_url: "javascript:alert(1)" })).rejects.toThrow(/http\(s\)/);
    const saved = await svc.upsert_contact({ x_handle: "safe", signal_post_url: "example.com/post" });
    expect(saved.contact.signalPostUrl).toBe("https://example.com/post");
    const blank = await svc.upsert_contact({ x_handle: "blank", signal_post_url: "" });
    expect(blank.contact.signalPostUrl).toBeNull();

    const { contact } = saved;
    await expect(svc.create_draft({ contact_id: contact.id, channel: "x", text: "hi", intent_url: "data:text/html,<script>alert(1)</script>" })).rejects.toThrow(/http\(s\)/);
    const draft = await svc.create_draft({ contact_id: contact.id, channel: "x", text: "ok", intent_url: "https://x.com/intent/post?text=ok" });
    expect(draft.intentUrl).toBe("https://x.com/intent/post?text=ok");
  });

  it("drops unsafe signal URLs from CSV imports with a warning", () => {
    const warnings: string[] = [];
    const row = parseImportRow({ handle: "@csv", signal_post_url: "javascript:alert(1)" }, warnings);
    expect(row.signalUrl).toBeNull();
    expect(warnings.join(" ")).toContain("signal_post_url");
    expect(parseImportRow({ handle: "@csv", signal_post_url: "news.ycombinator.com/item?id=1" }).signalUrl).toBe("https://news.ycombinator.com/item?id=1");
  });
});
