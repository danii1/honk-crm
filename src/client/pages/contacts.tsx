import { Columns3, RotateCcw, Search, SlidersHorizontal, Users, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { listCampaigns, listChannels, listContactsView, type ChannelDef, type Contact, type ContactListResponse, type Lifecycle } from "@/client/lib/api";
import { ARCHIVED_STAGES, CONTACT_STAGES, LEAD_STAGES } from "@/client/lib/constants";
import { contactHref } from "@/client/lib/links";
import { formatDay, titleCase } from "@/client/lib/utils";
import { EmptyState } from "@/client/components/empty-state";
import { PageHeader } from "@/client/components/page-header";
import { ProfileLinks } from "@/client/components/profile-links";
import { StageBadge } from "@/client/components/stage-badge";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Card } from "@/client/components/ui/card";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/client/components/ui/dropdown-menu";
import { Input } from "@/client/components/ui/input";
import { Select } from "@/client/components/ui/select";
import { Skeleton } from "@/client/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/client/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/client/components/ui/tabs";

type ColumnKey = "stage" | "source" | "channels" | "company" | "lastTouch" | "score";
const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "stage", label: "Stage" },
  { key: "source", label: "Source" },
  { key: "channels", label: "Channels" },
  { key: "company", label: "Company" },
  { key: "lastTouch", label: "Last touch" },
  { key: "score", label: "Score" },
];
const DEFAULT_COLUMNS: ColumnKey[] = ["stage", "source", "channels", "company", "lastTouch", "score"];

export function ContactsPage({ lifecycle }: { lifecycle: "lead" | "contact" }) {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<Lifecycle>(lifecycle);
  const [data, setData] = useState<ContactListResponse | null>(null);
  const [channels, setChannels] = useState<ChannelDef[]>([]);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [columns, setColumns] = useState<ColumnKey[]>(DEFAULT_COLUMNS);
  const [search, setSearch] = useState(params.get("query") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setView(lifecycle);
  }, [lifecycle]);

  useEffect(() => {
    listChannels().then((r) => setChannels(r.channels)).catch(() => undefined);
    listCampaigns().then(setCampaigns).catch(() => undefined);
  }, []);

  useEffect(() => {
    setSearch(params.get("query") ?? "");
    let alive = true;
    setLoading(true);
    listContactsView({
      lifecycle: view,
      stage: params.get("stage") || undefined,
      channel: params.get("channel") || undefined,
      source: params.get("source") || undefined,
      campaign_id: params.get("campaign") || undefined,
      query: params.get("query") || undefined,
      limit: 500,
    })
      .then((r) => alive && setData(r))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [params, view]);

  const stageOptions = useMemo(() => {
    if (view === "lead") return [...LEAD_STAGES];
    if (view === "contact") return [...CONTACT_STAGES];
    return [...ARCHIVED_STAGES];
  }, [view]);

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const reset = () => setParams(new URLSearchParams(), { replace: true });
  const hasFilters = ["stage", "channel", "source", "campaign", "query"].some((k) => params.get(k));
  const rows = data?.contacts ?? [];
  const total = data ? (view === "lead" ? data.counts.lead : view === "contact" ? data.counts.contact : data.counts.archived) : 0;
  const Icon = lifecycle === "lead" ? UserPlus : Users;
  const title = lifecycle === "lead" ? "Leads" : "Contacts";

  return (
    <>
      <PageHeader
        title={title}
        description={
          lifecycle === "lead"
            ? "People still in prospecting — from new to connected."
            : "People we have a relationship with — replied, booked, piloting or paying."
        }
        actions={
          <>
            <Badge variant="muted" className="h-8 px-2.5 text-xs">
              {total} {view === "archived" ? "archived" : lifecycle === "lead" ? "leads" : "contacts"}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Columns3 className="size-4" /> Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {COLUMNS.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.key}
                    checked={columns.includes(c.key)}
                    onCheckedChange={(checked) => setColumns((cur) => (checked ? [...cur, c.key] : cur.filter((x) => x !== c.key)))}
                  >
                    {c.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      {lifecycle === "contact" ? (
        <Tabs value={view} onValueChange={(v) => setView(v as Lifecycle)} className="mb-4">
          <TabsList>
            <TabsTrigger value="contact">Relationships <span className="text-[10px] text-muted-foreground">{data?.counts.contact ?? 0}</span></TabsTrigger>
            <TabsTrigger value="archived">Lost / DNC <span className="text-[10px] text-muted-foreground">{data?.counts.archived ?? 0}</span></TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}

      <Card className="mb-4 p-3">
        <form
          className="flex flex-col gap-2 xl:flex-row xl:items-center"
          onSubmit={(e) => {
            e.preventDefault();
            update("query", search.trim());
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, handle, company, email…" className="pl-9" aria-label="Search" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Select aria-label="Stage" value={params.get("stage") ?? ""} onChange={(e) => update("stage", e.target.value)}>
              <option value="">Any stage</option>
              {stageOptions.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
            </Select>
            <Select aria-label="Channel" value={params.get("channel") ?? ""} onChange={(e) => update("channel", e.target.value)}>
              <option value="">Any channel</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
            <Select aria-label="Source" value={params.get("source") ?? ""} onChange={(e) => update("source", e.target.value)}>
              <option value="">Any source</option>
              {channels.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              <option value="web">Web</option>
              <option value="prowlo">Prowlo</option>
              <option value="other">Other</option>
            </Select>
            <Select aria-label="Campaign" value={params.get("campaign") ?? ""} onChange={(e) => update("campaign", e.target.value)}>
              <option value="">Any campaign</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm"><SlidersHorizontal className="size-4" /> Filter</Button>
            {hasFilters ? <Button type="button" variant="ghost" size="sm" onClick={reset}><RotateCcw className="size-4" /> Reset</Button> : null}
          </div>
        </form>
      </Card>

      {error ? (
        <EmptyState title="Could not load contacts" description={error} icon={Users} />
      ) : loading ? (
        <TableSkeleton />
      ) : rows.length ? (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                {columns.includes("stage") ? <TableHead>Stage</TableHead> : null}
                {columns.includes("source") ? <TableHead>Source</TableHead> : null}
                {columns.includes("channels") ? <TableHead>Channels</TableHead> : null}
                {columns.includes("company") ? <TableHead>Company</TableHead> : null}
                {columns.includes("lastTouch") ? <TableHead>Last touch</TableHead> : null}
                {columns.includes("score") ? <TableHead className="text-right">Score</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="max-w-64">
                    <ContactName contact={c} />
                    {c.contactType === "competitor" ? <Badge variant="destructive" className="ml-2">Competitor</Badge> : null}
                  </TableCell>
                  {columns.includes("stage") ? <TableCell><StageBadge stage={c.stage} /></TableCell> : null}
                  {columns.includes("source") ? <TableCell className="text-xs text-muted-foreground">{c.source ? titleCase(c.source) : "—"}</TableCell> : null}
                  {columns.includes("channels") ? <TableCell><ProfileLinks identities={c.identities} limit={5} /></TableCell> : null}
                  {columns.includes("company") ? (
                    <TableCell className="max-w-48 truncate text-xs">
                      {c.company ? <span className="text-foreground">{c.company.name}</span> : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  ) : null}
                  {columns.includes("lastTouch") ? <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDay(c.lastTouchAt)}</TableCell> : null}
                  {columns.includes("score") ? <TableCell className="text-right text-xs tabular-nums">{c.score ?? "—"}</TableCell> : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <EmptyState
          title={hasFilters ? "No matches" : lifecycle === "lead" ? "No leads yet" : view === "archived" ? "Nothing archived" : "No contacts yet"}
          description={hasFilters ? "Try clearing a filter or searching for a different term." : "Contacts imported or created through the CRM and MCP tools will appear here."}
          icon={hasFilters ? Search : Icon}
          action={hasFilters ? <Button variant="outline" size="sm" onClick={reset}>Clear filters</Button> : undefined}
        />
      )}
    </>
  );
}

function ContactName({ contact }: { contact: Contact }) {
  return (
    <div className="min-w-0">
      <Link to={contactHref(contact)} className="block truncate font-medium hover:text-primary hover:underline">
        {contact.name || contact.email || contact.id.slice(0, 8)}
      </Link>
      <p className="truncate text-[11px] text-muted-foreground">{contact.role || contact.email || contact.identities?.find((i) => !i.private)?.value || "—"}</p>
    </div>
  );
}

function TableSkeleton() {
  return (
    <Card className="overflow-hidden p-0">
      <div className="space-y-2 p-3">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    </Card>
  );
}
