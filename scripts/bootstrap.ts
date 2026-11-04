/**
 * Create a user, an organization and an org-owned API key against a running
 * dev server (default http://localhost:5173). Prints the key once.
 * The key gets role "admin" (--role to change) so the agent can manage the blocklist and campaigns.
 *
 *   bun scripts/bootstrap.ts --email me@example.com --password 'long-password' --org "Acme"
 */
const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : def;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
};
const base = arg("url", process.env.BETTER_AUTH_URL ?? "http://localhost:5173");
const email = arg("email");
const password = arg("password");
const orgName = arg("org", "My Org");
const keyRole = arg("role", "admin");
const slug = arg("slug", orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-"));

let cookie = "";
async function call(path: string, body: unknown) {
  const res = await fetch(`${base}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, ...(cookie && { cookie }) },
    body: JSON.stringify(body),
  });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (set.length) cookie = set.join("; ");
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json as Record<string, any>;
}

let signedIn = await call("/sign-up/email", { email, password, name: email.split("@")[0] }).catch(() => null);
if (!signedIn) signedIn = await call("/sign-in/email", { email, password });
const org = await call("/organization/create", { name: orgName, slug });
// Key role lives in server-only metadata, so create it through the CRM tool (session cookie, owner).
const keyRes = await fetch(`${base}/v1/create_api_key`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie, "x-org-id": org.id },
  body: JSON.stringify({ name: "bootstrap-agent", role: keyRole }),
});
const created = (await keyRes.json()) as Record<string, any>;
if (!keyRes.ok) throw new Error(`create_api_key -> ${keyRes.status} ${JSON.stringify(created)}`);
const key = { key: created.secret as string };

console.log(JSON.stringify({ org_id: org.id, api_key: key.key }, null, 2));
console.log(`\nTry: curl -s ${base}/v1/pipeline_summary -X POST -H 'x-api-key: ${key.key}' -d '{}'`);
export {};
