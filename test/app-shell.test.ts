import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { serveApp } from "../src/index";

const indexHtml = '<!doctype html><html><body><script type="module" src="/assets/app-123.js"></script></body></html>';

/** The vitest env has no ASSETS binding, so exercise the real serveApp with a stub fetcher. */
describe("dashboard app shell", () => {
  it("serves index.html through the ASSETS binding and keeps the HTML headers", async () => {
    const requested: string[] = [];
    const env = {
      ASSETS: {
        fetch: async (input: RequestInfo | URL) => {
          requested.push(String(input));
          return new Response(indexHtml, { status: 200, headers: { "content-type": "text/plain", "cache-control": "public, max-age=3600" } });
        },
      },
    } as unknown as Env;

    const res = await serveApp({ env, req: { url: "http://localhost/dashboard/leads?stage=new", raw: new Request("http://localhost/dashboard/leads?stage=new") } });
    expect(await res.text()).toBe(indexHtml);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(requested).toEqual(["http://localhost/"]);
  });

  it("serves the SPA entrypoint without depending on the /index.html -> / redirect", async () => {
    const requested: string[] = [];
    const env = {
      ASSETS: {
        fetch: async (input: RequestInfo | URL) => {
          requested.push(String(input));
          const url = new URL(String(input));
          // Mirror the real ASSETS binding: /index.html redirects, / serves the HTML.
          if (url.pathname === "/index.html") return new Response(null, { status: 307, headers: { location: "/" } });
          if (url.pathname === "/") return new Response(indexHtml, { status: 200, headers: { "content-type": "text/html" } });
          return new Response("not found", { status: 404 });
        },
      },
    } as unknown as Env;

    const res = await serveApp({ env, req: { url: "http://localhost/dashboard", raw: new Request("http://localhost/dashboard") } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(indexHtml);
    expect(requested).toEqual(["http://localhost/"]);
    expect(requested).not.toContain("http://localhost/index.html");
  });

  it("falls back to the diagnostic shell when the asset is missing", async () => {
    const env = { ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } } as unknown as Env;
    const res = await serveApp({ env, req: { url: "http://localhost/dashboard", raw: new Request("http://localhost/dashboard") } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The CRM client is not built");
  });
});
