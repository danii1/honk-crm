import { ArrowRight, CalendarClock, CircleX, Clock, FileText, Flame, MailCheck, MessageSquare, Target, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getOverview, setGoals, type Overview } from "@/client/lib/api";
import { LEAD_STAGES, STAGES, stageCount } from "@/client/lib/constants";
import { contactHrefById, stageHref } from "@/client/lib/links";
import { formatDate, formatDay, pct, titleCase, TZ } from "@/client/lib/utils";
import { useApp } from "@/client/App";
import { EmptyState } from "@/client/components/empty-state";
import { PageHeader } from "@/client/components/page-header";
import { SectionCard } from "@/client/components/section-card";
import { StageBadge } from "@/client/components/stage-badge";
import { StatCard } from "@/client/components/stat-card";
import { Badge } from "@/client/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/client/components/ui/card";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Select } from "@/client/components/ui/select";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/client/components/ui/table";

export function OverviewPage() {
  const { pipeline, me } = useApp();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    getOverview(TZ).then(setData).catch((e: Error) => setError(e.message));
  }, [revision]);

  if (error) return <EmptyState title="Could not load today's overview" description={error} icon={CircleX} />;
  if (!data) return <OverviewSkeleton />;

  const g = data.goal;
  const dueCount = data.followups_due.length + data.tasks_due.length;
  const maxStage = Math.max(1, ...Object.values(data.stages));
  // Stage-derived like pipeline_summary/list_contacts_view, so both "Leads" figures use one population.
  const stageLeads = stageCount(data.stages, LEAD_STAGES);
  const stageTotal = stageCount(data.stages);

  return (
    <>
      <PageHeader
        title="Today"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <CalendarClock className="size-3.5" />
            {data.date} · times in {data.tz}
            {g?.days_left !== null && g?.days_left !== undefined ? <Badge variant="outline">{g.days_left >= 0 ? `${g.days_left} days left` : `${-g.days_left} days past deadline`}</Badge> : null}
          </span>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Follow-ups due" value={dueCount} hint={`${data.followups_due.length} channel reminders · ${data.tasks_due.length} tasks`} icon={Clock} tone={data.followups_due.some((f) => f.overdue) ? "bad" : "warn"} />
        <StatCard label="New replies · 24h" value={data.new_replies.length} hint={`${data.events_last_24h.length} events in total`} icon={MessageSquare} tone={data.new_replies.length ? "good" : "default"} />
        <StatCard label="Drafts pending" value={data.drafts_pending.length} hint="Approved and drafted messages" icon={FileText} />
        <StatCard label="Leads in pipeline" value={stageCount(data.stages, LEAD_STAGES)} hint="People still prospecting" icon={Users} />
      </div>

      <div className={`mt-3 grid gap-3 ${g || me.role === "admin" || me.role === "owner" ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}>
        {(g || me.role === "admin" || me.role === "owner") ? <GoalsCard goal={g} canManage={me.role === "admin" || me.role === "owner"} onSaved={() => setRevision((n) => n + 1)} /> : null}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Flame className="size-3.5" /> Outreach totals
            </CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            <MiniStat label="Leads" value={stageLeads} />
            <MiniStat label="Contacted" value={data.totals.contacted} />
            <MiniStat label="Responded" value={data.totals.responded} hint={pct(data.totals.response_rate_pct)} />
            <MiniStat label="Pilots / paying" value={`${data.totals.pilots} / ${data.totals.paying}`} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <Users className="size-3.5" /> Pipeline split
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <SplitRow label="Leads" value={pipeline?.lifecycles.lead ?? 0} total={pipeline?.lifecycles.total ?? 0} className="bg-chart-1" />
            <SplitRow label="Contacts" value={pipeline?.lifecycles.contact ?? 0} total={pipeline?.lifecycles.total ?? 0} className="bg-chart-2" />
            <SplitRow label="Lost / DNC" value={pipeline?.lifecycles.archived ?? 0} total={pipeline?.lifecycles.total ?? 0} className="bg-muted-foreground/50" />
            <Link to="/pipeline" className="inline-flex items-center gap-1 pt-1 text-xs font-medium text-primary hover:underline">
              Open pipeline <ArrowRight className="size-3" />
            </Link>
          </CardContent>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <SectionCard title="Follow-ups due" count={data.followups_due.length} icon={Clock}>
          {data.followups_due.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Next step</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.followups_due.map((f) => (
                  <TableRow key={`${f.contact_id}:${f.channel}`}>
                    <TableCell>
                      <Link className="font-medium hover:text-primary hover:underline" to={contactHrefById(f.contact_id, f.lifecycle)}>
                        {f.name ?? f.contact_id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{titleCase(f.channel)}</TableCell>
                    <TableCell><StageBadge stage={f.stage} /></TableCell>
                    <TableCell className={f.overdue ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>{formatDay(f.next_followup_at)}</TableCell>
                    <TableCell className="max-w-52 truncate text-xs text-muted-foreground">{f.next_step ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="No follow-ups due" description="Channel reminders and tasks will appear here on their due date." className="m-4" />
          )}
        </SectionCard>

        <SectionCard title="New replies · last 24h" count={data.new_replies.length} icon={MessageSquare}>
          {data.new_replies.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Summary</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.new_replies.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <Link className="font-medium hover:text-primary hover:underline" to={contactHrefById(e.contactId, e.lifecycle)}>
                        {e.name ?? e.contactId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{titleCase(e.channel)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(e.occurredAt)}</TableCell>
                    <TableCell className="max-w-64 truncate text-xs text-muted-foreground">{e.summary ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="No new replies" description="Inbound replies recorded by the automation will show up here." className="m-4" />
          )}
        </SectionCard>

        {data.linkedin_awaiting_first_message.length > 0 ? <SectionCard title="LinkedIn · connected, awaiting first message" count={data.linkedin_awaiting_first_message.length} icon={MailCheck}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Next step</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.linkedin_awaiting_first_message.map((x) => (
                  <TableRow key={x.contact_id}>
                    <TableCell>
                      <Link className="font-medium hover:text-primary hover:underline" to={contactHrefById(x.contact_id, x.lifecycle)}>
                        {x.name ?? x.contact_id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell><StageBadge stage={x.stage} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{x.next_step ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
        </SectionCard> : null}

        <SectionCard title="Drafts pending" count={data.drafts_pending.length} icon={FileText}>
          {data.drafts_pending.length ? (
            <div className="divide-y">
              {data.drafts_pending.map((d) => (
                <div key={d.id} className="flex gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link className="text-sm font-medium hover:text-primary hover:underline" to={contactHrefById(d.contact_id, d.lifecycle)}>
                        {d.name ?? d.contact_id.slice(0, 8)}
                      </Link>
                      <Badge variant="outline">{titleCase(d.channel)}</Badge>
                      <Badge variant={d.state === "approved" ? "success" : "warning"}>{titleCase(d.state)}</Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{d.text}</p>
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{formatDate(d.created_at)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No pending drafts" description="Drafts created by the agent will queue here for review." className="m-4" />
          )}
        </SectionCard>

        <SectionCard title="Stale · no response" count={data.stale.length} icon={CircleX}>
          {data.stale.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Idle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.stale.map((x) => (
                  <TableRow key={`${x.contact_id}:${x.channel}`}>
                    <TableCell>
                      <Link className="font-medium hover:text-primary hover:underline" to={contactHrefById(x.contact_id, x.lifecycle)}>
                        {x.name ?? x.contact_id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{titleCase(x.channel)}</TableCell>
                    <TableCell><StageBadge stage={x.stage} /></TableCell>
                    <TableCell className="text-xs text-muted-foreground">{x.days_since}d (≥{x.threshold_days})</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="No stale contacts" description="Contacts past the per-channel stale threshold appear here." className="m-4" />
          )}
        </SectionCard>

        <SectionCard title="Stages" count={stageTotal} icon={Users}>
          <div className="space-y-2 p-4">
            {Object.entries(data.stages)
              .filter(([, n]) => n > 0)
              .toSorted((a, b) => b[1] - a[1])
              .map(([stage, n]) => (
                <div key={stage} className="flex items-center gap-3">
                  <Link className="w-36 shrink-0 truncate text-xs font-medium hover:text-primary hover:underline" to={stageHref(stage)}>
                    {titleCase(stage)}
                  </Link>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-chart-1" style={{ width: `${(n / maxStage) * 100}%` }} />
                  </div>
                  <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{n}</span>
                </div>
              ))}
            {!Object.values(data.stages).some((n) => n > 0) ? <p className="text-xs text-muted-foreground">No contacts yet.</p> : null}
          </div>
        </SectionCard>
      </div>
    </>
  );
}

type GoalDraft = { stage: string; count: number };

function GoalsCard({ goal, canManage, onSaved }: { goal: Overview["goal"]; canManage: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [targets, setTargets] = useState<GoalDraft[]>([]);
  const [deadline, setDeadline] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startEditing = () => {
    setTargets(goal?.targets.map((t) => ({ stage: t.stage, count: t.target })) ?? []);
    setDeadline(goal?.deadline ?? "");
    setError(null);
    setEditing(true);
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await setGoals({ targets, ...(targets.length && deadline && { deadline }) });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const available = STAGES.filter((stage) => stage !== "lost" && stage !== "do_not_contact" && !targets.some((t) => t.stage === stage));
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Target className="size-3.5" /> Goals</CardTitle>
        {canManage && !editing ? <Button size="sm" variant="ghost" onClick={startEditing}>{goal ? "Edit goals" : "Set goals"}</Button> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {editing ? (
          <div className="space-y-3">
            {targets.map((target, index) => (
              <div key={target.stage} className="flex flex-wrap items-center gap-2">
                <Select aria-label={`Goal ${index + 1} stage`} value={target.stage} onChange={(e) => setTargets((items) => items.map((item, i) => i === index ? { ...item, stage: e.target.value } : item))} className="min-w-36 flex-1">
                  <option value={target.stage}>{titleCase(target.stage)}</option>
                  {available.map((stage) => <option key={stage} value={stage}>{titleCase(stage)}</option>)}
                </Select>
                <Input aria-label={`Goal ${index + 1} target count`} type="number" min="1" max="1000000" value={target.count} onChange={(e) => setTargets((items) => items.map((item, i) => i === index ? { ...item, count: Number(e.target.value) } : item))} className="w-24" />
                <Button size="sm" variant="ghost" onClick={() => setTargets((items) => items.filter((_, i) => i !== index))} aria-label={`Remove ${titleCase(target.stage)} goal`}>Remove</Button>
              </div>
            ))}
            {available.length ? <Button size="sm" variant="outline" onClick={() => setTargets((items) => [...items, { stage: available[0]!, count: 1 }])}>Add target</Button> : null}
            <label className="block text-xs font-medium">Deadline (optional)<Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className="mt-1" /></label>
            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
            <div className="flex gap-2"><Button size="sm" onClick={save} disabled={saving || targets.some((t) => !Number.isInteger(t.count) || t.count < 1)}>{saving ? "Saving…" : "Save goals"}</Button><Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button></div>
          </div>
        ) : goal ? (
          <>
            {goal.targets.map((target) => <GoalRow key={target.stage} label={titleCase(target.stage)} value={target.current} goal={target.target} progressPct={target.progress_pct} />)}
            {goal.deadline ? <p className="text-[11px] text-muted-foreground">Deadline: {goal.deadline}</p> : null}
          </>
        ) : <p className="text-xs text-muted-foreground">Set a target for any pipeline stage to track progress here.</p>}
      </CardContent>
    </Card>
  );
}

function GoalRow({ label, value, goal, progressPct }: { label: string; value: number; goal: number; progressPct: number | null }) {
  const progress = progressPct ?? Math.min(100, (value / goal) * 100);
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted-foreground">{value} / {goal}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
      </div>
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {hint ? <p className="text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function SplitRow({ label, value, total, className }: { label: string; value: number; total: number; className: string }) {
  const pctValue = total ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${className}`} style={{ width: `${pctValue}%` }} />
      </div>
      <span className="w-8 text-right text-xs tabular-nums">{value}</span>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <div className="mb-5 space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
      </div>
      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-64 rounded-xl" />)}
      </div>
    </>
  );
}
