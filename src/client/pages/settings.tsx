import { ArrowUpRight, Check, Copy, KeyRound, LogOut, UserRound, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "@/client/App";
import { api, changeAccountPassword, getSession, signOut, updateAccountName, updateOrganizationName } from "@/client/lib/api";
import { PageHeader } from "@/client/components/page-header";
import { RecordFormDialog } from "@/client/components/record-form-dialog";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card";
import { Select } from "@/client/components/ui/select";
import { Skeleton } from "@/client/components/ui/skeleton";

type Org = { org_id: string; name: string; slug: string; role: string; active: boolean };
type Member = { member_id: string; user_id: string; email: string; name: string; role: string; joined_at: string };
type Invite = { id: string; email: string; role: string; status: string; expires_at: string; accept_url?: string };
type ApiKey = { id: string; name: string; role: string; start: string; enabled: boolean; expires_at?: string | null; last_used_at?: string | null };
type Usage = { seats_used: number; seat_limit: number | null; api_key_count: number; contact_count: number };
type Account = { id: string; name: string; email: string };

const accessRoles = [{ value: "viewer", label: "Viewer · read only" }, { value: "member", label: "Member · CRM access" }, { value: "admin", label: "Admin · manage workspace" }];

export function SettingsPage() {
  const { me, canWrite } = useApp();
  const canManage = canWrite && (me.role === "admin" || me.role === "owner");
  const [account, setAccount] = useState<Account | null>(null);
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [secret, setSecret] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((n) => n + 1);

  useEffect(() => {
    let alive = true;
    const calls = [getSession(), api<{ orgs: Org[] }>("list_my_orgs"), api<{ members: Member[] }>("list_members"), api<Usage>("get_org_usage")];
    Promise.all(calls).then(([session, orgResult, memberResult, usageResult]) => {
      if (!alive) return;
      setAccount((session as { user: Account } | null)?.user ?? null);
      setOrgs((orgResult as { orgs: Org[] }).orgs);
      setMembers((memberResult as { members: Member[] }).members);
      setUsage(usageResult as Usage);
    }).catch((cause: Error) => { if (alive) setError(cause.message); });
    if (canManage) Promise.all([api<{ invites: Invite[] }>("list_invites"), api<{ api_keys: ApiKey[] }>("list_api_keys")])
      .then(([inviteResult, keyResult]) => { if (alive) { setInvites(inviteResult.invites); setKeys(keyResult.api_keys); } })
      .catch((cause: Error) => { if (alive) setError(cause.message); });
    return () => { alive = false; };
  }, [revision, canManage]);

  const currentOrg = orgs?.find((org) => org.org_id === me.orgId);
  const mcpUrl = `${window.location.origin}/mcp`;
  const multipleOrgs = (orgs?.length ?? 0) > 1;
  const oauthConfig = JSON.stringify({ mcpServers: { honk: { type: "http", url: mcpUrl, ...(multipleOrgs ? { headers: { "x-org-id": me.orgId } } : {}) } } }, null, 2);
  const keyConfig = JSON.stringify({ mcpServers: { honk: { type: "http", url: mcpUrl, headers: { Authorization: "Bearer <YOUR_API_KEY>" } } } }, null, 2);
  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setNotice(`${label} copied`); }
    catch { setNotice(`Select and copy the ${label.toLowerCase()} manually.`); }
  };
  const act = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); setNotice(success); refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save changes."); }
    finally { setBusy(false); }
  };

  return <>
    <PageHeader title="Settings" description="Your account, organization, and agent access." />
    {error ? <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
    {notice ? <p role="status" className="mb-4 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">{notice}</p> : null}

    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><UserRound className="size-4 text-primary" /> Your account</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {account ? <div className="space-y-2 text-sm">
            <p><span className="text-muted-foreground">Name</span><br /><span className="font-medium">{account.name}</span></p>
            <p><span className="text-muted-foreground">Email</span><br /><span className="font-medium">{account.email}</span></p>
            <p><span className="text-muted-foreground">Role in this organization</span><br /><Badge variant="outline" className="mt-1">{me.role}</Badge></p>
          </div> : <Skeleton className="h-24 w-full" />}
          <div className="flex flex-wrap gap-2">
            {account ? <RecordFormDialog trigger={<Button size="sm" variant="outline">Edit name</Button>} title="Edit your name"
              fields={[{ name: "name", label: "Name", value: account.name, required: true, full: true }]}
              onSave={(v) => updateAccountName((v.name ?? "").trim())} onSaved={() => { refresh(); window.location.reload(); }} /> : null}
            <RecordFormDialog trigger={<Button size="sm" variant="outline">Change password</Button>} title="Change password"
              fields={[{ name: "currentPassword", label: "Current password", type: "password", required: true, full: true }, { name: "newPassword", label: "New password", type: "password", required: true, full: true }, { name: "confirmPassword", label: "Confirm new password", type: "password", required: true, full: true }]}
              onSave={(v) => { if (v.newPassword !== v.confirmPassword) throw new Error("New passwords do not match."); return changeAccountPassword(v.currentPassword ?? "", v.newPassword ?? ""); }}
              onSaved={() => setNotice("Password changed")} submitLabel="Change password" />
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act(signOut, "Signed out")}><LogOut className="size-4" /> Sign out</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Users className="size-4 text-primary" /> Organization</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          {currentOrg ? <>
            <div><p className="font-medium">{currentOrg.name}</p><p className="text-xs text-muted-foreground">{currentOrg.slug}</p></div>
            {orgs && orgs.length > 1 ? <label className="block font-medium">Switch organization
              <div className="mt-1.5"><Select value={me.orgId} disabled={busy} onChange={(event) => act(() => api("switch_org", { org_id: event.target.value }).then(() => window.location.reload()), "Organization switched")}>
                {orgs.map((org) => <option key={org.org_id} value={org.org_id}>{org.name}</option>)}
              </Select></div>
            </label> : null}
            <p className="text-muted-foreground">{usage?.seats_used ?? "—"}{usage?.seat_limit != null ? ` / ${usage.seat_limit}` : ""} people · {usage?.contact_count ?? "—"} contacts</p>
            <div className="flex flex-wrap gap-2">
              {canManage ? <RecordFormDialog trigger={<Button size="sm" variant="outline">Edit organization name</Button>} title="Organization name"
                fields={[{ name: "name", label: "Name", value: currentOrg.name, required: true, full: true }]}
                onSave={(v) => updateOrganizationName(currentOrg.org_id, (v.name ?? "").trim())} onSaved={refresh} /> : null}
              {me.role === "owner" ? <RecordFormDialog trigger={<Button size="sm" variant="outline">Seat limit</Button>} title="Set seat limit"
                description="Leave blank for no limit. A lower limit does not remove existing people."
                fields={[{ name: "seat_limit", label: "Maximum people", type: "number", min: 1, value: usage?.seat_limit, full: true }]}
                onSave={(v) => api("set_seat_limit", { seat_limit: v.seat_limit ? Number(v.seat_limit) : null })} onSaved={refresh} /> : null}
              <Button asChild size="sm" variant="outline"><Link to="/workspace">Campaigns and channel rules <ArrowUpRight className="size-3.5" /></Link></Button>
            </div>
          </> : <Skeleton className="h-24 w-full" />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3"><CardTitle className="flex items-center gap-2 text-base"><Users className="size-4 text-primary" /> People</CardTitle>
          {canManage ? <RecordFormDialog trigger={<Button size="sm">Invite person</Button>} title="Invite a person" description="Honk creates an invite link for you to share. It does not send an email."
            fields={[{ name: "email", label: "Email", type: "email", required: true, full: true }, { name: "role", label: "Role", type: "select", value: "member", options: accessRoles, full: true }]}
            onSave={(v) => api<{ accept_url: string }>("invite_member", { email: (v.email ?? "").trim(), role: v.role })}
            onSaved={(result) => { setInviteUrl((result as { accept_url: string }).accept_url); refresh(); }} submitLabel="Create invite" /> : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {inviteUrl ? <SecretBox label="Invite link" value={inviteUrl} onCopy={() => copy(inviteUrl, "Invite link")} onDismiss={() => setInviteUrl("")} description="Copy this link and send it to the invited person." /> : null}
          {members ? <ul className="divide-y text-sm">{members.map((member) => <li key={member.member_id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
            <div className="min-w-0"><p className="truncate font-medium">{member.name}</p><p className="truncate text-xs text-muted-foreground">{member.email}</p></div><Badge variant="outline">{member.role}</Badge>
          </li>)}</ul> : <Skeleton className="h-24 w-full" />}
          {canManage && invites.length ? <div className="border-t pt-3"><p className="mb-2 text-xs font-medium text-muted-foreground">Pending invitations</p>
            <ul className="space-y-2">{invites.map((invite) => <li key={invite.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">{invite.email} <span className="text-muted-foreground">· {invite.role}</span></span>
              <div className="flex gap-1">{invite.accept_url ? <Button size="sm" variant="ghost" onClick={() => copy(invite.accept_url!, "Invite link")}><Copy className="size-3.5" /> Copy link</Button> : null}
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => api("revoke_invite", { invite_id: invite.id }), "Invitation revoked")}>Revoke</Button></div>
            </li>)}</ul>
          </div> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4 text-primary" /> Connect an agent</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div><p className="font-medium">Recommended: connect with your account</p><ol className="mt-1 list-decimal space-y-1 pl-5 text-muted-foreground"><li>In your agent's MCP settings, add a remote HTTP server using this URL.</li><li>Connect, then complete the Honk sign-in and consent in your browser.</li></ol></div>
          <CopyValue value={mcpUrl} label="MCP server URL" onCopy={() => copy(mcpUrl, "MCP URL")} />
          <CopyValue value={oauthConfig} label="MCP config example" onCopy={() => copy(oauthConfig, "MCP config")} />
          <p className="text-xs text-muted-foreground">For Claude Code: <code className="select-all break-all">claude mcp add --transport http honk {mcpUrl}{multipleOrgs ? ` --header "x-org-id: ${me.orgId}"` : ""}</code></p>
          {multipleOrgs ? <p className="text-xs text-muted-foreground">You belong to multiple organizations. The example includes this organization's ID in an <code>x-org-id</code> header so the agent uses the right workspace.</p> : null}
          <div className="border-t pt-4"><p className="font-medium">Headless agent: use an API key</p><p className="mt-1 text-muted-foreground">An admin can create a key below. Replace the placeholder in this example with the key, then store it in your agent's secret store.</p></div>
          <CopyValue value={keyConfig} label="API key config example" onCopy={() => copy(keyConfig, "API key config")} />
          <p className="text-xs text-muted-foreground">MCP uses Streamable HTTP. Agents can read and update CRM records within the access granted to their account or key.</p>
        </CardContent>
      </Card>

      {canManage ? <Card className="xl:col-span-2">
        <CardHeader className="flex-row items-center justify-between gap-3"><CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4 text-primary" /> Agent API keys</CardTitle>
          <RecordFormDialog trigger={<Button size="sm">Create key</Button>} title="Create agent key" description="The secret is shown once. Give each agent its own key."
            fields={[{ name: "name", label: "Key name", required: true, full: true, placeholder: "Research agent" }, { name: "role", label: "Access", type: "select", value: "member", options: accessRoles, full: true }]}
            onSave={(v) => api<{ secret: string }>("create_api_key", { name: (v.name ?? "").trim(), role: v.role })}
            onSaved={(result) => { setSecret((result as { secret: string }).secret); refresh(); }} submitLabel="Create key" />
        </CardHeader>
        <CardContent className="space-y-4">
          {secret ? <SecretBox label="New API key" value={secret} onCopy={() => copy(secret, "API key")} onDismiss={() => setSecret("")} description="Copy it now. Honk will not show it again." /> : null}
          {keys.length ? <ul className="divide-y">{keys.map((key) => <li key={key.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
            <div><p className="text-sm font-medium">{key.name} <Badge variant="outline" className="ml-1">{key.role}</Badge></p><p className="mt-0.5 text-xs text-muted-foreground">{key.start}… · {key.enabled ? "Active" : "Disabled"}</p></div>
            <RecordFormDialog trigger={<Button size="sm" variant="ghost">Revoke</Button>} title={`Revoke ${key.name}?`}
              description="This agent will lose access immediately."
              fields={[{ name: "confirm", label: "Type REVOKE to confirm", required: true, full: true }]}
              onSave={(v) => { if (v.confirm !== "REVOKE") throw new Error("Type REVOKE to confirm."); return api("revoke_api_key", { key_id: key.id }); }}
              onSaved={() => { if (secret) setSecret(""); refresh(); }} submitLabel="Revoke key" />
          </li>)}</ul> : <p className="text-sm text-muted-foreground">No agent API keys yet.</p>}
        </CardContent>
      </Card> : null}
    </div>
  </>;
}

function CopyValue({ value, label, onCopy }: { value: string; label: string; onCopy: () => void }) {
  return <div><p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p><div className="flex min-w-0 items-start gap-2 rounded-lg border bg-muted/40 p-2">
    <pre className="min-w-0 flex-1 select-all overflow-x-auto whitespace-pre px-1 text-xs"><code>{value}</code></pre>
    <Button size="sm" variant="outline" onClick={onCopy} aria-label={`Copy ${label}`}><Copy className="size-3.5" /> Copy</Button>
  </div></div>;
}

function SecretBox({ label, value, description, onCopy, onDismiss }: { label: string; value: string; description: string; onCopy: () => void; onDismiss: () => void }) {
  return <div className="rounded-lg border border-primary/30 bg-primary/5 p-3"><div className="mb-2 flex items-center justify-between gap-2"><p className="flex items-center gap-1.5 text-sm font-medium"><Check className="size-4 text-primary" /> {label} ready</p><Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button></div>
    <CopyValue value={value} label={label} onCopy={onCopy} /><p className="mt-2 text-xs text-muted-foreground">{description}</p>
  </div>;
}
