// Deliberately tiny: MCP is the primary interface. These pages exist only so an
// interactive MCP client can complete the OAuth login + consent redirect.
const shell = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:15px system-ui;max-width:440px;margin:10vh auto;padding:0 16px}input,button{display:block;width:100%;margin:8px 0;padding:8px;font:inherit}pre{background:#f4f4f4;padding:8px}</style>
</head><body>${body}</body></html>`;

export const homePage = () =>
  shell("Outreach CRM", `<h1>Outreach CRM</h1><p>Agent-first CRM. Connect an MCP client to <code>/mcp</code>, or call <code>POST /v1/&lt;tool&gt;</code> with an API key.</p>`);

export const signInPage = () =>
  shell(
    "Sign in",
    `<h1>Sign in</h1><form id="f"><input name="email" type="email" placeholder="email" required><input name="password" type="password" placeholder="password" required><button>Sign in</button></form><pre id="e"></pre>
<script>
f.onsubmit = async (ev) => {
  ev.preventDefault();
  const d = Object.fromEntries(new FormData(f));
  const r = await fetch("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify({ ...d, oauth_query: location.search.slice(1) || undefined }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { e.textContent = JSON.stringify(j); return; }
  location.href = j.url || j.redirect_uri || "/";
};
</script>`,
  );

export const consentPage = () =>
  shell(
    "Authorize",
    `<h1>Authorize client</h1><p>Client <b id="c"></b> wants: <code id="s"></code></p><button id="y">Allow</button><button id="n">Deny</button><pre id="e"></pre>
<script>
const q = new URLSearchParams(location.search); c.textContent = q.get("client_id"); s.textContent = q.get("scope");
const send = async (accept) => {
  const r = await fetch("/api/auth/oauth2/consent", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
    body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }) });
  const j = await r.json().catch(() => ({}));
  if (j.url || j.redirect_uri) location.href = j.url || j.redirect_uri; else e.textContent = JSON.stringify(j);
};
y.onclick = () => send(true); n.onclick = () => send(false);
</script>`,
  );
