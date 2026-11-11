import { ArrowLeft, ArrowUpRight, CalendarDays, Check, CircleX, Clock, FileText, Mail, MessageSquare, Pencil, Send, Sparkles, Target, UserRound, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, getActivity, getContact, transitionDraft, updateStage, type Activity, type ContactDetail, type Draft, type Identity } from "@/client/lib/api";
import { STAGES } from "@/client/lib/constants";
import { formatDate, formatDay, localDateTimeInput, safeExternalUrl, titleCase } from "@/client/lib/utils";
import { useApp } from "@/client/App";
import { ChannelIcon } from "@/client/components/channel-icon";
import { ContactActions } from "@/client/components/contact-actions";
import { ContactFormDialog } from "@/client/components/contact-form-dialog";
import { EmptyState } from "@/client/components/empty-state";
import { PageHeader } from "@/client/components/page-header";
import { WebsiteLink } from "@/client/components/profile-links";
import { RecordFormDialog } from "@/client/components/record-form-dialog";
import { StageBadge } from "@/client/components/stage-badge";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card";
import { Select } from "@/client/components/ui/select";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/client/components/ui/table";

type TimelineItem = { id: string; at: string; kind: string; text: string; icon: "touch" | "event" | "draft" | "note" | "stage" };

export function ContactDetailPage() {
  const { id = "" } = useParams();
  const { canWrite, me, refreshPipeline } = useApp();
  const canSeePrivate = me.role === "admin" || me.role === "owner";
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => {
    Promise.all([getContact(id, canSeePrivate), getActivity(id)])
      .then(([c, a]) => {
        setContact(c);
        setActivity(a);
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(load, [id]);

  const timeline = useMemo<TimelineItem[]>(() => {
    if (!contact) return [];
    const items: TimelineItem[] = [
      ...contact.touches.map((t) => ({ id: `touch:${t.id}`, at: t.sentAt ?? t.createdAt ?? "", kind: `${titleCase(t.direction)} ${titleCase(t.channel)}`, text: t.body ?? t.subject ?? titleCase(t.status), icon: "touch" as const })),
      ...(contact.events ?? []).map((e) => ({ id: `event:${e.id}`, at: e.occurredAt, kind: `${titleCase(e.type)} · ${titleCase(e.channel)}`, text: e.summary ?? "", icon: "event" as const })),
      ...activity
        .filter((a) => a.action.endsWith("stage_changed"))
        .map((a) => {
          const p = (a.payload ?? {}) as { from?: string; to?: string; channel?: string };
          return { id: `stage:${a.id}`, at: a.createdAt, kind: "Stage changed", text: `${p.channel ? `${titleCase(p.channel)}: ` : ""}${titleCase(p.from)} → ${titleCase(p.to)}`, icon: "stage" as const };
        }),
      ...contact.drafts.map((d) => ({ id: `draft:${d.id}`, at: d.sentAt ?? d.createdAt ?? "", kind: `Draft ${titleCase(d.state)} · ${titleCase(d.channel)}`, text: d.text, icon: "draft" as const })),
      ...contact.notes.map((n) => ({ id: `note:${n.id}`, at: n.createdAt, kind: "Note", text: n.body, icon: "note" as const })),
    ];
    return items.filter((x) => x.at).toSorted((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }, [contact, activity]);

  const changeStage = async (stage: string) => {
    if (!contact || !canWrite) return;
    setBusy(true);
    setNotice(null);
    try {
      await updateStage(contact.id, stage);
      setNotice(`Moved to ${titleCase(stage)}`);
      load();
      refreshPipeline();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const draftAction = async (draft: Draft, to: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await transitionDraft(draft.id, to);
      setNotice(`Draft ${to}`);
      load();
      refreshPipeline();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <EmptyState title="Contact not found" description={error} icon={CircleX} action={<Button asChild variant="outline" size="sm"><Link to="/contacts">Back to contacts</Link></Button>} />;
  if (!contact) return <DetailSkeleton />;

  const isLead = contact.lifecycle === "lead";
  const backTo = isLead ? "/leads" : "/contacts";
  const displayName = contact.name || contact.email || contact.id.slice(0, 8);
  const contactWebsite = safeExternalUrl(contact.website) ?? contact.company?.website_url;

  return (
    <>
      <div className="mb-3">
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <Link to={backTo}><ArrowLeft className="size-4" /> Back to {isLead ? "leads" : "contacts"}</Link>
        </Button>
      </div>

      <PageHeader
        title={displayName}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StageBadge stage={contact.stage} />
            <Badge variant={isLead ? "outline" : "success"}>{titleCase(contact.lifecycle)}</Badge>
            {contact.company ? <span className="text-sm text-muted-foreground">at {contact.company.name}</span> : null}
          </span>
        }
        actions={
          canWrite ? (
            <div className="flex flex-wrap items-center gap-2">
              <ContactFormDialog contact={contact} trigger={<Button variant="outline" size="sm"><Pencil className="size-4" /> Edit profile</Button>} onSaved={() => { load(); refreshPipeline(); }} />
              <Select value={contact.stage} onChange={(e) => changeStage(e.target.value)} disabled={busy} className="w-44" aria-label="Change stage">
                {STAGES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
              </Select>
              {isLead ? (
                <Button size="sm" disabled={busy} onClick={() => changeStage("responded")}>
                  <Sparkles className="size-4" /> Convert to contact
                </Button>
              ) : null}
            </div>
          ) : (
            <Badge variant="muted">Read-only</Badge>
          )
        }
      />

      {notice ? <div className="mb-3 rounded-lg border bg-muted/40 px-3 py-2 text-xs">{notice}</div> : null}

      {canWrite ? <ContactActions contact={contact} onSaved={() => { load(); refreshPipeline(); }} /> : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between border-b py-3">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Clock className="size-3.5" /> Activity timeline</CardTitle>
              <span className="text-xs text-muted-foreground">{timeline.length} events</span>
            </CardHeader>
            <CardContent className="p-0">
              {timeline.length ? (
                <ol className="relative divide-y">
                  {timeline.map((item) => (
                    <li key={item.id} className="flex gap-3 px-4 py-3">
                      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground">
                        <TimelineIcon kind={item.icon} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-xs font-medium">{item.kind}</p>
                          <time className="text-[10px] text-muted-foreground" title={formatDate(item.at)}>{formatDate(item.at)}</time>
                        </div>
                        {item.text ? <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">{item.text}</p> : null}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <EmptyState title="No activity yet" description="Touches, replies, drafts, notes and stage changes will appear here." className="m-4" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between border-b py-3">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><MessageSquare className="size-3.5" /> Channel state</CardTitle>
              <span className="text-xs text-muted-foreground">{contact.channel_states.length} channels</span>
            </CardHeader>
            <CardContent className="p-0">
              {contact.channel_states.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Channel</TableHead>
                      <TableHead>Stage</TableHead>
                      <TableHead>Last touch</TableHead>
                      <TableHead>Follow-up</TableHead>
                        <TableHead>Next step</TableHead>
                        {canWrite ? <TableHead><span className="sr-only">Actions</span></TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {contact.channel_states.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="flex items-center gap-2 text-xs font-medium"><ChannelIcon channel={s.channel} />{titleCase(s.channel)}</TableCell>
                        <TableCell><StageBadge stage={s.stage} /></TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDay(s.lastTouchAt)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDay(s.nextFollowupAt)}</TableCell>
                        <TableCell className="max-w-52 truncate text-xs text-muted-foreground">{s.nextStep ?? "—"}</TableCell>
                        {canWrite ? <TableCell><RecordFormDialog
                          trigger={<Button variant="ghost" size="sm">Edit</Button>}
                          title={`Edit ${titleCase(s.channel)} follow-up`}
                          fields={[
                            { name: "stage", label: "Channel stage", type: "select", value: s.stage, options: STAGES.map((stage) => ({ value: stage, label: titleCase(stage) })) },
                            { name: "next_followup_at", label: "Follow up", type: "datetime-local", value: localDateTimeInput(s.nextFollowupAt) },
                            { name: "next_step", label: "Next step", value: s.nextStep, full: true },
                          ]}
                          onSave={(v) => api("set_channel_state", { contact_id: contact.id, channel: s.channel, stage: v.stage, next_followup_at: v.next_followup_at ? new Date(v.next_followup_at).toISOString() : null, next_step: v.next_step?.trim() || null })}
                          onSaved={() => { load(); refreshPipeline(); }}
                        /></TableCell> : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState title="No channel state" description="Log a touch or set a channel state to start the per-channel pipeline." className="m-4" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between border-b py-3">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><FileText className="size-3.5" /> Drafts</CardTitle>
              <span className="text-xs text-muted-foreground">{contact.drafts.length}</span>
            </CardHeader>
            <CardContent className="p-0">
              {contact.drafts.length ? (
                <div className="divide-y">
                  {contact.drafts.map((d) => {
                    const intentHref = safeExternalUrl(d.intentUrl);
                    return (
                      <div key={d.id} className="p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{titleCase(d.channel)}</Badge>
                          <DraftBadge state={d.state} />
                          <span className="text-[10px] text-muted-foreground">{formatDate(d.createdAt)}</span>
                          {intentHref ? (
                            <a href={intentHref} target="_blank" rel="noreferrer noopener" className="ml-auto inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                              Open intent <ArrowUpRight className="size-3" />
                            </a>
                          ) : null}
                        </div>
                        <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{d.text}</p>
                        {canWrite && (d.state === "drafted" || d.state === "approved") ? (
                          <div className="mt-2 flex flex-wrap gap-2">
                            {d.state === "drafted" ? <RecordFormDialog
                              trigger={<Button size="sm" variant="ghost"><Pencil className="size-3.5" /> Edit text</Button>}
                              title="Edit draft" fields={[{ name: "text", label: "Message", type: "textarea", value: d.text, required: true, full: true }]}
                              onSave={(v) => api("transition_draft", { draft_id: d.id, to: "drafted", text: (v.text ?? "").trim() })}
                              onSaved={load} submitLabel="Save draft" /> : null}
                            {d.state === "drafted" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => draftAction(d, "approved")}><Check className="size-3.5" /> Approve</Button> : null}
                            {d.state === "approved" ? <Button size="sm" disabled={busy} onClick={() => draftAction(d, "sent")}><Send className="size-3.5" /> Mark sent</Button> : null}
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => draftAction(d, "discarded")}><X className="size-3.5" /> Discard</Button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <EmptyState title="No drafts" description="Drafts for this contact will appear here with their state." className="m-4" />
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader className="border-b py-3">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><UserRound className="size-3.5" /> Properties</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              <Property label="Company" value={contact.company ? contact.company.name : null} />
              <Property label="Role" value={contact.role} />
              <Property label="Source" value={contact.source ? titleCase(contact.source) : null} />
              <Property label="Score" value={contact.score ? `${contact.score} / 5` : null} />
              <Property label="Followers" value={contact.followers?.toLocaleString() ?? null} />
              <Property label="Team size" value={contact.estTeamSize?.toLocaleString() ?? null} />
              <Property label="First seen" value={contact.firstSeenAt ? formatDay(contact.firstSeenAt) : null} />
              <Property label="Last touch" value={contact.lastTouchAt ? formatDate(contact.lastTouchAt) : null} />
              <div className="border-t pt-3">
                <p className="text-[11px] font-medium text-muted-foreground">Website</p>
                <WebsiteLink url={contactWebsite} label={safeExternalUrl(contact.website) ?? contact.company?.domain} className="mt-1 text-xs" />
                {!contactWebsite ? <p className="mt-1 text-xs text-muted-foreground">—</p> : null}
              </div>
              {contact.signalSummary ? (
                <div className="border-t pt-3">
                  <p className="text-[11px] font-medium text-muted-foreground">Signal</p>
                  <p className="mt-1 text-xs text-muted-foreground">{contact.signalSummary}</p>
                  {contact.signalPostUrl ? <WebsiteLink url={contact.signalPostUrl} label="View post" className="mt-1 text-xs" /> : null}
                </div>
              ) : null}
              {contact.notesText ? (
                <div className="border-t pt-3">
                  <p className="text-[11px] font-medium text-muted-foreground">Notes</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{contact.notesText}</p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b py-3">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Target className="size-3.5" /> Profiles</CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              {contact.identities?.length ? (
                <IdentityProfiles identities={contact.identities} />
              ) : (
                <p className="text-xs text-muted-foreground">No linked profiles.</p>
              )}
            </CardContent>
          </Card>

          {contact.tags.length ? (
            <Card>
              <CardHeader className="border-b py-3">
                <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Tags</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5 p-4">
                {contact.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="border-b py-3">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><CalendarDays className="size-3.5" /> Open tasks</CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              {contact.open_tasks.length ? (
                <ul className="space-y-2">
                  {contact.open_tasks.map((t) => (
                    <li key={t.id} className="rounded-lg border p-2">
                      <p className="text-xs font-medium">{t.title}</p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">Due {formatDay(t.dueAt)}</p>
                      {canWrite ? <Button size="sm" variant="ghost" className="mt-1" onClick={async () => { try { await api("complete_task", { id: t.id }); load(); } catch (cause) { setNotice((cause as Error).message); } }}><Check className="size-3.5" /> Complete</Button> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No open tasks.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b py-3">
              <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Pencil className="size-3.5" /> Quick facts</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 p-4 text-xs text-muted-foreground">
              <p className="flex justify-between gap-3"><span>Contact ID</span><span className="truncate font-mono text-[10px] text-foreground">{contact.id}</span></p>
              <p className="flex justify-between gap-3"><span>Created</span><span>{formatDay(contact.createdAt)}</span></p>
              <p className="flex justify-between gap-3"><span>Stage changed</span><span>{formatDay(contact.stageChangedAt)}</span></p>
              {contact.email ? <p className="flex justify-between gap-3"><span>Email</span><a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1 text-primary hover:underline"><Mail className="size-3" />{contact.email}</a></p> : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}

/** Profile rows for a contact; hrefs go through safeExternalUrl so legacy rows cannot smuggle a hostile scheme. */
export function IdentityProfiles({ identities }: { identities: Identity[] }) {
  return (
    <div className="space-y-2">
      {identities.map((i) => {
        const href = safeExternalUrl(i.url);
        return (
          <div key={`${i.kind}:${i.scope ?? ""}:${i.value}`} className="flex items-center gap-2 text-xs">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><ChannelIcon channel={i.channel} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{i.label}{i.private ? " · private" : ""}</p>
              {href ? (
                <a href={href} target={href.startsWith("mailto:") ? undefined : "_blank"} rel="noreferrer noopener" className="block truncate font-medium text-primary hover:underline">
                  {i.value}
                </a>
              ) : (
                <p className="truncate font-medium">{i.value}</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Property({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="max-w-[60%] break-words text-right text-xs font-medium">{value || "—"}</p>
    </div>
  );
}

function TimelineIcon({ kind }: { kind: TimelineItem["icon"] }) {
  if (kind === "touch") return <Send className="size-3.5" />;
  if (kind === "event") return <MessageSquare className="size-3.5" />;
  if (kind === "draft") return <FileText className="size-3.5" />;
  if (kind === "note") return <Pencil className="size-3.5" />;
  return <Target className="size-3.5" />;
}

function DraftBadge({ state }: { state: Draft["state"] }) {
  if (state === "sent") return <Badge variant="success">Sent</Badge>;
  if (state === "approved") return <Badge variant="default">Approved</Badge>;
  if (state === "discarded") return <Badge variant="muted">Discarded</Badge>;
  return <Badge variant="warning">Drafted</Badge>;
}

function DetailSkeleton() {
  return (
    <>
      <Skeleton className="mb-5 h-9 w-72" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-96 rounded-xl" />
          <Skeleton className="h-56 rounded-xl" />
        </div>
      </div>
    </>
  );
}
