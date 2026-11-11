import { Megaphone, Pencil, Plus, Settings2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, listCampaigns, listChannels, type ChannelDef } from "@/client/lib/api";
import { useApp } from "@/client/App";
import { EmptyState } from "@/client/components/empty-state";
import { PageHeader } from "@/client/components/page-header";
import { RecordFormDialog, type FormField } from "@/client/components/record-form-dialog";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card";
import { Skeleton } from "@/client/components/ui/skeleton";

type Campaign = Awaited<ReturnType<typeof listCampaigns>>[number];

export function WorkspacePage() {
  const { me, canWrite } = useApp();
  const canManage = canWrite && (me.role === "admin" || me.role === "owner");
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [channels, setChannels] = useState<ChannelDef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    let alive = true;
    setError(null);
    Promise.all([listCampaigns(), listChannels()])
      .then(([campaignRows, result]) => { if (alive) { setCampaigns(campaignRows); setChannels(result.channels); } })
      .catch((cause: Error) => { if (alive) setError(cause.message); });
    return () => { alive = false; };
  }, [revision]);

  if (error) return <EmptyState title="Could not load workspace" description={error} icon={Settings2} action={<Button variant="outline" onClick={refresh}>Try again</Button>} />;

  return <>
    <PageHeader title="Workspace" description="Campaigns and channel rules shared by your team." />
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader className="flex-row items-center justify-between border-b">
          <CardTitle className="flex items-center gap-2 text-base"><Megaphone className="size-4 text-primary" /> Campaigns</CardTitle>
          {canManage ? <CampaignForm trigger={<Button size="sm"><Plus className="size-4" /> Add campaign</Button>} onSaved={refresh} /> : null}
        </CardHeader>
        <CardContent className="p-0">
          {!campaigns ? <LoadingRows /> : campaigns.length ? <ul className="divide-y">
            {campaigns.map((campaign) => <li key={campaign.id} className="flex items-start justify-between gap-3 p-4">
              <div className="min-w-0"><p className="font-medium">{campaign.name}</p><p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{campaign.offerText || "No offer details yet."}</p></div>
              <div className="flex shrink-0 items-center gap-2"><Badge variant={campaign.status === "active" ? "success" : "muted"}>{campaign.status}</Badge>
                {canManage ? <CampaignForm campaign={campaign} trigger={<Button variant="ghost" size="sm"><Pencil className="size-3.5" /> Edit</Button>} onSaved={refresh} /> : null}
              </div>
            </li>)}
          </ul> : <div className="p-4 text-sm text-muted-foreground">No campaigns yet. Group related outreach around an offer.</div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex-row items-center justify-between border-b">
          <CardTitle className="flex items-center gap-2 text-base"><Settings2 className="size-4 text-primary" /> Channels</CardTitle>
          {canManage ? <ChannelForm trigger={<Button size="sm"><Plus className="size-4" /> Add channel</Button>} onSaved={refresh} /> : null}
        </CardHeader>
        <CardContent className="p-0">
          {!channels ? <LoadingRows /> : <ul className="divide-y">
            {channels.map((channel) => <li key={channel.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0"><p className="font-medium">{channel.label} {channel.custom ? <Badge variant="outline" className="ml-1">Custom</Badge> : null}</p>
                <p className="mt-1 text-xs text-muted-foreground">Follow up after {channel.followup_days} days · Stale after {channel.stale_days} days</p>
              </div>
              {canManage ? <div className="flex shrink-0 gap-1">
                <ChannelRuleForm channel={channel} trigger={<Button variant="ghost" size="sm">Rules</Button>} onSaved={refresh} />
                {channel.custom ? <ChannelForm channel={channel} trigger={<Button variant="ghost" size="sm"><Pencil className="size-3.5" /> Edit</Button>} onSaved={refresh} /> : null}
              </div> : null}
            </li>)}
          </ul>}
        </CardContent>
      </Card>
    </div>
  </>;
}

function LoadingRows() { return <div className="space-y-3 p-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>; }

function CampaignForm({ campaign, trigger, onSaved }: { campaign?: Campaign; trigger: ReactNode; onSaved: () => void }) {
  const fields: FormField[] = [
    { name: "name", label: "Campaign name", value: campaign?.name, required: true, readOnly: !!campaign, full: true, help: campaign ? "The campaign name identifies this record." : undefined },
    { name: "offer_text", label: "Offer", type: "textarea", value: campaign?.offerText, full: true, placeholder: "What are we offering this group?" },
    { name: "status", label: "Status", type: "select", value: campaign?.status ?? "active", full: true, options: ["active", "paused", "archived"].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) },
  ];
  return <RecordFormDialog trigger={trigger} title={campaign ? "Edit campaign" : "Add campaign"} description="Keep the offer and status visible to everyone working this campaign."
    fields={fields} onSaved={onSaved} onSave={(v) => api("upsert_campaign", { name: (v.name ?? "").trim(), offer_text: v.offer_text ?? "", status: v.status })}
    submitLabel={campaign ? "Save changes" : "Add campaign"} />;
}

function ChannelForm({ channel, trigger, onSaved }: { channel?: ChannelDef; trigger: ReactNode; onSaved: () => void }) {
  const fields: FormField[] = [
    { name: "id", label: "Channel ID", value: channel?.id, required: true, readOnly: !!channel, placeholder: "mastodon", help: "Lowercase letters, numbers, and underscores." },
    { name: "label", label: "Display name", value: channel?.label, required: true, placeholder: "Mastodon" },
    { name: "prefix", label: "Import prefix", value: channel?.prefixes?.[0], placeholder: "masto" },
    { name: "url_pattern", label: "Profile URL pattern", value: channel?.url_pattern, placeholder: "https://example.social/@{handle}", full: true, help: "Use {handle} where the person's name belongs." },
    { name: "followup_days", label: "Default follow-up days", type: "number", min: 0, max: 365, value: channel?.followup_days },
    { name: "stale_days", label: "Default stale days", type: "number", min: 0, max: 365, value: channel?.stale_days },
  ];
  return <RecordFormDialog trigger={trigger} title={channel ? "Edit channel" : "Add channel"} description="Make another outreach channel available to your team."
    fields={fields} onSaved={onSaved} submitLabel={channel ? "Save changes" : "Add channel"}
    onSave={(v) => api("add_custom_channel", {
      id: (v.id ?? "").trim().toLowerCase(), label: (v.label ?? "").trim(),
      ...(v.prefix && { prefix: v.prefix.trim().toLowerCase() }), ...(v.url_pattern && { url_pattern: v.url_pattern.trim() }),
      ...(v.followup_days && { followup_days: Number(v.followup_days) }), ...(v.stale_days && { stale_days: Number(v.stale_days) }),
    })} />;
}

function ChannelRuleForm({ channel, trigger, onSaved }: { channel: ChannelDef; trigger: ReactNode; onSaved: () => void }) {
  return <RecordFormDialog trigger={trigger} title={`${channel.label} rules`} description="These delays apply to new follow-ups and stale-contact checks."
    fields={[
      { name: "followup_days", label: "Follow-up after days", type: "number", min: 0, max: 365, required: true, value: channel.followup_days },
      { name: "stale_days", label: "Stale after days", type: "number", min: 0, max: 365, required: true, value: channel.stale_days },
    ]}
    onSaved={onSaved} onSave={(v) => api("set_followup_rules", {
      followup_days: { [channel.id]: Number(v.followup_days) }, stale_days: { [channel.id]: Number(v.stale_days) },
    })} />;
}
