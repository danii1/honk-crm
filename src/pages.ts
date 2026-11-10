import themeCss from "./theme.css?raw";
import pageCss from "./pages.css?raw";

const shell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · Honk</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" href="/honk-goose.png">
<script>try{if(localStorage.getItem("crm-theme")==="dark"||(!localStorage.getItem("crm-theme")&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch{}</script>
<style>${themeCss}\n${pageCss}</style></head><body><main class="auth-layout">
<section class="panel"><header class="brand"><img class="brand-mark" src="/honk-goose.png" alt=""><div><p class="brand-name">Honk</p><p class="brand-caption">Sales workspace</p></div></header>
${body}</section></main></body></html>`;

export const homePage = () =>
  shell("Welcome", `<h1>Welcome to Honk</h1><p class="intro">Your outreach workspace.</p>`);

export const signInPage = () =>
  shell(
    "Sign in",
    `<h1>Sign in</h1><p class="intro">Pick up where your outreach left off.</p>
<form id="f"><label>Email<input name="email" type="email" autocomplete="username" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button></form><p class="error" id="e" role="alert" hidden></p>
<script>
const f = document.getElementById("f"), e = document.getElementById("e"), submit = f.querySelector("button");
const nx = new URLSearchParams(location.search).get("next");
const next = nx && nx.startsWith("/") && !nx.startsWith("//") ? nx : null;
f.onsubmit = async (ev) => {
  ev.preventDefault(); e.hidden = true; submit.disabled = true;
  try {
    const d = Object.fromEntries(new FormData(f));
    const r = await fetch("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
      body: JSON.stringify({ ...d, oauth_query: next ? undefined : location.search.slice(1) || undefined }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { e.textContent = j.message || j.error || "Sign in failed. Check your email and password."; e.hidden = false; return; }
    location.href = j.url || j.redirect_uri || next || "/";
  } catch { e.textContent = "Could not connect. Please try again."; e.hidden = false; }
  finally { submit.disabled = false; }
};
</script>`,
  );

export const consentPage = () =>
  shell(
    "Authorize",
    `<h1>Authorize client</h1><p class="intro">Review this connection before allowing access.</p>
<div class="details"><p>Client: <strong id="c"></strong></p><p>Requested access: <code id="s"></code></p></div>
<div class="actions"><button id="y">Allow</button><button class="secondary" id="n">Deny</button></div><p class="error" id="e" role="alert" hidden></p>
<script>
const q = new URLSearchParams(location.search), c = document.getElementById("c"), s = document.getElementById("s"), e = document.getElementById("e");
c.textContent = q.get("client_id") || "Unknown client"; s.textContent = q.get("scope") || "Not specified";
const send = async (accept) => {
  e.hidden = true;
  try {
    const r = await fetch("/api/auth/oauth2/consent", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include",
      body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }) });
    const j = await r.json().catch(() => ({}));
    if (j.url || j.redirect_uri) location.href = j.url || j.redirect_uri;
    else { e.textContent = j.message || j.error || "Authorization failed. Please try again."; e.hidden = false; }
  } catch { e.textContent = "Could not connect. Please try again."; e.hidden = false; }
};
document.getElementById("y").onclick = () => send(true); document.getElementById("n").onclick = () => send(false);
</script>`,
  );

export const acceptInvitePage = (token: string) =>
  shell(
    "Accept invite",
    `<h1>Join organization</h1><p class="intro">Sign in with the invited email to accept.</p>
<form id="f"><label>Email<input name="email" type="email" autocomplete="username" required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in and accept</button></form><p class="error" id="e" role="alert" hidden></p><p class="status" id="m" role="status" hidden></p>
<script>
const token = ${JSON.stringify(token).replace(/</g, "\\u003c")};
const f = document.getElementById("f"), e = document.getElementById("e"), m = document.getElementById("m"), submit = f.querySelector("button");
f.onsubmit = async (ev) => {
  ev.preventDefault(); e.hidden = true; m.hidden = true; submit.disabled = true;
  try {
    const d = Object.fromEntries(new FormData(f));
    const s = await fetch("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify(d) });
    if (!s.ok) { const j = await s.json().catch(() => ({})); e.textContent = j.message || j.error || "Sign in failed. Check your email and password."; e.hidden = false; return; }
    const r = await fetch("/invites/accept", { method: "POST", headers: { "content-type": "application/json" }, credentials: "include", body: JSON.stringify({ token }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { e.textContent = j.message || j.error || "Could not accept the invitation."; e.hidden = false; return; }
    m.textContent = "Invitation accepted. Opening Honk…"; m.hidden = false;
    location.href = "/dashboard";
  } catch { e.textContent = "Could not connect. Please try again."; e.hidden = false; }
  finally { submit.disabled = false; }
};
</script>`,
  );
